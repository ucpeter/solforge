/**
 * Liquidity — Meteora DAMM v2 pools.
 *
 * Create a pool for a token you made (or any mint), then manage the position:
 * permanent lock, time-based lock, add / remove liquidity, claim fees.
 * Every action goes through the same TxReview gate as token creation.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import {
  Address,
  Amount,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  KeyValue,
  Select,
  Sol,
  Spinner,
  Tabs,
  TextInput,
  Toggle,
} from '../components/ui.jsx'
import TxReview from '../components/TxReview.jsx'
import SuccessModal, { PlatformLinks } from '../components/SuccessModal.jsx'
import PoolHoldings from './PoolHoldings.jsx'
import {
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_DEFAULT_CONFIG,
  RAYDIUM_MAINNET_CONFIGS,
  buildCreateRaydiumPoolTx,
  readRaydiumPoolDetails,
  buildWithdrawRaydiumTx,
  fetchUserRaydiumPoolsOnChain,
} from '../lib/raydium.js'

import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import {
  ACTIVATION_TYPE_LABEL,
  COLLECT_FEE_MODE_LABEL,
  WSOL,
  describePoolFees,
  formatPrice,
  listPoolConfigs,
  lockableLiquidity,
  makeSdk,
  planAddLiquidity,
  planClaimFees,
  planCreatePool,
  planPermanentLock,
  planRemoveLiquidity,
  planVestingLock,
  programIdForChoice,
  readUserPositions,
  sqrtPriceToPrice,
  toUi,
  describeMeteoraError,
} from '../lib/liquidity.js'
import { loadSettings, listCreatedTokens, addCreatedPool } from '../lib/registry.js'
import { withRetries, describeError, isEndpointBlocked } from '../lib/rpcResilience.js'
import { toRawAmount, clsx } from '../lib/format.js'
import { solUsdPrice, formatUsd } from '../lib/price.js'

export default function Liquidity({
  manageMint = null,
  manageTab = null,
  onManageConsumed = () => {},
}) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()
  const [settings] = useState(() => loadSettings())
  const [tab, setTab] = useState(manageTab || 'create')
  // Mint handed over from Portfolio → Manage. Captured at mount so it stays
  // available to CreatePool even after the parent clears it.
  const [initialMint, setInitialMint] = useState(manageMint)
  const sdk = useMemo(() => makeSdk(connection), [connection])

  // Portfolio → Manage handoff: land on the right tab and pre-fill the mint.
  useEffect(() => {
    if (manageMint || manageTab) {
      setTab(manageTab ?? 'create')
      if (manageMint) setInitialMint(manageMint)
      onManageConsumed()
    }
  }, [manageMint, manageTab, onManageConsumed])

  return (
    <div className="page">
      <Tabs
        tabs={[
          { id: 'create', label: 'Create a pool' },
          { id: 'holdings', label: 'Pool holdings' },
          { id: 'positions', label: 'My positions' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'create' ? (
        <CreatePool network={network} sdk={sdk} slippageBps={settings.slippageBps} initialMint={initialMint} />
      ) : tab === 'holdings' ? (
        <PoolHoldings sdk={sdk} />
      ) : (
        <Positions sdk={sdk} />
      )}
    </div>
  )
}

/* ================================================================ create */

async function readDecimals(connection, mint) {
  const info = await connection.getAccountInfo(mint)
  if (!info) throw new Error('That mint does not exist on this cluster.')
  const parsed = await connection.getParsedAccountInfo(mint, { encoding: 'jsonParsed' })
  // getParsedAccountInfo returns the full RPC response ({context, value}).
  const acc = parsed?.value ?? parsed
  const d = acc?.data?.parsed?.info?.decimals
  if (typeof d === 'number') return d
  throw new Error('That account exists but is not a token mint.')
}

