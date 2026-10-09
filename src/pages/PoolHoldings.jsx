/**
 * Liquidity → Pool holdings: the live contents of your pool.
 * Supports both Meteora DAMM v2 and native Raydium CP-MM pools.
 * Allows viewing live pool balances and managing/withdrawing liquidity!
 */
import { useCallback, useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { readUserPositions, toUi, WSOL } from '../lib/liquidity.js'
import { listCreatedTokens, listCreatedPools } from '../lib/registry.js'
import {
  readRaydiumPoolDetails,
  buildWithdrawRaydiumTx,
} from '../lib/raydium.js'
import {
  withRetries,
  describeError,
  isEndpointBlocked,
  positionsCacheFresh,
  positionsCacheStale,
  positionsCacheSet,
  getMintDecimals,
  decimalsOf,
} from '../lib/rpcResilience.js'
import { solUsdPrice, formatUsd } from '../lib/price.js'
import { Button, Empty, Spinner, Sol, Select, Banner, Modal } from '../components/ui.jsx'
import TxReview from '../components/TxReview.jsx'

export default function PoolHoldings({ sdk }) {
  const { connection, network, probeFallbacks } = useNetwork()
  const wallet = useWallet()

  const [meteoraList, setMeteoraList] = useState([])
  const [raydiumList, setRaydiumList] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState(0)
  const [usd, setUsd] = useState(null)
  const [created, setCreated] = useState(() => listCreatedTokens(network.id))

  // Withdraw state
  const [withdrawPlan, setWithdrawPlan] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawPercent, setWithdrawPercent] = useState('100')

  useEffect(() => {
    setCreated(listCreatedTokens(network.id))
  }, [network.id])

  const symbolForMint = (mintStr) => {
    const t = created.find((t) => t.mint === mintStr)
    return t ? t.symbol : `${mintStr.slice(0, 4)}…${mintStr.slice(-4)}`
  }

  const load = useCallback(
    async (force = false) => {
      if (!wallet.isConnected || !wallet.publicKey) return
      setLoading(true)
      setError(null)
      try {
        // 1. Read Meteora positions
        let mList = []
        try {
          mList = await withRetries(() => readUserPositions(connection, sdk, wallet.publicKey))
          await Promise.all(
            mList.flatMap((p) => [p.poolState.tokenAMint, p.poolState.tokenBMint]).map((m) =>
              getMintDecimals(connection, m).catch(() => {})
            )
          )
        } catch (e) {
          console.warn('Meteora read error:', e)
        }

        // 2. Read Raydium pools from registry or on-chain
        const localPools = listCreatedPools(network.id)
        const raydiumPoolEntries = localPools.filter((p) => p.platform === 'raydium' || !p.positionNftMint)

        // Also check if any known created pool in history matches Raydium
        const rList = []
        for (const p of raydiumPoolEntries) {
          try {
            const details = await readRaydiumPoolDetails(connection, p.pool, wallet.publicKey)
            if (details) {
              rList.push({
                pool: new PublicKey(p.pool),
                isRaydium: true,
                details,
                tokenMint: p.tokenMint,
              })
            }
          } catch (e) {
            console.warn('Raydium pool load error:', e)
          }
        }

        setMeteoraList(mList || [])
        setRaydiumList(rList || [])
      } catch (err) {
        if (isEndpointBlocked(err)) probeFallbacks()
        setError(describeError(err))
      } finally {
        setLoading(false)
      }
    },
    [connection, sdk, wallet, network.id, probeFallbacks]
  )

  useEffect(() => {
    if (wallet.isConnected) {
      load()
    } else {
      setMeteoraList([])
      setRaydiumList([])
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

  // Combined pool list
  const allPools = [
    ...meteoraList.map((p) => ({ ...p, type: 'meteora' })),
    ...raydiumList.map((p) => ({ ...p, type: 'raydium' })),
  ]

  const active = allPools.length ? allPools[Math.min(pick, allPools.length - 1)] : null

  async function handleOpenRaydiumWithdraw() {
    if (!active?.isRaydium || !active.details) return
    const userLp = active.details.userLpBalance
    if (userLp <= 0n) return

    setWithdrawing(true)
    try {
      const pct = Number(withdrawPercent) / 100
      const burnAmount = (userLp * BigInt(Math.floor(pct * 10000))) / 10000n

      const res = await buildWithdrawRaydiumTx({
        connection,
        owner: wallet.publicKey,
        poolAddress: active.pool.toBase58(),
        lpAmount: burnAmount,
        network: network.id,
      })

      setWithdrawPlan({
        tx: res.tx,
        notes: [
          `Burns ${withdrawPercent}% of your Raydium LP position.`,
          'Returns your deposited SOL directly into your native wallet balance.',
          'Returns your deposited tokens directly into your wallet.',
        ],
      })
    } catch (err) {
      setError(err.message || 'Failed to prepare Raydium withdrawal')
    } finally {
      setWithdrawing(false)
    }
  }

  if (!wallet.isConnected) {
    return (
      <Empty title="Wallet Not Connected">
        <p>Connect your wallet to see your pool's live holdings.</p>
      </Empty>
    )
  }

  if (!active) {
    return loading ? (
      <Spinner label="Reading your pools…" />
    ) : (
      <Empty title="No pools found on this cluster">
        <p>Create a pool on Meteora or Raydium first — its live SOL and token balances will show here.</p>
      </Empty>
    )
  }

  /* ------------------------------------------------------------ pool rendering */

  let solRaw = 0
  let solAmt = 0
  let solUsd = null
  let tokenMintStr = ''
  let tokenUi = '0'
  let tokenSym = ''
  let platformLabel = 'Meteora DAMM'
  let userLpUi = 0

  if (active.type === 'raydium') {
    platformLabel = 'Raydium CP-MM'
    const state = active.details.decoded
    const is0Wsol = state.token0Mint.equals(WSOL)
    const solLamports = is0Wsol ? active.details.vault0Amount : active.details.vault1Amount
    solRaw = Number(solLamports)
    solAmt = solRaw / 1e9
    solUsd = usd !== null ? solAmt * usd : null

    tokenMintStr = is0Wsol ? state.token1Mint.toBase58() : state.token0Mint.toBase58()
    tokenUi = is0Wsol ? active.details.vault1Ui : active.details.vault0Ui
    tokenSym = symbolForMint(tokenMintStr)
    userLpUi = active.details.userLpUi
  } else {
    const dA = decimalsOf(active.poolState.tokenAMint)
    const dB = decimalsOf(active.poolState.tokenBMint)
    const solIsA = WSOL.equals(active.poolState.tokenAMint)

    solRaw = Number((solIsA ? active.poolState.tokenAAmount : active.poolState.tokenBAmount).toString())
    solAmt = solRaw / 1e9
    solUsd = usd !== null ? solAmt * usd : null

    const tokenMint = solIsA ? active.poolState.tokenBMint : active.poolState.tokenAMint
    const tokenRaw = solIsA ? active.poolState.tokenBAmount : active.poolState.tokenAAmount
    const tokenDec = solIsA ? dB : dA
    tokenMintStr = tokenMint.toBase58()
    tokenSym = symbolForMint(tokenMintStr)
    tokenUi = toUi(tokenRaw, tokenDec)
  }

  return (
    <div>
      <div className="page__head">
        <div>
          <h1 className="page__title">Pool holdings</h1>
          <p className="page__sub">Live contents and liquidity management for your pools.</p>
        </div>
        <Button onClick={refresh} loading={loading}>
          Refresh
        </Button>
      </div>

      {allPools.length > 1 && (
        <div className="poolhold__pick" style={{ marginBottom: '14px' }}>
          <Select
            value={String(Math.min(pick, allPools.length - 1))}
            onChange={(v) => setPick(Number(v))}
            options={allPools.map((p, i) => {
              const type = p.type === 'raydium' ? 'Raydium' : 'Meteora'
              const poolKeyStr = p.pool.toBase58().slice(0, 8)
              return { value: String(i), label: `[${type}] Pool ${poolKeyStr}… (${p.tokenMint ? symbolForMint(p.tokenMint) : 'Token'}/SOL)` }
            })}
          />
        </div>
      )}

      <div className="poolhold__id" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span>Pool {active.pool.toBase58().slice(0, 8)}… · {tokenSym}/SOL</span>
        <span style={{ fontSize: '12px', background: 'var(--bg-4)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--line-2)' }}>
          {platformLabel}
        </span>
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
            {tokenUi}
          </span>
          <span className="statcard__hint">Current vault token balance</span>
        </div>
      </div>

      {/* Raydium Liquidity Position Management */}
      {active.type === 'raydium' && (
        <div style={{ marginTop: '20px', padding: '16px', background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px' }}>Your Raydium Liquidity Position</h3>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: '13px' }}>
                You hold <strong>{userLpUi.toLocaleString()} LP tokens</strong> ({userLpUi > 0 ? '100% of pool' : '0 LP tokens'}).
              </p>
            </div>
            {userLpUi > 0 && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleOpenRaydiumWithdraw}
                disabled={withdrawing}
              >
                {withdrawing ? 'Preparing…' : 'Withdraw Liquidity (100%)'}
              </Button>
            )}
          </div>
          {userLpUi > 0 && (
            <p style={{ fontSize: '12px', color: 'var(--text-mute)', margin: 0 }}>
              Withdrawing returns your pooled SOL and unsold tokens directly back to your wallet and closes the position.
            </p>
          )}
        </div>
      )}

      {error && <div className="footnote poolhold__note" style={{ marginTop: '12px' }}>{error}</div>}

      {withdrawPlan && (
        <TxReview
          open
          onClose={() => setWithdrawPlan(null)}
          title="Withdraw Raydium Liquidity"
          summary={`Burn 100% of your Raydium LP position to return your SOL and ${tokenSym} to your wallet.`}
          transactions={[withdrawPlan.tx]}
          partialSigners={[]}
          costRows={[]}
          notes={withdrawPlan.notes}
          onSent={() => {
            setWithdrawPlan(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}
