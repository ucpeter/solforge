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
import PoolHoldings from './PoolHoldings.jsx'
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
} from '../lib/liquidity.js'
import { loadSettings, listCreatedTokens, addCreatedPool } from '../lib/registry.js'
import { toRawAmount, clsx } from '../lib/format.js'

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
  const { connection, network } = useNetwork()
  const wallet = useWallet()

  const [tokens] = useState(() => listCreatedTokens())
  const [mintInput, setMintInput] = useState(initialMint || '')
  const [mint, setMint] = useState(null)
  const [decimals, setDecimals] = useState(null)
  const [mintError, setMintError] = useState(null)
  const [mintLoading, setMintLoading] = useState(false)

  const [tokenAmount, setTokenAmount] = useState('')
  const [solAmount, setSolAmount] = useState('')
  const [lock, setLock] = useState(false)
  const [slippage, setSlippage] = useState(String(slippageBps ?? 0))

  const [configs, setConfigs] = useState(null)
  const [configError, setConfigError] = useState(null)
  const [configPick, setConfigPick] = useState(0)
  const [configBusy, setConfigBusy] = useState(false)

  const [reviewOpen, setReviewOpen] = useState(false)
  const [plan, setPlan] = useState(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState(null)

  const loadConfigs = useCallback(async () => {
    setConfigBusy(true)
    setConfigError(null)
    try {
      const list = await listPoolConfigs(connection)
      if (!list.length) setConfigError('No static pool configs found on this cluster.')
      setConfigs(list)
    } catch (err) {
      setConfigError(err.message)
    } finally {
      setConfigBusy(false)
    }
  }, [connection])

  useEffect(() => {
    loadConfigs()
  }, [loadConfigs])

  // Resolve the mint from either the registry picker or raw paste.
  useEffect(() => {
    if (!mintInput.trim()) {
      setMint(null)
      setDecimals(null)
      setMintError(null)
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
    configs?.length > 0 &&
    !planning

  async function openReview() {
    setPlanning(true)
    setPlanError(null)
    try {
      const chosen = configs[configPick]
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
    } catch (err) {
      setPlanError(err.message)
    } finally {
      setPlanning(false)
    }
  }

  async function onSent(results) {
    addCreatedPool({
      pool: plan.pool.toBase58(),
      positionNftMint: plan.positionNft.publicKey.toBase58(),
      tokenMint: mint.toBase58(),
      tokenAmount: tokenRaw,
      solAmount: solRaw,
      decimals,
      config: configs[configPick].address,
      locked: lock,
      signatures: results.map((r) => r.signature),
    })
    setReviewOpen(false)
    setPlan(null)
  }

  const chosen = configs?.[configPick]

  return (
    <div className="page__grid page__grid--2col">
      <div className="page__col">
        <Card title="Pair" subtitle="Your token against wrapped SOL, on Meteora DAMM v2.">
          <div className="form__stack">
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
                <Banner tone="good">
                  Resolved: {mint.toBase58()} · {decimals} decimals
                </Banner>
              )}
            </Field>
            <div className="form__row">
              <Field label={`Token amount (${decimals ?? '—'} decimals)`}>
                <TextInput value={tokenAmount} onChange={setTokenAmount} placeholder="e.g. 1000000" />
              </Field>
              <Field label="SOL amount">
                <TextInput value={solAmount} onChange={setSolAmount} placeholder="e.g. 10" />
              </Field>
            </div>
            {price !== null && (
              <Banner tone="info">
                Starting price: 1 token = {formatPrice(price)} SOL (decimal-adjusted).
              </Banner>
            )}
            <Field label="Pool config" hint="Configs are chosen by the protocol — each one fixes how fees behave.">
              {configError && <Banner tone="danger">{configError}</Banner>}
              {!configs && !configError && <Spinner label="Loading static configs…" />}
              {configs && (
                <Select
                  value={String(configPick)}
                  onChange={(v) => setConfigPick(Number(v))}
                  options={configs.map((c, i) => ({
                    value: String(i),
                    label: `${i + 1}. ${c.collectFeeModeLabel} · starts ${c.startingFeeBps !== null ? (c.startingFeeBps / 100).toFixed(2) + '%' : '?'} · ${c.dynamicFee ? 'dynamic fee on' : 'no dynamic fee'}`,
                  }))}
                />
              )}
              {chosen && (
                <div className="cfgbox">
                  <KeyValue
                    dense
                    items={[
                      { label: 'Fees', value: chosen.collectFeeModeLabel },
                      { label: 'Fee schedule', value: chosen.baseFeeModeLabel },
                      { label: 'Dynamic fee', value: chosen.dynamicFee ? 'enabled' : 'disabled' },
                      { label: 'Protocol share', value: `${chosen.protocolFeePercent}% of the trading fee` },
                      { label: 'Referral share', value: `${chosen.referralFeePercent}% of the trading fee` },
                      { label: 'Activation', value: chosen.activationTypeLabel },
                      { label: 'Config address', value: <Address value={chosen.address} />, mono: true },
                    ]}
                  />
                  <button className="linkish" onClick={loadConfigs} disabled={configBusy}>
                    {configBusy ? 'Refreshing…' : 'Refresh configs'}
                  </button>
                </div>
              )}
            </Field>
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
          title="Create liquidity pool"
          summary={`Deposit ${tokenAmount} tokens + ${solAmount} SOL into a new DAMM v2 pool on ${network.label}.`}
          transactions={[plan.tx]}
          partialSigners={[[plan.positionNft]]}
          costRows={[{ label: 'SOL deposited into the pool', lamports: Number(solRaw), recoverable: true }]}
          notes={plan.notes}
          onSent={onSent}
        />
      )}
    </div>
  )
}