function CreatePool({ sdk, slippageBps, initialMint = null }) {
  const { connection, network, probeFallbacks } = useNetwork()
  const wallet = useWallet()

  const [tokens, setTokens] = useState(() => listCreatedTokens(network.id))

  useEffect(() => {
    setTokens(listCreatedTokens(network.id))
  }, [network.id])
  const [mintInput, setMintInput] = useState(initialMint || '')
  const [mint, setMint] = useState(null)
  const [decimals, setDecimals] = useState(null)
  const [mintError, setMintError] = useState(null)
  const [mintLoading, setMintLoading] = useState(false)

  const [tokenAmount, setTokenAmount] = useState('')
  const [solAmount, setSolAmount] = useState('')
  const [lock, setLock] = useState(false)
  const [slippage, setSlippage] = useState(String(slippageBps ?? 0))
  const [destination, setDestination] = useState('meteora') // 'meteora' | 'pumpfun' | 'raydium'

  const [configs, setConfigs] = useState(null)
  const [configError, setConfigError] = useState(null)
  const [configPick, setConfigPick] = useState(0)
  const [configBusy, setConfigBusy] = useState(false)

  const [reviewOpen, setReviewOpen] = useState(false)
  const [success, setSuccess] = useState(null)
  const [showExtremeConfigs, setShowExtremeConfigs] = useState(false)
  const [plan, setPlan] = useState(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState(null)
  const [usdRate, setUsdRate] = useState(null)
  const [walletTokenBalance, setWalletTokenBalance] = useState(null)
  const [walletTokenLoading, setWalletTokenLoading] = useState(false)

  useEffect(() => {
    solUsdPrice().then(setUsdRate)
  }, [])

  const loadConfigs = useCallback(async () => {
    setConfigBusy(true)
    setConfigError(null)
    try {
      const list = await withRetries(() => listPoolConfigs(connection))
      if (!list.length) setConfigError('No static pool configs found on this cluster.')
      setConfigs(list)
    } catch (err) {
      if (isEndpointBlocked(err)) probeFallbacks()
      setConfigError(describeError(err))
    } finally {
      setConfigBusy(false)
    }
  }, [connection, probeFallbacks])

  useEffect(() => {
    loadConfigs()
  }, [loadConfigs])

  // Resolve the mint from either the registry picker or raw paste.
  useEffect(() => {
    if (!mintInput.trim()) {
      setMint(null)
      setDecimals(null)
      setMintError(null)
      setWalletTokenBalance(null)
      return
    }
    let cancelled = false
    setMintLoading(true)
    setMintError(null)
    ;(async () => {
      try {
        const pk = new PublicKey(mintInput.trim())
        const d = await readDecimals(connection, pk)
        if (!cancelled) {
          setMint(pk)
          setDecimals(d)
        }
        if (wallet.publicKey && !cancelled) {
          setWalletTokenLoading(true)
          try {
            const parsed = await connection.getParsedTokenAccountsByOwner(
              wallet.publicKey,
              { mint: pk },
              'confirmed'
            )
            let total = 0n
            for (const { account } of parsed.value) {
              const raw = BigInt(account?.data?.parsed?.info?.tokenAmount?.amount ?? '0')
              total += raw
            }
            if (!cancelled) setWalletTokenBalance(total)
          } catch {
            if (!cancelled) setWalletTokenBalance(null)
          } finally {
            if (!cancelled) setWalletTokenLoading(false)
          }
        }
      } catch (err) {
        if (!cancelled) setMintError(err.message)
      } finally {
        if (!cancelled) setMintLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mintInput, connection])

  const tokenRaw = toRawAmount(tokenAmount, decimals ?? 0)
  const solRaw = toRawAmount(solAmount, 9)
  const price =
    decimals !== null && tokenRaw && solRaw && BigInt(tokenRaw) > 0n && BigInt(solRaw) > 0n
      ? Number(solRaw) / 10 ** 9 / (Number(tokenRaw) / 10 ** decimals)
      : null

  const ready =
    wallet.isConnected &&
    mint &&
    decimals !== null &&
    BigInt(tokenRaw || '0') > 0n &&
    BigInt(solRaw || '0') > 0n &&
    (destination === 'raydium' || configs?.length > 0) &&
    !planning

  async function openReview() {
    setPlanning(true)
    setPlanError(null)
    try {
      if (destination === 'raydium') {
        const rayRes = await buildCreateRaydiumPoolTx({
          connection,
          creator: wallet.publicKey,
          tokenMint: mint,
          tokenProgram: programIdForChoice('spl'),
          tokenAmountRaw: tokenRaw,
          solAmountLamports: solRaw,
          network: network.id,
        })
        setPlan({
          tx: rayRes.tx,
          pool: new PublicKey(rayRes.poolState),
          positionNft: null,
          isRaydium: true,
          notes: [
            'Initializes a new Raydium CP-MM liquidity pool.',
            'Raydium protocol creation fee: 0.15 SOL.',
            'LP tokens are minted directly into your wallet.',
          ],
        })
        setReviewOpen(true)
      } else {
        const chosen = visibleConfigs[configPick]
        const p = await planCreatePool({
          connection,
          sdk,
          payer: wallet.publicKey,
          config: chosen.address,
          tokenMint: mint,
          tokenAmount: new BN(tokenRaw),
          quoteMint: WSOL,
          quoteAmount: new BN(solRaw),
          tokenDecimals: decimals,
          quoteDecimals: 9,
          tokenProgram: programIdForChoice('spl'),
          quoteProgram: programIdForChoice('spl'),
          lockLiquidity: lock,
          slippageBps: Number(slippage) || 0,
        })
        setPlan(p)
        setReviewOpen(true)
      }
    } catch (err) {
      setPlanError(err.message)
    } finally {
      setPlanning(false)
    }
  }

  async function onSent(results) {
    // Snapshot everything the success popup needs BEFORE the plan is cleared.
    const poolAddress = plan.pool.toBase58()
    const mintAddress = mint.toBase58()
    const signature = results.map((r) => r.signature)[0] || null
    const protocol = plan.isRaydium ? 'raydium' : 'meteora'
    try {
      addCreatedPool({
        pool: poolAddress,
        networkId: network.id,
        platform: protocol,
        positionNftMint: plan.positionNft?.publicKey ? plan.positionNft.publicKey.toBase58() : (plan.lpMint || null),
        tokenMint: mintAddress,
        tokenAmount: tokenRaw,
        solAmount: solRaw,
        decimals,
        config: plan.isRaydium ? (plan.config || 'raydium-cpmm') : visibleConfigs?.[configPick]?.address,
        locked: lock,
        signatures: results.map((r) => r.signature),
      })
    } catch (e) {
      console.warn('addCreatedPool save error:', e)
    } finally {
      setReviewOpen(false)
      setPlan(null)
      setSuccess({ poolAddress, mintAddress, signature, protocol })
    }
  }

  // Half the configs on devnet start at >= 50% (mostly 99%) — test junk.
  // Hidden by default; the toggle brings them back for anyone who wants them.
  const visibleConfigs = useMemo(() => {
    if (!configs) return null
    return showExtremeConfigs ? configs : configs.filter((c) => !c.isExtremeFee)
  }, [configs, showExtremeConfigs])

  const extremeCount = configs ? configs.filter((c) => c.isExtremeFee).length : 0

  const chosen = visibleConfigs?.[configPick]

  return (
    <div className="page__grid page__grid--2col">
      <div className="page__col">
        <Card
          title="Launchpad & Liquidity Destination"
          subtitle="Choose where your liquidity pool or bonding curve will be deployed."
        >
          <div className="seg" style={{ marginBottom: '16px' }}>
            <button
              type="button"
              className={clsx('seg__btn', destination === 'meteora' && 'seg__btn--on')}
              onClick={() => setDestination('meteora')}
            >
              Meteora DAMM v2
            </button>
            <button
              type="button"
              className={clsx('seg__btn', destination === 'pumpfun' && 'seg__btn--on')}
              onClick={() => setDestination('pumpfun')}
            >
              Pump.fun (0 SOL)
            </button>
            <button
              type="button"
              className={clsx('seg__btn', destination === 'raydium' && 'seg__btn--on')}
              onClick={() => setDestination('raydium')}
            >
              Raydium CP-MM
            </button>
          </div>

          {destination === 'meteora' && (
            <Banner tone="info">
              <strong>Meteora DAMM v2:</strong> Dynamic fee AMM with 100% LP ownership, full withdrawal control anytime, and permanent lock options.
            </Banner>
          )}

          {destination === 'pumpfun' && (
            <Banner tone="warn" title="How Pump.fun Pools Work">
              <div style={{ lineHeight: 1.5 }}>
                Pump.fun does <strong>not</strong> allow importing external SPL tokens or adding liquidity to pre-minted tokens.
                On Pump.fun, the token and its virtual bonding curve pool <strong>must be minted together at the exact same moment</strong> on Pump.fun.
              </div>
              <div style={{ marginTop: '10px', fontSize: '13px', color: 'var(--text-dim)' }}>
                👉 To launch a coin on Pump.fun's 0-SOL curve, create the coin directly on their portal (requires connecting your wallet to sign in):
              </div>
              <div style={{ marginTop: '10px' }}>
                <a
                  href="https://pump.fun/create"
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn--primary btn--sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  Launch on Pump.fun Portal ↗
                </a>
              </div>
            </Banner>
          )}

          {destination === 'raydium' && (
            <Banner tone="info" title="Raydium CP-MM Liquidity Pool (Native In-App)">
              <div style={{ lineHeight: 1.5 }}>
                Deploy directly to <strong>Raydium CP-MM</strong> right here in SolForge. Raydium charges a standard <strong>0.15 SOL</strong> protocol initialization fee. Your LP tokens are minted directly into your connected wallet.
              </div>
            </Banner>
          )}

          <div className="form__stack" style={{ marginTop: '16px' }}>
            <Field label="Token" hint="Pick one you created here, or paste any mint address.">
              {tokens.length > 0 && (
                <Select
                  value={tokens.some((t) => t.mint === mintInput.trim()) ? mintInput.trim() : ''}
                  onChange={setMintInput}
                  options={[
                    { value: '', label: '— pick or paste below —' },
                    ...tokens.map((t) => ({ value: t.mint, label: `${t.symbol} (${t.mint.slice(0, 6)}…)` })),
                  ]}
                />
              )}
              <div className="form__row">
                <TextInput mono value={mintInput} onChange={setMintInput} placeholder="or paste a mint address" />
                {mintLoading && <Spinner label="reading…" />}
              </div>
              {mintError && <Banner tone="danger">{mintError}</Banner>}
              {mint && decimals !== null && (
                <Banner tone="good" title="Resolved on-chain">
                  <div>
                    <Address value={mint.toBase58()} explorer={network.explorerAddress} />
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-dim)' }}>
                    Token exists · {decimals} decimals
                  </div>
                </Banner>
              )}
            </Field>
            <div className="form__row">
              <Field
                label={`Token amount (${decimals ?? '—'} decimals)`}
                hint={
                  walletTokenBalance !== null && decimals !== null ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-mute)', marginRight: '2px' }}>
                        Dev hold presets:
                      </span>
                      {[
                        { label: '100% (0% dev)', pct: 100 },
                        { label: '99% (1% dev)', pct: 99 },
                        { label: '98% (2% dev)', pct: 98 },
                        { label: '95% (5% dev)', pct: 95 },
                      ].map((preset) => (
                        <button
                          key={preset.pct}
                          type="button"
                          className="btn btn--ghost btn--sm"
                          style={{
                            padding: '3px 8px',
                            fontSize: '11.5px',
                            borderRadius: '6px',
                            border: '1px solid var(--line-2)',
                            background: 'var(--bg-4)',
                          }}
                          onClick={() => {
                            const rawDeposit = (walletTokenBalance * BigInt(preset.pct)) / 100n
                            setTokenAmount(toUi(rawDeposit, decimals, { precision: 9 }))
                          }}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  ) : walletTokenLoading ? (
                    'Checking wallet token balance…'
                  ) : (
                    'Amount of tokens to deposit into the liquidity pool.'
                  )
                }
              >
                <TextInput value={tokenAmount} onChange={setTokenAmount} placeholder="e.g. 1000000" />
              </Field>
              <Field label="SOL amount" hint="Amount of SOL to pair against the tokens in the pool.">
                <TextInput value={solAmount} onChange={setSolAmount} placeholder="e.g. 3" />
              </Field>
            </div>
            {price !== null && (
              <Banner tone="info">
                <div>
                  <strong>Starting price:</strong> 1 token = {formatPrice(price)} SOL
                  {usdRate !== null && (
                    <span style={{ marginLeft: '8px', color: 'var(--good)' }}>
                      (≈ {formatUsd(price * usdRate)})
                    </span>
                  )}
                </div>
                <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-mute)' }}>
                  Set by ratio: {Number(solAmount)} SOL ÷ {Number(tokenAmount).toLocaleString()} tokens
                </div>
              </Banner>
            )}
            {destination === 'meteora' && (
            <Field label="Pool config" hint="Configs are chosen by the protocol — each one fixes how fees behave.">
              {configError && <Banner tone="danger">{configError}</Banner>}
              {!configs && !configError && <Spinner label="Loading static configs…" />}
              {configs && (
                <Select
                  value={String(configPick)}
                  onChange={(v) => setConfigPick(Number(v))}
                  options={(visibleConfigs || []).map((c, i) => ({
                    value: String(i),
                    label: `${i + 1}. ${c.startingFeeBps !== null ? (c.startingFeeBps / 100).toFixed(2) + '%' : '?%'} · ${c.feeSchedule ? c.feeSchedule.label : 'schedule unknown'} · ${c.dynamicFee ? 'dynamic on' : 'no dynamic'}${c.collectFeeMode === 2 ? ` · compounding fee ${c.compoundingFeePercent.toFixed(2)}%` : ''} · ${c.address.slice(0, 4)}…`,
                  }))}
                />
              )}
              {configs && extremeCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setShowExtremeConfigs((v) => !v)
                    setConfigPick(0)
                  }}
                  style={{
                    marginTop: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-dim)',
                    fontSize: '12px',
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    padding: '4px 0',
                  }}
                >
                  {showExtremeConfigs
                    ? `Hide ${extremeCount} extreme-fee test configs (50%+ fees)`
                    : `Show ${extremeCount} extreme-fee test configs (50%+ fees)`}
                </button>
              )}
              {chosen && (
                <div className="cfgbox">
                  <KeyValue
                    dense
                    items={[
                      { label: 'Fees', value: chosen.collectFeeModeLabel },
                      { label: 'Fee schedule', value: chosen.baseFeeModeLabel },
                      {
                        label: 'Fee decay',
                        value: chosen.feeSchedule
                          ? chosen.feeSchedule.periods === 0
                            ? `Flat — stays at ${(chosen.startingFeeBps / 100).toFixed(2)}% forever`
                            : `Steps down over ${chosen.feeSchedule.periods} period(s), then stays there`
                          : 'Not decodable for this fee mode',
                      },
                      { label: 'Dynamic fee', value: chosen.dynamicFee ? 'enabled' : 'disabled' },
                      ...(chosen.collectFeeMode === 2
                        ? [
                            {
                              label: 'Compounding fee',
                              value: `${chosen.compoundingFeePercent.toFixed(2)}% of your LP fee is auto-reinvested into the position; the rest stays claimable (raw: ${chosen.compoundingFeeBps} bps)`,
                            },
                          ]
                        : []),
                      {
                        label: 'Identical on-chain copies',
                        value:
                          chosen.duplicateCount > 1
                            ? `${chosen.duplicateCount} configs share this exact fee setup — any of them behaves the same`
                            : 'Only one config has this setup',
                      },
                      { label: 'Protocol share', value: `${chosen.protocolFeePercent}% of the trading fee goes to Meteora` },
                      {
                        label: 'Referral share',
                        value: `${chosen.referralFeePercent}% of the protocol's share — i.e. ${((chosen.protocolFeePercent * chosen.referralFeePercent) / 100).toFixed(2)}% of the trading fee`,
                      },
                      { label: 'Activation', value: chosen.activationTypeLabel },
                      ...(chosen.startingFeeBps !== null
                        ? [
                            {
                              label: 'On a 1 SOL trade',
                              value:
                                `${(chosen.startingFeeBps / 10000).toFixed(4)} SOL is taken as the fee, ` +
                                `${(1 - chosen.startingFeeBps / 10000).toFixed(4)} SOL is actually swapped. ` +
                                `Of the fee: ${((chosen.startingFeeBps / 10000) * (1 - chosen.protocolFeePercent / 100)).toFixed(4)} SOL to liquidity providers, ` +
                                `${((chosen.startingFeeBps / 10000) * (chosen.protocolFeePercent / 100) * (1 - chosen.referralFeePercent / 100)).toFixed(4)} SOL to Meteora`,
                            },
                          ]
                        : []),
                      { label: 'Config address', value: <Address value={chosen.address} />, mono: true },
                    ]}
                  />
                  <button className="linkish" onClick={loadConfigs} disabled={configBusy}>
                    {configBusy ? 'Refreshing…' : 'Refresh configs'}
                  </button>
                </div>
              )}
            </Field>
            )}
            <Field label={`Slippage tolerance (basis points, ${Number(slippage) / 100}%)`}>
              <TextInput type="number" value={slippage} onChange={setSlippage} min={0} max={10000} />
            </Field>
            <Toggle
              checked={lock}
              onChange={setLock}
              label="Permanently lock the initial position"
              description="Runs in the same transaction. The liquidity can never be withdrawn again — by anyone. Choose this only if you mean it."
              danger
            />
          </div>
          {planError && <Banner tone="danger" title="Could not build the transaction">{planError}</Banner>}
        </Card>
      </div>

      <div className="page__col page__col--sticky">
        <Card title="Review">
          {!wallet.isConnected && (
            <Banner tone="warn" title="Wallet not connected">
              Connect a wallet first.
            </Banner>
          )}
          <Button variant="primary" size="lg" className="w-full" disabled={!ready} loading={planning} onClick={openReview}>
            Review transaction
          </Button>
          <p className="footnote">
            The pool is created with your deposit as the first LP position. Trading fees behave according to the
            config you chose above — the app never takes a cut.
          </p>
        </Card>
      </div>

      {plan && (
        <TxReview
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          title={plan.isRaydium ? "Create Raydium CP-MM Pool" : "Create Meteora DAMM Pool"}
          summary={`Deposit ${tokenAmount} tokens + ${solAmount} SOL into a new ${plan.isRaydium ? 'Raydium CP-MM' : 'DAMM v2'} pool on ${network.label}.`}
          transactions={[plan.tx]}
          partialSigners={plan.positionNft ? [[plan.positionNft]] : []}
          costRows={[
            { label: 'SOL deposited into the pool', lamports: Number(solRaw), recoverable: true },
            ...(plan.isRaydium ? [{ label: 'Raydium protocol fee', lamports: 150000000, recoverable: false }] : [])
          ]}
          notes={plan.notes}
          onSent={onSent}
        />
      )}

      <SuccessModal
        open={Boolean(success)}
        onClose={() => setSuccess(null)}
        title="Liquidity pool created"
        subtitle={
          success
            ? `Your ${success.protocol === 'raydium' ? 'Raydium CP-MM' : 'Meteora DAMM v2'} pool is open on ${network.label}. Track how the coin is doing with the buttons below — each one opens in a new tab.`
            : ''
        }
        network={network}
        linkData={
          success
            ? {
                mint: success.mintAddress,
                pool: success.poolAddress,
                protocol: success.protocol,
                signature: success.signature,
                address: success.poolAddress,
                addressLabel: 'View pool on Solana Explorer',
              }
            : {}
        }
        rows={
          success
            ? [
                { label: 'Pool address', value: success.poolAddress, mono: true, copy: true },
                { label: 'Token mint', value: success.mintAddress, mono: true, copy: true },
                { label: 'Token deposited', value: `${tokenAmount} ${tokens.find((x) => x.mint === success.mintAddress)?.symbol || ''}`.trim() },
                { label: 'SOL deposited', value: `${solAmount} SOL` },
                { label: 'Protocol', value: success.protocol === 'raydium' ? 'Raydium CP-MM' : 'Meteora DAMM v2' },
                { label: 'Network', value: network.label },
              ]
            : []
        }
      />
    </div>
  )
}

