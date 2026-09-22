/**
 * Portfolio — what the connected wallet actually owns on the current cluster.
 *
 * Everything here is read straight from the chain:
 *   - SOL balance: live from the RPC, plus a USD equivalent fetched live from
 *     CoinGecko (shown only when we actually got a price — never invented)
 *   - Liquidity positions: your DAMM v2 pools' CURRENT totals (SOL shown with
 *     its live dollar equivalent) and your unlocked/locked percentages
 *   - Token holdings: every token account the wallet owns, on BOTH the SPL
 *     Token and Token-2022 programs, showing decimals + raw amounts
 *   - Tokens created: the local registry of tokens created through this app
 *     (this device), each with a Manage button that hands the mint to the
 *     Liquidity tab. This is local data, so it shows even without a wallet.
 *
 * Rate-limit resilience (public devnet RPCs throttle per IP, and Render's
 * shared IPs get hammered): each read is cached for 15 seconds, retried with
 * backoff, and falls back to the last known data if the RPC fails. The two
 * reads are independent — a failure in one never blanks the other.
 *
 * If a number cannot be read, it is shown as unavailable — never guessed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { listCreatedTokens } from '../lib/registry.js'
import {
  makeSdk,
  readUserPositions,
  positionLiquidity,
  toUi,
  WSOL,
} from '../lib/liquidity.js'
import { solUsdPrice, formatUsd } from '../lib/price.js'
import {
  withRetries,
  describeError,
  isEndpointBlocked,
  positionsCacheFresh,
  positionsCacheStale,
  positionsCacheSet,
  getMintDecimals,
  decimalsOf,
  seedMintDecimals,
} from '../lib/rpcResilience.js'
import { Card, Button, Empty, Spinner, Sol, Address } from '../components/ui.jsx'

const TOKEN_PROGRAMS = [
  [TOKEN_PROGRAM_ID, 'SPL Token'],
  [TOKEN_2022_PROGRAM_ID, 'Token-2022'],
]

/* ------------------------------------------------- module-level caches */

const CACHE_TTL_MS = 15_000

// Last good holdings read per network:wallet. Refreshing within the TTL
// reuses it, which is what stops repeated refreshes from tripping the RPC
// rate limit. (The positions read shares its cache with the Pool holdings
// tab via rpcResilience.js.)
const holdingsCache = { key: null, data: null, at: 0 }

function cacheFresh(cache, key) {
  return cache.key === key && cache.data !== null && Date.now() - cache.at < CACHE_TTL_MS
    ? cache.data
    : null
}
function cacheStale(cache, key) {
  return cache.key === key && cache.data !== null ? cache.data : null
}
function cacheSet(cache, key, data) {
  cache.key = key
  cache.data = data
  cache.at = Date.now()
}

/* ------------------------------------------------------------------ page */

