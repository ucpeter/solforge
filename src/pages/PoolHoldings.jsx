/**
 * Liquidity → Pool holdings: the live contents of your pool.
 *
 * Deliberately minimal — two cards and a Refresh button, no write-ups:
 *   - SOL in pool, with its live dollar equivalent (CoinGecko)
 *   - Your token in pool, with its dollar equivalent valued at the pool's
 *     CURRENT on-chain price (the real market price — never invented)
 *
 * Refresh re-reads the pool state from the cluster, so you can watch SOL
 * come in as people buy your token. Data is cached for 15 seconds and shared
 * with the Portfolio page, so flipping between them costs no extra RPC.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { readUserPositions, toUi, sqrtPriceToPrice, WSOL } from '../lib/liquidity.js'
import { listCreatedTokens } from '../lib/registry.js'
import {
  withRetries,
  describeError,
  positionsCacheFresh,
  positionsCacheStale,
  positionsCacheSet,
  getMintDecimals,
  decimalsOf,
} from '../lib/rpcResilience.js'
import { solUsdPrice, formatUsd } from '../lib/price.js'
import { Button, Empty, Spinner, Sol, Select } from '../components/ui.jsx'

export default function PoolHoldings({ sdk }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()

  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState(0)
  const [usd, setUsd] = useState(null)
  const [created] = useState(() => listCreatedTokens())

  const symbolForMint = (m) => {
    const s = m.toBase58()
    const t = created.find((t) => t.mint === s)
    return t ? t.symbol : `${s.slice(0, 4)}…${s.slice(-4)}`
  }

  const cacheKey = wallet.isConnected ? `${network.id}:${wallet.address}` : null

  const load = useCallback(
    async (force = false) => {
      if (!wallet.isConnected || !wallet.publicKey || !cacheKey) return
      setLoading(true)
      setError(null)
      try {
        if (!force) {
          const cached = positionsCacheFresh(cacheKey)
          if (cached) {
            setList(cached)
            return
          }
        }
        const l = await withRetries(() => readUserPositions(connection, sdk, wallet.publicKey))
        // Warm the decimals cache (usually already known) before rendering.
        await Promise.all(
          l.flatMap((p) => [p.poolState.tokenAMint, p.poolState.tokenBMint]).map((m) =>
            getMintDecimals(connection, m).catch(() => {})
          )
        )
        positionsCacheSet(cacheKey, l)
        setList(l)
      } catch (err) {
        const stale = positionsCacheStale(cacheKey)
        if (stale) {
          setList(stale)
          setError('Showing last known data — the RPC failed on refresh.')
        } else {
          setError(describeError(err))
        }
      } finally {
        setLoading(false)
      }
    },
    [connection, sdk, wallet, cacheKey]
  )

  useEffect(() => {
    if (wallet.isConnected) {
      load()
    } else {
      setList(null)
      setError(null)
    }
  }, [wallet.isConnected, load])

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
    load(true)
    solUsdPrice({ force: true }).then(setUsd)
  }

  if (!wallet.isConnected) {
    return (
      <Empty title="Wallet Not Connected">
        <p>Connect your wallet to see your pool's live holdings.</p>
      </Empty>
    )
  }

  const active = list && list.length ? list[Math.min(pick, list.length - 1)] : null

  if (!active) {
    if (list === null) {
      return loading ? (
        <Spinner label="Reading your pool…" />
      ) : (
        <div className="sectionerr">
          <p>{error}</p>
          <Button size="sm" onClick={() => load(true)}>
            Retry
          </Button>
        </div>
      )
    }
    return (
      <Empty title="No pools yet">
        <p>Create a pool first — its live SOL and token balances will show here.</p>
      </Empty>
    )
  }

  /* ------------------------------------------------------------ pool math */

  const dA = decimalsOf(active.poolState.tokenAMint)
  const dB = decimalsOf(active.poolState.tokenBMint)
  const solIsA = WSOL.equals(active.poolState.tokenAMint)

  const solRaw = Number((solIsA ? active.poolState.tokenAAmount : active.poolState.tokenBAmount).toString())
  const solAmt = solRaw / 1e9
  const solUsd = usd !== null ? solAmt * usd : null

  const tokenMint = solIsA ? active.poolState.tokenBMint : active.poolState.tokenAMint
  const tokenRaw = solIsA ? active.poolState.tokenBAmount : active.poolState.tokenAAmount
  const tokenDec = solIsA ? dB : dA
  const tokenSym = symbolForMint(tokenMint)

  // Pool price is "1 A = price B" in token units. Convert to SOL-per-token.
  const priceAB = sqrtPriceToPrice(active.poolState.sqrtPrice, dA, dB)
  const solPerToken = solIsA ? (priceAB > 0 ? 1 / priceAB : 0) : priceAB
  const tokenUsd =
    usd !== null && solPerToken > 0
      ? (Number(tokenRaw.toString()) / 10 ** tokenDec) * solPerToken * usd
      : null

  /* ----------------------------------------------------------------- view */

  return (
    <div>
      <div className="page__head">
        <div>
          <h1 className="page__title">Pool holdings</h1>
          <p className="page__sub">The live contents of your pool.</p>
        </div>
        <Button onClick={refresh} loading={loading}>
          Refresh
        </Button>
      </div>

      {list.length > 1 && (
        <div className="poolhold__pick">
          <Select
            value={String(Math.min(pick, list.length - 1))}
            onChange={(v) => setPick(Number(v))}
            options={list.map((p, i) => {
              const tm = WSOL.equals(p.poolState.tokenAMint)
                ? p.poolState.tokenBMint
                : p.poolState.tokenAMint
              return { value: String(i), label: `Pool ${p.pool.toBase58().slice(0, 8)}… · ${symbolForMint(tm)}/SOL` }
            })}
          />
        </div>
      )}

      <div className="poolhold__id">
        Pool {active.pool.toBase58().slice(0, 8)}… · {tokenSym}/SOL
      </div>

      <div className="stats2">
        <div className="statcard">
          <span className="statcard__label">SOL in pool</span>
          <span className="statcard__value">
            <Sol lamports={solRaw} precision={6} />
          </span>
          {solUsd !== null && <span className="statcard__usd">≈ {formatUsd(solUsd)}</span>}
          <span className="statcard__hint">{usd !== null ? 'price via CoinGecko' : 'SOL price unavailable'}</span>
        </div>
        <div className="statcard">
          <span className="statcard__label">{tokenSym} in pool</span>
          <span className="statcard__value poolhold__token">
            {toUi(tokenRaw, tokenDec)}
          </span>
          {tokenUsd !== null && <span className="statcard__usd">≈ {formatUsd(tokenUsd)}</span>}
          <span className="statcard__hint">valued at the pool's current price</span>
        </div>
      </div>

      {error && <div className="footnote poolhold__note">{error}</div>}
    </div>
  )
}