/* ============================================================ positions */

function Positions({ sdk }) {
  const { connection, network, probeFallbacks } = useNetwork()
  const wallet = useWallet()

  const [positions, setPositions] = useState(null)
  const [raydiumPositions, setRaydiumPositions] = useState([])
  const [protocolFilter, setProtocolFilter] = useState('all') // 'all' | 'meteora' | 'raydium'
  const [error, setError] = useState(null)
  const [decimalsByMint, setDecimalsByMint] = useState({})
  const [action, setAction] = useState(null) // { kind, position }

  const load = useCallback(async () => {
    if (!wallet.isConnected) {
      setPositions(null)
      setRaydiumPositions([])
      return
    }
    setError(null)
    try {
      // 1. Read Meteora positions
      let list = []
      try {
        list = await withRetries(() => readUserPositions(connection, sdk, wallet.publicKey))
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
                out[m] = await readDecimals(connection, new PublicKey(m))
              } catch {
                out[m] = 9
              }
            })
          )
          setDecimalsByMint(out)
        }
      } catch (e) {
        console.warn('Meteora positions load error:', e)
        setPositions([])
      }

      // 2. Read Raydium positions (both local registry AND direct on-chain scan)
      try {
        const localPools = listCreatedPools(network.id)
        const poolAddresses = new Set(
          localPools
            .filter((p) => p.platform === 'raydium' || !p.positionNftMint)
            .map((p) => p.pool)
        )

        // Scan directly on-chain for pools created by this wallet
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
        setRaydiumPositions(rList)
      } catch (e) {
        console.warn('Raydium positions load error:', e)
      }
    } catch (err) {
      if (isEndpointBlocked(err)) probeFallbacks()
      setError(describeError(err))
    }
  }, [connection, sdk, wallet.isConnected, wallet.publicKey, decimalsByMint, network.id, probeFallbacks])

  useEffect(() => {
    load()
  }, [load])

  if (!wallet.isConnected) {
    return (
      <Empty title="No wallet connected">
        <p>Connect a wallet to see the positions you own on this cluster.</p>
      </Empty>
    )
  }

  if (error)
    return (
      <div className="sectionerr">
        <p>{error}</p>
        <Button size="sm" onClick={load}>
          Retry
        </Button>
      </div>
    )
  if (!positions && raydiumPositions.length === 0) return <div className="review__busy"><Spinner label="Loading positions…" /></div>

  // Filter active vs closed positions
  const isRaydiumActive = (p) => {
    const is0W = p.details.decoded.token0Mint.equals(WSOL)
    const solRaw = Number(is0W ? p.details.vault0Amount : p.details.vault1Amount)
    return solRaw > 1000000 && p.details.userLpUi > 0
  }

  const activeRaydium = raydiumPositions.filter(isRaydiumActive)
  const activeMeteora = (positions || []).filter((p) => !p.liquidity.unlocked.isZero())

  const visibleMeteora = (protocolFilter === 'all' || protocolFilter === 'meteora') ? activeMeteora : []
  const visibleRaydium = (protocolFilter === 'all' || protocolFilter === 'raydium') ? activeRaydium : []
  const totalCount = visibleMeteora.length + visibleRaydium.length

  return (
    <div className="poslist">
      <div className="seg" style={{ marginBottom: '16px', display: 'flex', gap: '6px' }}>
        <button
          type="button"
          className={`seg__btn ${protocolFilter === 'all' ? 'seg__btn--on' : ''}`}
          onClick={() => setProtocolFilter('all')}
        >
          All Active ({activeMeteora.length + activeRaydium.length})
        </button>
        <button
          type="button"
          className={`seg__btn ${protocolFilter === 'meteora' ? 'seg__btn--on' : ''}`}
          onClick={() => setProtocolFilter('meteora')}
        >
          Meteora DAMM ({activeMeteora.length})
        </button>
        <button
          type="button"
          className={`seg__btn ${protocolFilter === 'raydium' ? 'seg__btn--on' : ''}`}
          onClick={() => setProtocolFilter('raydium')}
        >
          Raydium CP-MM ({activeRaydium.length})
        </button>
      </div>

      {totalCount === 0 ? (
        <Empty title={`No ${protocolFilter === 'all' ? '' : protocolFilter.toUpperCase() + ' '}positions found`}>
          <p>Create a pool on Meteora or Raydium first to manage liquidity positions here.</p>
        </Empty>
      ) : (
        <>
          {visibleMeteora.map((p) => (
            <PositionCard
              key={p.position.toBase58()}
              p={p}
              decimalsByMint={decimalsByMint}
              network={network}
              onAction={setAction}
            />
          ))}

          {visibleRaydium.map((p) => (
            <RaydiumPositionCard
              key={p.pool.toBase58()}
              p={p}
              network={network}
              onAction={setAction}
            />
          ))}
        </>
      )}

      <Button variant="ghost" onClick={load}>
        Refresh
      </Button>
      {action && (
        <PositionAction
          action={action}
          sdk={sdk}
          decimalsByMint={decimalsByMint}
          onDone={() => {
            setAction(null)
            load()
          }}
        />
      )}
    </div>
  )
}

