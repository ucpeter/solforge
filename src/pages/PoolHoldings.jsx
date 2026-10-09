/**
 * Liquidity → Pool holdings: the live contents of your pool.
 * Supports both Meteora DAMM v2 and native Raydium CP-MM pools.
 * Allows viewing live pool balances, position details, and withdrawing liquidity with % control!
 */
import { useCallback, useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { readUserPositions, toUi, WSOL, planRemoveLiquidity, sqrtPriceToPrice } from '../lib/liquidity.js'
import { listCreatedTokens, listCreatedPools } from '../lib/registry.js'
import {
  readRaydiumPoolDetails,
  buildWithdrawRaydiumTx,
} from '../lib/raydium.js'
import {
  withRetries,
  describeError,
  isEndpointBlocked,
  getMintDecimals,
  decimalsOf,
} from '../lib/rpcResilience.js'
import { solUsdPrice, formatUsd } from '../lib/price.js'
import { Button, Empty, Spinner, Sol, Select, Banner } from '../components/ui.jsx'
import TxReview from '../components/TxReview.jsx'

export default function PoolHoldings({ sdk }) {
  const { connection, network, probeFallbacks } = useNetwork()
  const wallet = useWallet()

  // Filter tab between All, Meteora, and Raydium
  const [protocolFilter, setProtocolFilter] = useState('all') // 'all' | 'meteora' | 'raydium'

  const [meteoraList, setMeteoraList] = useState([])
  const [raydiumList, setRaydiumList] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState(0)
  const [usd, setUsd] = useState(null)
  const [created, setCreated] = useState(() => listCreatedTokens(network.id))

  // Withdrawal state
  const [withdrawPercent, setWithdrawPercent] = useState('100')
  const [withdrawPlan, setWithdrawPlan] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)

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

        // 2. Read Raydium pools from registry and on-chain
        const localPools = listCreatedPools(network.id)
        const raydiumPoolEntries = localPools.filter((p) => p.platform === 'raydium' || !p.positionNftMint)

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

  // Filtered pool list based on protocol filter
  const allPools = [
    ...meteoraList.map((p) => ({ ...p, type: 'meteora' })),
    ...raydiumList.map((p) => ({ ...p, type: 'raydium' })),
  ].filter((p) => protocolFilter === 'all' || p.type === protocolFilter)

  const active = allPools.length ? allPools[Math.min(pick, allPools.length - 1)] : null

  async function handlePrepareWithdraw() {
    if (!active) return
    const pct = Math.max(1, Math.min(100, Number(withdrawPercent) || 100))
    setWithdrawing(true)

    try {
      if (active.type === 'raydium') {
        const userLp = active.details.userLpBalance
        if (userLp <= 0n) throw new Error('No LP tokens in your wallet to withdraw.')
        const burnAmount = (userLp * BigInt(pct)) / 100n

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
            `Burns ${pct}% of your Raydium LP position.`,
            'Returns your pooled SOL directly to your wallet balance.',
            'Returns your unsold tokens directly to your wallet.',
          ],
        })
      } else {
        // Meteora DAMM withdrawal
        const planTx = await planRemoveLiquidity({
          connection,
          sdk,
          owner: wallet.publicKey,
          pool: active.pool,
          positionNftMint: active.positionNftMint,
          percent: pct,
          closePosition: pct === 100,
        })

        setWithdrawPlan({
          tx: planTx.tx,
          notes: [
            `Withdraws ${pct}% of your Meteora liquidity position.`,
            'Returns your deposited SOL and tokens directly to your wallet.',
            ...(pct === 100 ? ['Closes position NFT and recovers rent lamports.'] : []),
          ],
        })
      }
    } catch (err) {
      setError(err.message || 'Failed to prepare liquidity withdrawal')
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

  return (
    <div>
      <div className="page__head">
        <div>
          <h1 className="page__title">Pool holdings</h1>
          <p className="page__sub">Live contents and liquidity management for your pools.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button onClick={refresh} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Protocol Navigation Filter Bar */}
      <div className="seg" style={{ marginBottom: '16px', display: 'flex', gap: '6px' }}>
        <button
          type="button"
          className={`seg__btn ${protocolFilter === 'all' ? 'seg__btn--on' : ''}`}
          onClick={() => {
            setProtocolFilter('all')
            setPick(0)
          }}
        >
          All Pools ({meteoraList.length + raydiumList.length})
        </button>
        <button
          type="button"
          className={`seg__btn ${protocolFilter === 'meteora' ? 'seg__btn--on' : ''}`}
          onClick={() => {
            setProtocolFilter('meteora')
            setPick(0)
          }}
        >
          Meteora DAMM ({meteoraList.length})
        </button>
        <button
          type="button"
          className={`seg__btn ${protocolFilter === 'raydium' ? 'seg__btn--on' : ''}`}
          onClick={() => {
            setProtocolFilter('raydium')
            setPick(0)
          }}
        >
          Raydium CP-MM ({raydiumList.length})
        </button>
      </div>

      {!active ? (
        loading ? (
          <Spinner label="Reading your pools…" />
        ) : (
          <Empty title={`No ${protocolFilter === 'all' ? '' : protocolFilter.toUpperCase() + ' '}pools found`}>
            <p>Create a pool on Meteora or Raydium first — its live SOL and token balances will show here.</p>
          </Empty>
        )
      ) : (
        <>
          {allPools.length > 1 && (
            <div className="poolhold__pick" style={{ marginBottom: '14px' }}>
              <Select
                value={String(Math.min(pick, allPools.length - 1))}
                onChange={(v) => setPick(Number(v))}
                options={allPools.map((p, i) => {
                  const type = p.type === 'raydium' ? 'Raydium' : 'Meteora'
                  const poolKeyStr = p.pool.toBase58().slice(0, 8)
                  return {
                    value: String(i),
                    label: `[${type}] Pool ${poolKeyStr}… (${p.tokenMint ? symbolForMint(p.tokenMint) : 'Token'}/SOL)`,
                  }
                })}
              />
            </div>
          )}

          <PoolDisplay
            active={active}
            usd={usd}
            symbolForMint={symbolForMint}
            withdrawPercent={withdrawPercent}
            setWithdrawPercent={setWithdrawPercent}
            onWithdraw={handlePrepareWithdraw}
            withdrawing={withdrawing}
          />
        </>
      )}

      {error && <div className="footnote poolhold__note" style={{ marginTop: '12px' }}>{error}</div>}

      {withdrawPlan && (
        <TxReview
          open
          onClose={() => setWithdrawPlan(null)}
          title={`Withdraw ${withdrawPercent}% Liquidity`}
          summary={`Withdraw ${withdrawPercent}% of your ${active.type === 'raydium' ? 'Raydium CP-MM' : 'Meteora DAMM'} pool position.`}
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

function PoolDisplay({ active, usd, symbolForMint, withdrawPercent, setWithdrawPercent, onWithdraw, withdrawing }) {
  let solRaw = 0
  let solAmt = 0
  let solUsd = null
  let tokenMintStr = ''
  let tokenUi = '0'
  let tokenSym = ''
  let platformLabel = 'Meteora DAMM v2'
  let userHoldingText = ''
  let canWithdraw = false

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
    const userLpUi = active.details.userLpUi
    canWithdraw = userLpUi > 0
    userHoldingText = `${userLpUi.toLocaleString()} LP Tokens (${userLpUi > 0 ? '100% of pool' : '0 LP tokens'})`
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
    const liq = active.liquidity
    canWithdraw = !liq.unlocked.isZero()
    userHoldingText = `${((Number(liq.unlocked.toString()) / (Number(liq.total.toString()) || 1)) * 100).toFixed(1)}% unlocked LP position`
  }

  return (
    <div>
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

      {/* Position Details & Liquidity Withdrawal Box */}
      <div style={{ marginTop: '20px', padding: '16px', background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: '12px' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>Your {platformLabel} Liquidity Position</h3>
        <p className="muted" style={{ margin: '0 0 14px', fontSize: '13px' }}>
          Current ownership: <strong>{userHoldingText}</strong>
        </p>

        {canWithdraw ? (
          <div>
            <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', fontWeight: 600 }}>
              Select Percentage to Withdraw:
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
              {['25', '50', '75', '100'].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className={`seg__btn ${withdrawPercent === pct ? 'seg__btn--on' : ''}`}
                  onClick={() => setWithdrawPercent(pct)}
                  style={{ minWidth: '60px', padding: '6px 12px' }}
                >
                  {pct}%
                </button>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={withdrawPercent}
                  onChange={(e) => setWithdrawPercent(e.target.value)}
                  style={{
                    width: '64px',
                    padding: '6px 8px',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    color: 'var(--text)',
                    fontSize: '13px',
                    textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: '13px', color: 'var(--text-dim)' }}>%</span>
              </div>
            </div>

            <Button
              variant="danger"
              onClick={onWithdraw}
              disabled={withdrawing || !withdrawPercent || Number(withdrawPercent) <= 0}
            >
              {withdrawing ? 'Preparing…' : `Withdraw ${withdrawPercent}% Liquidity`}
            </Button>
            <p style={{ fontSize: '12px', color: 'var(--text-mute)', margin: '10px 0 0' }}>
              Returns your deposited SOL and unsold {tokenSym} tokens directly back to your wallet.
            </p>
          </div>
        ) : (
          <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: 0 }}>
            No unlocked liquidity available to withdraw for this pool.
          </p>
        )}
      </div>
    </div>
  )
}