export default function Portfolio({ onManage, onPositions }) {
  const { connection, network, probeFallbacks } = useNetwork()
  const wallet = useWallet()
  const sdk = useMemo(() => makeSdk(connection), [connection])

  const [holdings, setHoldings] = useState(null)
  const [holdingsError, setHoldingsError] = useState(null)
  const [holdingsLoading, setHoldingsLoading] = useState(false)

  const [positions, setPositions] = useState(null)
  const [positionsError, setPositionsError] = useState(null)
  const [positionsLoading, setPositionsLoading] = useState(false)

  const [usd, setUsd] = useState(null)
  const [created] = useState(() => listCreatedTokens())

  // Mint (base58) → registry entry, so we can show a real symbol where we have one.
  const known = useMemo(() => {
    const map = new Map()
    for (const t of created) map.set(t.mint, t)
    return map
  }, [created])

  // Registry decimals are known locally — pre-seed the cache, zero RPC calls.
  useEffect(() => {
    for (const t of created) seedMintDecimals(t.mint, Number(t.decimals))
  }, [created])

  const cacheKey = wallet.isConnected ? `${network.id}:${wallet.address}` : null

  /* ------------------------------------------------------- token holdings */

  const loadHoldings = useCallback(
    async (force = false) => {
      if (!wallet.isConnected || !wallet.publicKey || !cacheKey) return
      setHoldingsLoading(true)
      setHoldingsError(null)
      try {
        if (!force) {
          const cached = cacheFresh(holdingsCache, cacheKey)
          if (cached) {
            setHoldings(cached)
            return
          }
        }
        const batches = await withRetries(() =>
          Promise.all(
            TOKEN_PROGRAMS.map(([programId]) =>
              connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, 'confirmed')
            )
          )
        )
        const rows = []
        batches.forEach((res, i) => {
          for (const { pubkey, account } of res.value) {
            const info = account?.data?.parsed?.info
            if (!info) continue
            const amount = BigInt(info.tokenAmount?.amount ?? '0')
            if (amount === 0n) continue
            rows.push({
              account: pubkey.toBase58(),
              mint: info.mint,
              decimals: info.tokenAmount.decimals,
              uiAmount: info.tokenAmount.uiAmountString ?? amount.toString(),
              amount,
              programLabel: TOKEN_PROGRAMS[i][1],
            })
          }
        })
        rows.sort((a, b) => (a.amount === b.amount ? 0 : a.amount < b.amount ? 1 : -1))
        cacheSet(holdingsCache, cacheKey, rows)
        setHoldings(rows)
        wallet.refreshBalance(connection, wallet.publicKey)
      } catch (err) {
        if (isEndpointBlocked(err)) probeFallbacks()
        const stale = cacheStale(holdingsCache, cacheKey)
        if (stale) {
          setHoldings(stale)
          setHoldingsError('Showing last known data — the RPC failed on refresh.')
        } else {
          setHoldingsError(describeError(err))
        }
      } finally {
        setHoldingsLoading(false)
      }
    },
    [connection, wallet, cacheKey, probeFallbacks]
  )

  /* ---------------------------------------------------- liquidity positions */

  const loadPositions = useCallback(
    async (force = false) => {
      if (!wallet.isConnected || !wallet.publicKey || !cacheKey) return
      setPositionsLoading(true)
      setPositionsError(null)
      try {
        if (!force) {
          const cached = positionsCacheFresh(cacheKey)
          if (cached) {
            setPositions(cached)
            return
          }
        }
        const list = await withRetries(() => readUserPositions(connection, sdk, wallet.publicKey))
        // Warm the decimals cache for the pool mints (usually already known).
        await Promise.all(
          list.flatMap((p) => [p.poolState.tokenAMint, p.poolState.tokenBMint]).map((m) =>
            getMintDecimals(connection, m).catch(() => {})
          )
        )
        positionsCacheSet(cacheKey, list)
        setPositions(list)
      } catch (err) {
        if (isEndpointBlocked(err)) probeFallbacks()
        const stale = positionsCacheStale(cacheKey)
        if (stale) {
          setPositions(stale)
          setPositionsError('Showing last known data — the RPC failed on refresh.')
        } else {
          setPositionsError(describeError(err))
        }
      } finally {
        setPositionsLoading(false)
      }
    },
    [connection, sdk, wallet, cacheKey, probeFallbacks]
  )

  // Load both sections when the wallet/network changes (cached = cheap).
  useEffect(() => {
    if (wallet.isConnected) {
      loadHoldings()
      loadPositions()
    } else {
      setHoldings(null)
      setPositions(null)
      setHoldingsError(null)
      setPositionsError(null)
    }
  }, [wallet.isConnected, loadHoldings, loadPositions])

  // Live SOL→USD price on mount (Refresh forces a re-fetch).
  useEffect(() => {
    let live = true
    solUsdPrice().then((p) => {
      if (live) setUsd(p)
    })
    return () => {
      live = false
    }
  }, [])

  const refresh = () => {
    loadHoldings(true)
    loadPositions(true)
    solUsdPrice({ force: true }).then(setUsd)
  }

  const nameForMint = (m) => {
    const s = m.toBase58()
    if (WSOL.equals(m)) return 'SOL'
    const t = known.get(s)
    return t ? t.symbol : `${s.slice(0, 4)}…${s.slice(-4)}`
  }

  // One side of a pool's "holds" line. Only the SOL side gets a dollar
  // equivalent (real CoinGecko price). Your token has no market price we can
  // honestly source, so it is shown in plain amount — never a guessed $.
  const poolSide = (mint, rawAmount, decimals) => {
    const amount = toUi(rawAmount, decimals)
    let usdTxt = null
    if (WSOL.equals(mint) && usd !== null) {
      try {
        const sol = Number(String(rawAmount).replace(/[^0-9-]/g, '') || '0') / 1e9
        usdTxt = ` (≈ ${formatUsd(sol * usd)})`
      } catch {
        usdTxt = null
      }
    }
    return (
      <strong>
        {amount} {nameForMint(mint)}
        {usdTxt && <span className="hold__usd">{usdTxt}</span>}
      </strong>
    )
  }

  /* ----------------------------------------------------------------- view */

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Portfolio</h1>
          <p className="page__sub">
            Read live from the cluster: real SOL balance, your pools with their current totals,
            your token accounts, and the tokens you created on this device.
          </p>
        </div>
        {wallet.isConnected && (
          <Button onClick={refresh} loading={holdingsLoading || positionsLoading}>
            Refresh
          </Button>
        )}
      </div>

      <div className="stats3">
        <div className="statcard">
          <span className="statcard__label">SOL balance (wallet)</span>
          <span className="statcard__value">
            {wallet.balance !== null ? <Sol lamports={wallet.balance} precision={4} /> : '—'}
          </span>
          {usd !== null && wallet.balance !== null && (
            <span className="statcard__usd">≈ {formatUsd((Number(wallet.balance) / 1e9) * usd)}</span>
          )}
          <span className="statcard__hint">
            {usd !== null && <span>price via CoinGecko · </span>}
            {wallet.isConnected ? network.label : 'connect to see'}
          </span>
        </div>
        <div className="statcard">
          <span className="statcard__label">Token holdings</span>
          <span className="statcard__value">{holdings === null ? '…' : holdings.length}</span>
          <span className="statcard__hint">distinct tokens in this wallet</span>
        </div>
        <div className="statcard">
          <span className="statcard__label">Tokens created</span>
          <span className="statcard__value">{created.length}</span>
          <span className="statcard__hint">through this app, on this device</span>
        </div>
      </div>

      {!wallet.isConnected && (
        <Card>
          <Empty title="Wallet Not Connected">
            <p>Connect your wallet to view your portfolio.</p>
          </Empty>
        </Card>
      )}

      <div className="page__grid">
        {wallet.isConnected && (
          <Card
            title="Liquidity positions"
            subtitle="Live totals for your DAMM v2 pools. “Pool holds” is the pool's current total — you own 100% of this pool, so a 100% withdrawal returns the whole pool at today's price (with other LPs it would pay your share)."
          >
            {positions === null && positionsLoading ? (
              <Spinner label="Reading liquidity positions…" />
            ) : positionsError && positions === null ? (
              <div className="sectionerr">
                <p>{positionsError}</p>
                <Button size="sm" onClick={() => loadPositions(true)}>
                  Retry
                </Button>
              </div>
            ) : positions && positions.length === 0 ? (
              <Empty title="No liquidity positions">
                <p>Pools you create in the Liquidity tab will appear here with their live totals.</p>
              </Empty>
            ) : (
              (positions ?? []).map((p) => {
                const dA = decimalsOf(p.poolState.tokenAMint)
                const dB = decimalsOf(p.poolState.tokenBMint)
                const liq = positionLiquidity(p.positionState)
                const total = Number(liq.total.toString()) || 1
                const pct = (bn) => `${Math.round((Number(bn.toString()) / total) * 100)}%`
                const nonZero = (v) => {
                  try {
                    return BigInt(String(v).replace(/[^0-9-]/g, '') || '0') !== 0n
                  } catch {
                    return false
                  }
                }
                const feesWaiting = nonZero(p.pendingFees.a) || nonZero(p.pendingFees.b)
                return (
                  <div className="hold" key={p.positionNftMint.toBase58()}>
                    <div className="hold__id">
                      <span className="hold__name">Pool {p.pool.toBase58().slice(0, 8)}…</span>
                      <span className="hold__tag">
                        {p.isPermanentlyLocked ? 'permanently locked' : 'active'}
                      </span>
                    </div>
                    <div className="hold__amt">
                      Pool holds{' '}
                      {poolSide(p.poolState.tokenAMint, p.poolState.tokenAAmount, dA)}{' '}
                      +{' '}
                      {poolSide(p.poolState.tokenBMint, p.poolState.tokenBAmount, dB)}
                    </div>
                    <div className="hold__amt">
                      Your position: <strong>{pct(liq.unlocked)} unlocked</strong> ·{' '}
                      {pct(liq.permanentlyLocked)} permanently locked
                      {feesWaiting && (
                        <>
                          {' '}
                          · fees waiting: {toUi(p.pendingFees.a, dA)}{' '}
                          {nameForMint(p.poolState.tokenAMint)} + {toUi(p.pendingFees.b, dB)}{' '}
                          {nameForMint(p.poolState.tokenBMint)}
                        </>
                      )}
                    </div>
                    {positionsError && (
                      <div className="footnote">{positionsError}</div>
                    )}
                    <div className="hold__foot">
                      <Address
                        value={p.position.toBase58()}
                        explorer={network.explorerAddress}
                        label="position"
                      />
                      <Button size="sm" onClick={onPositions}>
                        Manage
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
          </Card>
        )}

        {wallet.isConnected && (
          <Card
            title="Tokens held in wallet"
            subtitle="All SPL & Token-2022 tokens held by your connected wallet on this cluster with their live balances."
          >
            {holdings === null && holdingsLoading ? (
              <Spinner label="Reading token accounts…" />
            ) : holdingsError && holdings === null ? (
              <div className="sectionerr">
                <p>{holdingsError}</p>
                <Button size="sm" onClick={() => loadHoldings(true)}>
                  Retry
                </Button>
              </div>
            ) : holdings && holdings.length === 0 ? (
              <Empty title="No Tokens Found">
                <p>You don't have any tokens in this wallet on {network.label}.</p>
              </Empty>
            ) : (
              (holdings ?? []).map((h) => {
                const t = known.get(h.mint)
                return (
                  <div className="hold" key={h.account}>
                    <div className="hold__id">
                      <span className="hold__name">
                        {t ? `${t.name} (${t.symbol})` : `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`}
                      </span>
                      <span className="hold__tag">{h.programLabel}</span>
                    </div>
                    <div className="hold__amt">
                      <strong>{h.uiAmount}</strong>
                      <span className="muted"> · {h.amount} raw · {h.decimals} decimals</span>
                    </div>
                    <div className="hold__foot">
                      <Address value={h.mint} explorer={network.explorerAddress} label="mint" />
                    </div>
                  </div>
                )
              })
            )}
            {holdingsError && holdings !== null && (
              <div className="footnote">{holdingsError}</div>
            )}
          </Card>
        )}

        <Card
          title="Tokens created"
          subtitle="Saved locally when you create a token here. Manage opens the Liquidity tab with the mint filled in."
        >
          {created.length === 0 ? (
            <Empty title="Nothing created yet">
              <p>Tokens you create in this app will be listed here with a Manage button.</p>
            </Empty>
          ) : (
            created.map((t) => (
              <div className="hold" key={t.mint}>
                <div className="hold__id">
                  <span className="hold__name">
                    {t.name} ({t.symbol})
                  </span>
                  <span className="hold__tag">
                    {t.program === 'token2022' ? 'Token-2022' : 'SPL Token'}
                  </span>
                </div>
                <div className="hold__amt">
                  <strong>{Number(t.decimals)} decimals</strong>
                  {t.createdAt ? (
                    <span className="muted"> · created {new Date(t.createdAt).toLocaleDateString()}</span>
                  ) : null}
                </div>
                <div className="hold__foot">
                  <Address value={t.mint} explorer={network.explorerAddress} label="mint" />
                  <Button size="sm" onClick={() => onManage(t.mint)}>
                    Manage
                  </Button>
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  )
}