/**
 * Resolve a mint address to a name a human recognises.
 *
 * Both the position card and the deposit form need this, so it lives here
 * rather than being duplicated inside whichever component happened to be edited
 * first. Symbols come from the tokens this user created (which is why they are
 * per-network: a devnet mint and a mainnet mint are different tokens). Anything
 * unknown falls back to a slice of the mint address, never to "Token A".
 */
function useTokenNaming(networkId) {
  const created = useMemo(() => {
    try {
      return listCreatedTokens(networkId)
    } catch {
      return []
    }
  }, [networkId])

  const symbolFor = useCallback((mintStr) => {
    if (mintStr === WSOL.toBase58()) return 'SOL'
    const hit = created.find((c) => c.mint === mintStr)
    return hit?.symbol || null
  }, [created])

  const shortMint = useCallback((mintStr) => `${mintStr.slice(0, 4)}…${mintStr.slice(-4)}`, [])

  const sideName = useCallback(
    (mintStr) => symbolFor(mintStr) || shortMint(mintStr),
    [symbolFor, shortMint],
  )

  const sideLabel = useCallback(
    (mintStr) => {
      const sym = symbolFor(mintStr)
      return sym ? `${sym} (${shortMint(mintStr)})` : shortMint(mintStr)
    },
    [symbolFor, shortMint],
  )

  return { symbolFor, shortMint, sideName, sideLabel }
}

