/**
 * Liquidity → Pool holdings: the live contents of your active pools.
 * Displays ALL pools simultaneously in individual cards (no dropdown required).
 * Filters out inactive pools (0 SOL or 0 LP balance) so closed pools never clutter the screen.
 * Each card features:
 *   - Left: SOL in pool + live USD equivalent (CoinGecko)
 *   - Right: Created Token in pool
 *   - Direct "Withdraw Liquidity" button that pops up the % selector (25%, 50%, 75%, 100%)
 * Works seamlessly for both Meteora DAMM v2 and Raydium CP-MM.
 */
import { useCallback, useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { readUserPositions, toUi, WSOL, planRemoveLiquidity } from '../lib/liquidity.js'
import { listCreatedTokens, listCreatedPools } from '../lib/registry.js'
import {
  readRaydiumPoolDetails,
  buildWithdrawRaydiumTx,
  fetchUserRaydiumPoolsOnChain,
} from '../lib/raydium.js'
import {
  withRetries,
  describeError,
  isEndpointBlocked,
  getMintDecimals,
  decimalsOf,
} from '../lib/rpcResilience.js'
import { solUsdPrice, formatUsd } from '../lib/price.js'
import { Button, Empty, Spinner, Sol, Modal } from '../components/ui.jsx'
import TxReview from '../components/TxReview.jsx'

export default function PoolHoldings({ sdk }) {
  const { connection, network, probeFallbacks } = useNetwork()
  const wallet = useWallet()

  const [protocolFilter, setProtocolFilter] = useState('all') // 'all' | 'meteora' | 'raydium'
  const [showClosedPools, setShowClosedPools] = useState(false)

  const [meteoraList, setMeteoraList] = useState([])
  const [raydiumList, setRaydiumList] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [usd, setUsd] = useState(null)
  const [created, setCreated] = useState(() => listCreatedTokens(network.id))

  // Modal withdrawal state
  const [selectedPoolForWithdraw, setSelectedPoolForWithdraw] = useState(null)
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

        // 2. Read Raydium pools from both registry and direct on-chain scan
        const localPools = listCreatedPools(network.id)
        const poolAddresses = new Set(
          localPools
            .filter((p) => p.platform === 'raydium' || !p.positionNftMint)
            .map((p) => p.pool)
        )

        const onChainPools = await fetchUserRaydiumPoolsOnChain(connection, wallet.publicKey, network.id)
        for (const op of onChainPools) {
          poolAddresses.add(op.pubkey)
        }

        const rList = []
        for (const addr of poolAddresses) {
          try {
            const details = await readRaydiumPoolDetails(connection, addr, wallet.publicKey)
            if (details) {
              const state = details.decoded
              const is0W = state.token0Mint.equals(WSOL)
              const tMint = is0W ? state.token1Mint.toBase58() : state.token0Mint.toBase58()
              rList.push({
                pool: new PublicKey(addr),
                isRaydium: true,
                details,
                tokenMint: tMint,
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

  // Helper to determine if pool has active liquidity
  const isPoolActive = (p) => {
    if (p.type === 'raydium') {
      const is0W = p.details.decoded.token0Mint.equals(WSOL)
      const solRaw = Number(is0W ? p.details.vault0Amount : p.details.vault1Amount)
      const userLp = p.details.userLpBalance
      return solRaw > 1000000 && userLp > 0n // More than 0.001 SOL & user has LP
    } else {
      const liq = p.liquidity
      return !liq.unlocked.isZero()
    }
  }

  // Combined and filtered pool list
  const combined = [
    ...meteoraList.map((p) => ({ ...p, type: 'meteora' })),
    ...raydiumList.map((p) => ({ ...p, type: 'raydium' })),
  ]

  const activePools = combined.filter((p) => isPoolActive(p))
  const closedPools = combined.filter((p) => !isPoolActive(p))

  const visiblePools = (showClosedPools ? combined : activePools).filter(
    (p) => protocolFilter === 'all' || p.type === protocolFilter
  )

  async function handleExecuteWithdraw() {
    if (!selectedPoolForWithdraw) return
    const p = selectedPoolForWithdraw
    const pct = Math.max(1, Math.min(100, Number(withdrawPercent) || 100))
    setWithdrawing(true)

    try {
      if (p.type === 'raydium') {
        const userLp = p.details.userLpBalance
        if (userLp <= 0n) throw new Error('No LP tokens in your wallet to withdraw.')
        const burnAmount = (userLp * BigInt(pct)) / 100n

        const res = await buildWithdrawRaydiumTx({
          connection,
          owner: wallet.publicKey,
          poolAddress: p.pool.toBase58(),
          lpAmount: burnAmount,
          network: network.id,
        })

        setWithdrawPlan({
          tx: res.tx,
          notes: [
            `Burns ${pct}% of your Raydium LP position.`,
            'Returns your pooled SOL directly to your native wallet balance.',
            'Returns your unsold tokens directly to your wallet.',
          ],
        })
      } else {
        const planTx = await planRemoveLiquidity({
          connection,
          sdk,
          owner: wallet.publicKey,
          pool: p.pool,
          positionNftMint: p.positionNftMint,
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

      {/* Protocol Navigation Filter Bar + Inactive Toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        <div className="seg" style={{ margin: 0, display: 'flex', gap: '6px' }}>
          <button
            type="button"
            className={`seg__btn ${protocolFilter === 'all' ? 'seg__btn--on' : ''}`}
            onClick={() => setProtocolFilter('all')}
          >
            All Active ({activePools.length})
          </button>
          <button
            type="button"
            className={`seg__btn ${protocolFilter === 'meteora' ? 'seg__btn--on' : ''}`}
            onClick={() => setProtocolFilter('meteora')}
          >
            Meteora DAMM ({activePools.filter((p) => p.type === 'meteora').length})
          </button>
          <button
            type="button"
            className={`seg__btn ${protocolFilter === 'raydium' ? 'seg__btn--on' : ''}`}
            onClick={() => setProtocolFilter('raydium')}
          >
            Raydium CP-MM ({activePools.filter((p) => p.type === 'raydium').length})
          </button>
        </div>

        {closedPools.length > 0 && (
          <button
            type="button"
            onClick={() => setShowClosedPools(!showClosedPools)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-dim)',
              fontSize: '12px',
              textDecoration: 'underline',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            {showClosedPools ? `Hide ${closedPools.length} Inactive/Closed Pools` : `Show ${closedPools.length} Inactive/Closed Pools`}
          </button>
        )}
      </div>

      {loading && visiblePools.length === 0 ? (
        <Spinner label="Reading your pools…" />
      ) : visiblePools.length === 0 ? (
        <Empty title={`No active ${protocolFilter === 'all' ? '' : protocolFilter.toUpperCase() + ' '}pools`}>
          <p>
            {closedPools.length > 0
              ? `You have ${closedPools.length} closed/withdrawn pool(s). Tap "Show Inactive/Closed Pools" above to view past pools.`
              : 'Create a pool on Meteora or Raydium first — its live SOL and token balances will show here.'}
          </p>
        </Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {visiblePools.map((p) => (
            <PoolHoldingCard
              key={p.pool.toBase58()}
              p={p}
              usd={usd}
              symbolForMint={symbolForMint}
              onOpenWithdraw={() => {
                setSelectedPoolForWithdraw(p)
                setWithdrawPercent('100')
              }}
            />
          ))}
        </div>
      )}

      {error && <div className="footnote poolhold__note" style={{ marginTop: '12px' }}>{error}</div>}

      {/* Pop-up Modal for Percentage Withdrawal */}
      {selectedPoolForWithdraw && (
        <Modal
          open
          onClose={() => setSelectedPoolForWithdraw(null)}
          title={`Withdraw Liquidity (${selectedPoolForWithdraw.type === 'raydium' ? 'Raydium CP-MM' : 'Meteora DAMM'})`}
        >
          <div style={{ padding: '8px 0' }}>
            <p style={{ margin: '0 0 12px', fontSize: '14px', color: 'var(--text-dim)' }}>
              Choose what percentage of your liquidity you want to pull out of the pool back into your wallet:
            </p>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' }}>
              {['25', '50', '75', '100'].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className={`seg__btn ${withdrawPercent === pct ? 'seg__btn--on' : ''}`}
                  onClick={() => setWithdrawPercent(pct)}
                  style={{ minWidth: '60px', padding: '8px 14px', fontWeight: 600 }}
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
                    width: '68px',
                    padding: '8px',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    color: 'var(--text)',
                    fontSize: '14px',
                    textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: '14px', color: 'var(--text-dim)' }}>%</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' }}>
              <Button variant="ghost" onClick={() => setSelectedPoolForWithdraw(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleExecuteWithdraw}
                disabled={withdrawing || !withdrawPercent || Number(withdrawPercent) <= 0}
              >
                {withdrawing ? 'Preparing…' : `Confirm Withdraw ${withdrawPercent}%`}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* TxReview Gate for Withdrawal */}
      {withdrawPlan && (
        <TxReview
          open
          onClose={() => setWithdrawPlan(null)}
          title={`Withdraw ${withdrawPercent}% Liquidity`}
          summary={`Withdraw ${withdrawPercent}% of your pool position back into your wallet.`}
          transactions={[withdrawPlan.tx]}
          partialSigners={[]}
          costRows={[]}
          notes={withdrawPlan.notes}
          onSent={() => {
            setWithdrawPlan(null)
            setSelectedPoolForWithdraw(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function PoolHoldingCard({ p, usd, symbolForMint, onOpenWithdraw }) {
  let solRaw = 0
  let solAmt = 0
  let solUsd = null
  let tokenMintStr = ''
  let tokenUi = '0'
  let tokenSym = ''
  let platformLabel = 'Meteora DAMM v2'
  let canWithdraw = false
  let userHoldingText = ''

  if (p.type === 'raydium') {
    platformLabel = 'Raydium CP-MM'
    const state = p.details.decoded
    const is0W = state.token0Mint.equals(WSOL)
    const solLamports = is0W ? p.details.vault0Amount : p.details.vault1Amount
    solRaw = Number(solLamports)
    solAmt = solRaw / 1e9
    solUsd = usd !== null ? solAmt * usd : null

    tokenMintStr = is0W ? state.token1Mint.toBase58() : state.token0Mint.toBase58()
    tokenUi = is0W ? p.details.vault1Ui : p.details.vault0Ui
    tokenSym = symbolForMint(tokenMintStr)
    const userLpUi = p.details.userLpUi
    canWithdraw = userLpUi > 0
    userHoldingText = `${userLpUi.toLocaleString()} LP (${userLpUi > 0 ? '100%' : '0%'})`
  } else {
    const dA = decimalsOf(p.poolState.tokenAMint)
    const dB = decimalsOf(p.poolState.tokenBMint)
    const solIsA = WSOL.equals(p.poolState.tokenAMint)

    solRaw = Number((solIsA ? p.poolState.tokenAAmount : p.poolState.tokenBAmount).toString())
    solAmt = solRaw / 1e9
    solUsd = usd !== null ? solAmt * usd : null

    const tokenMint = solIsA ? p.poolState.tokenBMint : p.poolState.tokenAMint
    const tokenRaw = solIsA ? p.poolState.tokenBAmount : p.poolState.tokenAAmount
    const tokenDec = solIsA ? dB : dA
    tokenMintStr = tokenMint.toBase58()
    tokenSym = symbolForMint(tokenMintStr)
    tokenUi = toUi(tokenRaw, tokenDec)
    const liq = p.liquidity
    canWithdraw = !liq.unlocked.isZero()
    userHoldingText = `${((Number(liq.unlocked.toString()) / (Number(liq.total.toString()) || 1)) * 100).toFixed(1)}% unlocked LP`
  }

  const isInactive = solRaw <= 1000000 && !canWithdraw

  return (
    <div
      style={{
        background: 'var(--bg-3)',
        border: '1px solid var(--line)',
        borderRadius: '12px',
        padding: '16px',
        opacity: isInactive ? 0.65 : 1,
      }}
    >
      {/* Card Header: Pool ID & Protocol Tag */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ fontSize: '15px', fontWeight: 650 }}>
          Pool {p.pool.toBase58().slice(0, 8)}… · <span style={{ color: 'var(--accent)' }}>{tokenSym}/SOL</span>
          {isInactive && (
            <span style={{ marginLeft: '8px', fontSize: '11px', background: 'var(--bg-4)', color: 'var(--text-mute)', padding: '2px 6px', borderRadius: '4px' }}>
              Closed / Withdrawn
            </span>
          )}
        </div>
        <span style={{ fontSize: '12px', background: 'var(--bg-4)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--line-2)' }}>
          {platformLabel}
        </span>
      </div>

      {/* Main Stats: Left = SOL, Right = Created Token */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: '12px',
          background: 'var(--bg-2)',
          border: '1px solid var(--line)',
          borderRadius: '10px',
          padding: '14px',
          marginBottom: '14px',
        }}
      >
        {/* Left: SOL in Pool */}
        <div>
          <span style={{ fontSize: '12px', color: 'var(--text-mute)', display: 'block', marginBottom: '2px' }}>
            SOL IN POOL
          </span>
          <div style={{ fontSize: '18px', fontWeight: 700 }}>
            <Sol lamports={solRaw} precision={4} />
          </div>
          {solUsd !== null && (
            <span style={{ fontSize: '12px', color: 'var(--good)' }}>
              ≈ {formatUsd(solUsd)}
            </span>
          )}
        </div>

        {/* Right: Created Token in Pool */}
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-mute)', display: 'block', marginBottom: '2px' }}>
            {tokenSym} IN POOL
          </span>
          <div style={{ fontSize: '18px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tokenUi}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-mute)' }}>
            vault tokens
          </span>
        </div>
      </div>

      {/* Card Footer: Position Status & Withdraw Button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          Ownership: <strong>{userHoldingText}</strong>
        </div>

        {canWithdraw && (
          <Button variant="danger" size="sm" onClick={onOpenWithdraw}>
            Withdraw Liquidity →
          </Button>
        )}
      </div>
    </div>
  )
}
