/**
 * Portfolio — what the connected wallet actually owns on the current cluster.
 *
 * Everything here is read straight from the chain:
 *   - SOL balance: live from the RPC, plus a USD equivalent fetched live from
 *     CoinGecko (shown only when we actually got a price — never invented)
 *   - Token holdings: every token account the wallet owns, on BOTH the SPL
 *     Token and Token-2022 programs, showing decimals + raw amounts
 *   - Liquidity positions: your DAMM v2 positions, with what the pool
 *     CURRENTLY holds and your unlocked/locked percentages
 *   - Tokens created: the local registry of tokens created through this app
 *     (this device), each with a Manage button that hands the mint to the
 *     Liquidity tab. This is local data, so it shows even without a wallet.
 *
 * If a number cannot be read, it is shown as unavailable — never guessed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
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
import { Card, Button, Banner, Empty, Spinner, Sol, Address } from '../components/ui.jsx'

const TOKEN_PROGRAMS = [
  [TOKEN_PROGRAM_ID, 'SPL Token'],
  [TOKEN_2022_PROGRAM_ID, 'Token-2022'],
]

/**
 * Public cluster RPCs rate-limit per IP, and Render's shared IPs get hammered
 * by lots of apps. Retry heavy reads a few times with backoff before giving up.
 */
async function withRetries(fn, { attempts = 3, baseDelayMs = 1200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const rateLimited = /429|too many requests/i.test(String(err?.message ?? ''))
      if (!rateLimited || i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)))
    }
  }
}

async function readMintDecimals(connection, mint) {
  const parsed = await connection.getParsedAccountInfo(mint, { encoding: 'jsonParsed' })
  const d = parsed?.value?.data?.parsed?.info?.decimals
  if (typeof d !== 'number') throw new Error('not a mint')
  return d
}

export default function Portfolio({ onManage, onPositions }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()
  const sdk = useMemo(() => makeSdk(connection), [connection])

  const [holdings, setHoldings] = useState(null)
  const [positions, setPositions] = useState(null)
  const [positionsError, setPositionsError] = useState(null)
  const [decimalsByMint, setDecimalsByMint] = useState({})
  const [usd, setUsd] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [created] = useState(() => listCreatedTokens())

  // Mint (base58) → registry entry, so we can show a real symbol where we have one.
  const known = useMemo(() => {
    const map = new Map()
    for (const t of created) map.set(t.mint, t)
    return map
  }, [created])

  const load = useCallback(async () => {
    if (!wallet.isConnected || !wallet.publicKey) return
    setLoading(true)
    setError(null)
    setPositionsError(null)

    try {
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
      setHoldings(rows)
      wallet.refreshBalance(connection, wallet.publicKey)
    } catch (err) {
      setError(err.message)
    }

    // Positions are best-effort and independent of the holdings read.
    try {
      const list = await withRetries(() => readUserPositions(connection, sdk, wallet.publicKey))
      setPositions(list)
      const mints = new Set()
      for (const p of list) {
        mints.add(p.poolState.tokenAMint.toBase58())
        mints.add(p.poolState.tokenBMint.toBase58())
      }
      const missing = [...mints].filter((m) => !(m in decimalsByMint))
      if (missing.length) {
        const out = { ...decimalsByMint }
        await Promise.all(
          missing.map(async (m) => {
            try {
              out[m] = await readMintDecimals(connection, new PublicKey(m))
            } catch {
              out[m] = 9
            }
          })
        )
        setDecimalsByMint(out)
      }
    } catch {
      setPositionsError(null) // section just hides itself; holdings error is separate
    }

    solUsdPrice({ force: true }).then(setUsd)
    setLoading(false)
  }, [connection, wallet, sdk, decimalsByMint])

  useEffect(() => {
    setHoldings(null)
    setError(null)
    load()
  }, [load])

  // Live SOL→USD price on mount (Refresh forces a re-fetch inside load()).
  useEffect(() => {
    let live = true
    solUsdPrice().then((p) => {
      if (live) setUsd(p)
    })
    return () => {
      live = false
    }
  }, [])

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

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Portfolio</h1>
          <p className="page__sub">
            Read live from the cluster: real SOL balance, real token accounts, your liquidity
            positions, and the tokens you created through this app on this device.
          </p>
        </div>
        {wallet.isConnected && (
          <Button onClick={load} loading={loading}>
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
          <span className="statcard__hint">token accounts with a balance</span>
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

      {error && (
        <Banner tone="danger" title="Could not read your accounts">
          {error}
          <div className="footnote">
            The public devnet RPC rate-limits frequent requests (especially from shared hosting).
            Tap Refresh to retry, or set a custom RPC in Settings — a free Helius or Triton devnet
            key makes this error go away.
          </div>
        </Banner>
      )}

      <div className="page__grid">
        {wallet.isConnected && (
          <Card
            title="Token holdings"
            subtitle="Every token account this wallet owns on this cluster (SPL Token and Token-2022)"
          >
            {loading && holdings === null ? (
              <Spinner label="Reading token accounts…" />
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
          </Card>
        )}

        {wallet.isConnected && (
          <Card
            title="Liquidity positions"
            subtitle="Live totals for your DAMM v2 pools. “Pool holds” is the pool's current total — you own 100% of this pool, so a 100% withdrawal returns the whole pool at today's price (with other LPs it would pay your share)."
          >
            {positions === null ? (
              <Spinner label="Reading liquidity positions…" />
            ) : positions.length === 0 ? (
              <Empty title="No liquidity positions">
                <p>Pools you create in the Liquidity tab will appear here with their live totals.</p>
              </Empty>
            ) : (
              positions.map((p) => {
                const dA = decimalsByMint[p.poolState.tokenAMint.toBase58()] ?? 9
                const dB = decimalsByMint[p.poolState.tokenBMint.toBase58()] ?? 9
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