function PositionCard({ p, decimalsByMint, network, onAction }) {
  const dA = decimalsByMint[p.poolState.tokenAMint.toBase58()] ?? 9
  const dB = decimalsByMint[p.poolState.tokenBMint.toBase58()] ?? 9

  // Name the real asset on each side; "Token A" alone tells the user nothing.
  const { sideName, symbolFor } = useTokenNaming(network.id)
  const mintA = p.poolState.tokenAMint.toBase58()
  const mintB = p.poolState.tokenBMint.toBase58()
  const price = sqrtPriceToPrice(p.poolState.sqrtPrice, dA, dB)
  const liq = p.liquidity
  const lockable = lockableLiquidity(p.positionState, p.poolState)
  const total = Number(liq.total.toString()) || 1
  const pct = (bn) => `${(Number(bn.toString()) / total) * 100}%`

  return (
    <Card
      title={`Pool ${p.pool.toBase58().slice(0, 8)}…`}
      right={<Banner tone="info">{COLLECT_FEE_MODE_LABEL[p.poolState.collectFeeMode]} · {ACTIVATION_TYPE_LABEL[p.poolState.activationType]}</Banner>}
    >
      <div className="form__row form__row--3 posnums">
        <div>
          <span className="muted" title={mintA}>
            Token A · <strong style={{ color: 'var(--text)' }}>{sideName(mintA)}</strong>
          </span>
          <div>
            <Amount value={p.poolState.tokenAAmount} decimals={dA} precision={2} symbol={symbolFor(mintA) || undefined} />
          </div>
        </div>
        <div>
          <span className="muted" title={mintB}>
            Token B · <strong style={{ color: 'var(--text)' }}>{sideName(mintB)}</strong>
          </span>
          <div>
            {p.poolState.tokenBMint.equals(WSOL) ? (
              <Amount value={p.poolState.tokenBAmount} decimals={dB} precision={2} symbol="SOL" />
            ) : (
              <Amount value={p.poolState.tokenBAmount} decimals={dB} precision={2} />
            )}
          </div>
        </div>
        <div>
          <span className="muted">
            Price (1 {sideName(mintA)} = … {sideName(mintB)})
          </span>
          <div>{formatPrice(price)}</div>
        </div>
      </div>

      <KeyValue
        dense
        items={[
          { label: 'Position address', value: <Address value={p.position} explorer={network.explorerAddress} />, mono: true },
          { label: 'Pool address', value: <Address value={p.pool} explorer={network.explorerAddress} />, mono: true },
          { label: 'Unlocked liquidity', value: `${pct(liq.unlocked)} of position`, tone: liq.unlocked.isZero() ? 'bad' : 'good' },
          { label: 'Permanently locked', value: pct(liq.permanentlyLocked), tone: liq.permanentlyLocked.isZero() ? undefined : 'warn' },
          {
            label: 'Pending fees',
            value: `${toUi(p.pendingFees.a, dA)} A + ${toUi(p.pendingFees.b, dB)} B`,
          },
        ]}
      />

      <div style={{ marginTop: '14px' }}>
        <PlatformLinks
          network={network}
          mint={(WSOL.equals(p.poolState.tokenAMint) ? p.poolState.tokenBMint : p.poolState.tokenAMint).toBase58()}
          pool={p.pool.toBase58()}
          protocol="meteora"
          compact
        />
      </div>

      <div className="posactions">
        <Button variant="secondary" disabled={liq.unlocked.isZero()} onClick={() => onAction({ kind: 'withdraw', p })}>
          Withdraw liquidity
        </Button>
        <Button variant="secondary" disabled={liq.unlocked.isZero()} onClick={() => onAction({ kind: 'lock', p })}>
          Permanent lock
        </Button>
        <Button variant="secondary" onClick={() => onAction({ kind: 'claim', p })}>
          Claim fees
        </Button>
        <Button variant="ghost" onClick={() => onAction({ kind: 'add', p })}>
          Add liquidity
        </Button>
      </div>
    </Card>
  )
}