/* ============================================================ positions */

function Positions({ sdk }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()

  const [positions, setPositions] = useState(null)
  const [error, setError] = useState(null)
  const [decimalsByMint, setDecimalsByMint] = useState({})
  const [action, setAction] = useState(null) // { kind, position }

  const load = useCallback(async () => {
    if (!wallet.isConnected) {
      setPositions(null)
      return
    }
    setError(null)
    try {
      const list = await readUserPositions(connection, sdk, wallet.publicKey)
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
    } catch (err) {
      setError(err.message)
    }
  }, [connection, sdk, wallet.isConnected, wallet.publicKey, decimalsByMint])

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

  if (error) return <Banner tone="danger">{error}</Banner>
  if (!positions) return <div className="review__busy"><Spinner label="Loading positions…" /></div>
  if (!positions.length)
    return (
      <Empty title="No DAMM v2 positions yet">
        <p>Once you create a pool (or provide liquidity on any tool that uses DAMM v2) it will show up here.</p>
      </Empty>
    )

  return (
    <div className="poslist">
      {positions.map((p, i) => (
        <PositionCard
          key={p.position.toBase58()}
          p={p}
          decimalsByMint={decimalsByMint}
          network={network}
          onAction={setAction}
        />
      ))}
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

function PositionCard({ p, decimalsByMint, network, onAction }) {
  const dA = decimalsByMint[p.poolState.tokenAMint.toBase58()] ?? 9
  const dB = decimalsByMint[p.poolState.tokenBMint.toBase58()] ?? 9
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
          <span className="muted">Token A</span>
          <div>
            <Amount value={p.poolState.tokenAAmount} decimals={dA} precision={2} />
          </div>
        </div>
        <div>
          <span className="muted">Token B</span>
          <div>
            {p.poolState.tokenBMint.equals(WSOL) ? (
              <Amount value={p.poolState.tokenBAmount} decimals={dB} precision={2} symbol="SOL" />
            ) : (
              <Amount value={p.poolState.tokenBAmount} decimals={dB} precision={2} />
            )}
          </div>
        </div>
        <div>
          <span className="muted">Price (1 A = … B)</span>
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

/* ------------------------------------------------------------- actions */

function PositionAction({ action, sdk, decimalsByMint, onDone }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()
  const p = action.p
  const kind = action.kind
  const dA = decimalsByMint[p.poolState.tokenAMint.toBase58()] ?? 9
  const dB = decimalsByMint[p.poolState.tokenBMint.toBase58()] ?? 9
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(true)
  const [closePos, setClosePos] = useState(true)

  // per-action inputs
  const [pct, setPct] = useState('100')
  const [addSide, setAddSide] = useState('A')
  const [addAmount, setAddAmount] = useState('')
  const [cliffDays, setCliffDays] = useState('0')
  const [periods, setPeriods] = useState('30')
  const [useVesting, setUseVesting] = useState(false)

  const title = {
    withdraw: 'Withdraw liquidity',
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
          slippageBps: 50,
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
  }, [kind, pct, closePos, useVesting, addSide, addAmount, cliffDays, periods])

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
            <Field label="Side">
              <select className="input input--select" value={addSide} onChange={(e) => setAddSide(e.target.value)}>
                <option value="A">Token A</option>
                <option value="B">Token B</option>
              </select>
            </Field>
            <Field label="Amount (UI units)">
              <TextInput value={addAmount} onChange={setAddAmount} placeholder="e.g. 1000" />
            </Field>
          </div>
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