function RaydiumPositionCard({ p, network, onAction }) {
  const d = p.details
  const decoded = d.decoded
  const is0Wsol = decoded.token0Mint.equals(WSOL)
  const solAmt = (Number(is0Wsol ? d.vault0Amount : d.vault1Amount) / 1e9).toFixed(3)
  const tokenAmt = is0Wsol ? d.vault1Ui.toLocaleString() : d.vault0Ui.toLocaleString()
  const userLpUi = d.userLpUi

  return (
    <Card
      title={`Raydium Pool ${p.pool.toBase58().slice(0, 8)}…`}
      right={<Banner tone="good">Raydium CP-MM (Standard)</Banner>}
    >
      <div className="form__row form__row--3 posnums">
        <div>
          <span className="muted">SOL Vault</span>
          <div style={{ fontWeight: 650 }}>{solAmt} SOL</div>
        </div>
        <div>
          <span className="muted">Token Vault</span>
          <div style={{ fontWeight: 650 }}>{tokenAmt} tokens</div>
        </div>
        <div>
          <span className="muted">Your LP Ownership</span>
          <div style={{ fontWeight: 650, color: 'var(--good)' }}>{userLpUi.toLocaleString()} LP ({userLpUi > 0 ? '100%' : '0%'})</div>
        </div>
      </div>

      <KeyValue
        dense
        items={[
          { label: 'Pool address', value: <Address value={p.pool} explorer={network.explorerAddress} />, mono: true },
          { label: 'LP Mint address', value: <Address value={decoded.lpMint} explorer={network.explorerAddress} />, mono: true },
          { label: 'Token 0 Vault', value: <Address value={decoded.token0Vault} explorer={network.explorerAddress} />, mono: true },
          { label: 'Token 1 Vault', value: <Address value={decoded.token1Vault} explorer={network.explorerAddress} />, mono: true },
        ]}
      />

      <div style={{ marginTop: '14px' }}>
        <PlatformLinks
          network={network}
          mint={(is0Wsol ? decoded.token1Mint : decoded.token0Mint).toBase58()}
          pool={p.pool.toBase58()}
          protocol="raydium"
          compact
        />
      </div>

      <div className="posactions">
        <Button
          variant="secondary"
          disabled={userLpUi <= 0}
          onClick={() => onAction({ kind: 'withdraw-raydium', p })}
        >
          Withdraw Liquidity
        </Button>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------- actions */

function PositionAction({ action, sdk, decimalsByMint, onDone }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()
  const p = action.p
  const kind = action.kind
  const dA = decimalsByMint[p.poolState.tokenAMint.toBase58()] ?? 9
  const dB = decimalsByMint[p.poolState.tokenBMint.toBase58()] ?? 9
  const { sideName, sideLabel } = useTokenNaming(network.id)
  const mintA = p.poolState.tokenAMint.toBase58()
  const mintB = p.poolState.tokenBMint.toBase58()
  const isNativeA = mintA === WSOL.toBase58()
  const isNativeB = mintB === WSOL.toBase58()
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(true)
  const [closePos, setClosePos] = useState(true)

  // per-action inputs
  const [pct, setPct] = useState('100')
  const [addSide, setAddSide] = useState('A')
  const [addAmount, setAddAmount] = useState('')
  // Slippage for add-liquidity. This was hard-coded at 50 bps with no way to
  // change it: any pool that moved more than 0.5% between quoting and execution
  // failed with Meteora error 6002 (ExceededSlippage). 1% is now the default and
  // the user can raise it.
  const [addSlippage, setAddSlippage] = useState('100')
  const [cliffDays, setCliffDays] = useState('0')
  const [periods, setPeriods] = useState('30')
  const [useVesting, setUseVesting] = useState(false)

  const title = {
    withdraw: 'Withdraw liquidity',
    'withdraw-raydium': 'Withdraw Raydium Liquidity',
    lock: useVesting ? 'Time-based (vesting) lock' : 'Permanent lock',
    claim: 'Claim trading fees',
    add: 'Add liquidity',
  }[kind]

  async function build() {
    setBusy(true)
    setError(null)
    try {
      let planTx = null
      if (kind === 'withdraw') {
        const pctN = Math.floor(Number(pct))
        planTx = await planRemoveLiquidity({
          connection,
          sdk,
          owner: wallet.publicKey,
          pool: p.pool,
          positionNftMint: p.positionNftMint,
          percent: pctN,
          closePosition: closePos && pctN === 100,
        })
      } else if (kind === 'withdraw-raydium') {
        const pctN = Math.floor(Number(pct))
        const userLp = p.details.userLpBalance
        const burnAmount = (userLp * BigInt(pctN)) / 100n
        const res = await buildWithdrawRaydiumTx({
          connection,
          owner: wallet.publicKey,
          poolAddress: p.pool.toBase58(),
          lpAmount: burnAmount,
          network: network.id,
        })
        planTx = {
          tx: res.tx,
          notes: [
            `Burns ${pctN}% of your Raydium LP position.`,
            'Returns your deposited SOL directly to your native wallet balance.',
            'Returns your unsold tokens directly to your wallet.',
          ],
        }
      } else if (kind === 'lock') {
        const available = lockableLiquidity(p.positionState, p.poolState)
        if (!useVesting) {
          const amount = available.mul(new BN(pct)).div(new BN(100))
          if (amount.isZero()) throw new Error('Nothing to lock at that percentage.')
          planTx = await planPermanentLock({
            connection,
            sdk,
            owner: wallet.publicKey,
            pool: p.pool,
            positionNftMint: p.positionNftMint,
            amount,
          })
        } else {
          planTx = await planVestingLock({
            connection,
            sdk,
            owner: wallet.publicKey,
            payer: wallet.publicKey,
            pool: p.pool,
            positionNftMint: p.positionNftMint,
            cliffSeconds: Number(cliffDays || 0) * 86400,
            periodSeconds: 86400,
            numberOfPeriods: Number(periods || 30),
          })
        }
      } else if (kind === 'claim') {
        planTx = await planClaimFees({
          connection,
          sdk,
          owner: wallet.publicKey,
          pool: p.pool,
          positionNftMint: p.positionNftMint,
        })
      } else if (kind === 'add') {
        const isA = addSide === 'A'
        const dec = isA ? dA : dB
        const raw = toRawAmount(addAmount, dec)
        if (BigInt(raw || '0') <= 0n) throw new Error('Enter an amount to add.')
        planTx = await planAddLiquidity({
          connection,
          sdk,
          owner: wallet.publicKey,
          pool: p.pool,
          positionNftMint: p.positionNftMint,
          inAmount: new BN(raw),
          inIsTokenA: isA,
          slippageBps: Number(addSlippage) || 0,
        })
      }
      setPlan(planTx)
    } catch (err) {
      setError(err.message)
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    build()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, pct, closePos, useVesting, addSide, addAmount, addSlippage, cliffDays, periods])

  if (!open) return null

  const pctN = Math.min(100, Math.max(1, Math.floor(Number(pct) || 100)))

  const controls = (
    <div className="review__controls">
      {(kind === 'withdraw' || (kind === 'lock' && !useVesting)) && (
        <Card title={kind === 'withdraw' ? 'Withdrawal' : 'Lock amount'}>
          <label className="sliderlabel">
            <span>
              {kind === 'withdraw' ? 'Withdraw' : 'Permanently lock'} <b>{pctN}%</b> of unlocked liquidity
            </span>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={pctN}
              className={clsx('slider', kind === 'lock' && 'slider--danger')}
              onChange={(e) => setPct(e.target.value)}
            />
            <div className="slider__quick">
              {[25, 50, 75, 100].map((q) => (
                <button key={q} className={clsx('chip', pctN === q && 'chip--done')} onClick={() => setPct(String(q))}>
                  {q}%
                </button>
              ))}
            </div>
          </label>
          {kind === 'withdraw' && (
            <Toggle
              checked={closePos && pctN === 100}
              onChange={(v) => setClosePos(v)}
              label="Close the position and recover its rent"
              description="Burns the position NFT (~0.04 SOL rent back). Only possible at 100% — a partially emptied position must stay open to keep earning fees."
            />
          )}
          {kind === 'withdraw' && pctN < 100 && (
            <Banner tone="info">
              Removing liquidity from an active pool can cause price impact. The rest of the position keeps working.
            </Banner>
          )}
        </Card>
      )}
      {kind === 'add' && (
        <Card title="Deposit">
          <div className="form__row">
            <Field label={`Side — which token you are supplying`}>
              <select className="input input--select" value={addSide} onChange={(e) => setAddSide(e.target.value)}>
                <option value="A">{sideLabel(mintA)} — Token A</option>
                <option value="B">{sideLabel(mintB)} — Token B</option>
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {addSide === 'A' ? `Token A = ${sideName(mintA)}` : `Token B = ${sideName(mintB)}`}
                {(addSide === 'A' ? isNativeA : isNativeB) ? ' · native SOL, wrapped automatically' : ''}
              </div>
            </Field>
            <Field label={`Amount (${addSide === 'A' ? sideName(mintA) : sideName(mintB)})`}>
              <TextInput value={addAmount} onChange={setAddAmount} placeholder="e.g. 1000" />
            </Field>
            <Field label="Slippage (bps)">
              <TextInput value={addSlippage} onChange={setAddSlippage} placeholder="100" />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {(Number(addSlippage) || 0) / 100}% · raise this if it fails
              </div>
            </Field>
          </div>
          {plan?.amountA && plan?.amountB ? (
            <Banner tone="info">
              <strong>What this will take from your wallet:</strong>
              <br />
              {toUi(plan.amountA, dA)} {sideName(mintA)} (Token A)
              <br />+ {toUi(plan.amountB, dB)} {sideName(mintB)} (Token B)
              <br />
              <span className="muted">
                You pick one side; the pool requires the matching amount of the other at the current price.
              </span>
            </Banner>
          ) : (
            <Banner tone="info">
              A pool needs <strong>both</strong> tokens. You choose one side and how much — the app quotes the
              matching amount of the other side at the pool&rsquo;s current price and shows it here before you sign.
            </Banner>
          )}
        </Card>
      )}
      {kind === 'lock' && useVesting && (
        <Card title="Vesting schedule">
          <div className="form__row">
            <Field label="Cliff (days)">
              <TextInput type="number" value={cliffDays} onChange={setCliffDays} min={0} />
            </Field>
            <Field label="Unlock periods (days each)">
              <TextInput type="number" value={periods} onChange={setPeriods} min={1} />
            </Field>
          </div>
        </Card>
      )}
      {error && <Banner tone="danger" title="Could not build the transaction">{error}</Banner>}
    </div>
  )

  return (
    <TxReview
      open
      onClose={() => onDone()}
      title={title}
      summary={`Position ${p.position.toBase58().slice(0, 10)}… in pool ${p.pool.toBase58().slice(0, 10)}… on ${network.label}.`}
      transactions={plan ? [plan.tx] : []}
      partialSigners={plan ? [[]] : []}
      notes={plan?.notes ?? []}
      onSent={() => {
        setOpen(false)
        onDone()
      }}
      controls={controls}
      prepDep={plan}
    />
  )
}
