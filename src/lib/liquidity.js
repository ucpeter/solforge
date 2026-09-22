/**
 * Liquidity — Meteora DAMM v2 (CP-AMM).
 *
 * Every function here is a *plan builder*: it returns a Transaction plus a
 * plain-language description of what that transaction does. Nothing is sent
 * until the user has read the review panel and confirmed, and nothing is ever
 * sent without a simulation first.
 *
 * Facts verified against the SDK source, the program IDL and live accounts
 * (see scripts/devnet-probe.mjs, scripts/order-probe.mjs):
 *
 *  1. `new CpAmm(connection)` has no wallet provider, so `.transaction()`
 *     returns a Transaction with NO feePayer and NO recentBlockhash.
 *     txkit.finalizeTransaction() sets both.
 *  2. `createPool` does NOT reorder the mints you pass. The pool PDA is
 *     canonical (derived from the sorted pair), but tokenA/tokenB in the stored
 *     pool state follow your order — and that order decides which way the price
 *     reads. 33 of 40 sampled live pools store tokenAMint as the LARGER key, so
 *     we canonicalise to that convention and always tell the user which side
 *     their token ended up on.
 *  3. `sdk.permanentLockPosition({ unlockedLiquidity })` passes that value
 *     straight through as the on-chain `permanent_lock_liquidity` argument. The
 *     SDK field name is misleading: it is the amount that gets LOCKED.
 *  4. For Compounding-fee pools "lock everything" is `liquidityDelta -
 *     DEAD_LIQUIDITY` (the SDK does exactly this in its own createPool path).
 *  5. `getMaxAmountWithSlippage(amount, rate)` takes rate in PERCENT
 *     (0.5 = 0.5%), not as a decimal fraction.
 *  6. Config accounts expose the permission bits as `permission` (not
 *     `configPermission`), and `ConfigPermission` only defines
 *     CreatePoolWithoutMintValidation — so configs are selected by
 *     `getStaticConfigs()` (configType 0 + default vault/creator authority).
 *  7. Most live configs are CollectFeeMode.Compounding with a fee time
 *     scheduler and Timestamp activation. BothToken configs also exist.
 */
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  ConfigPermission,
  CpAmm,
  DEAD_LIQUIDITY,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  derivePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  feeNumeratorToBps,
  getBaseFeeModeFromBorshData,
  getCurrentPoint,
  getMaxAmountWithSlippage,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  getTokenProgram,
  getUnClaimLpFee,
  isConfigPermissionAllow,
  isDynamicFeeEnabled,
} from '@meteora-ag/cp-amm-sdk'
import BN from 'bn.js'

export { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
export { CollectFeeMode, ActivationType, DEAD_LIQUIDITY, MIN_SQRT_PRICE, MAX_SQRT_PRICE }

export const WSOL = NATIVE_MINT

/* -------------------------------------------------------------------- sdk */

export function makeSdk(connection) {
  return new CpAmm(connection)
}

/* --------------------------------------------------------------- ordering */

/**
 * Meteora's convention: tokenA is the LARGER mint key. The pool address is the
 * same either way, but the stored A/B labels (and therefore the direction the
 * price reads) follow this order.
 */
export function orderMints(a, b) {
  const cmp = Buffer.compare(a.toBuffer(), b.toBuffer())
  if (cmp === 0) throw new Error('The two mints are the same token.')
  return cmp > 0
    ? { tokenAMint: a, tokenBMint: b, swapped: false }
    : { tokenAMint: b, tokenBMint: a, swapped: true }
}

/** Order two mints and carry their amounts along with them. */
export function orderSide(mintA, amountA, mintB, amountB) {
  const { tokenAMint, tokenBMint, swapped } = orderMints(mintA, mintB)
  return {
    tokenAMint,
    tokenBMint,
    tokenAAmount: swapped ? amountB : amountA,
    tokenBAmount: swapped ? amountA : amountB,
    swapped,
  }
}

export function isNativeSol(mint) {
  return mint.equals(NATIVE_MINT)
}

/** Map the app's token-program choice ('spl' | 'token2022') to a program id. */
export function programIdForChoice(choice) {
  return choice === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}

/* ------------------------------------------------------------- price math */

/**
 * Human price ("1 token A = X token B") → Q64 sqrt price.
 * Decimals matter: this is the only place the 9-vs-6 decimal difference is handled.
 */
export function priceToSqrtPrice(price, decimalsA, decimalsB) {
  const p = Number(price)
  if (!isFinite(p) || p <= 0) throw new Error('Price must be a positive number.')
  return getSqrtPriceFromPrice(p, decimalsA, decimalsB)
}

/** Q64 sqrt price → human price ("1 token A = X token B"). */
export function sqrtPriceToPrice(sqrtPrice, decimalsA, decimalsB) {
  try {
    return getPriceFromSqrtPrice(new BN(sqrtPrice.toString()), decimalsA, decimalsB)
  } catch {
    return null
  }
}

export function formatPrice(n, { significant = 6 } = {}) {
  if (n === null || n === undefined || !isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v === 0) return '0'
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (Math.abs(v) >= 1) return v.toFixed(4)
  if (Math.abs(v) >= 0.0001) return v.toFixed(6)
  // For micro-prices like 0.000000003, show standard decimal notation
  const fixedStr = v.toFixed(10).replace(/0+$/, '')
  return `${fixedStr} (${v.toPrecision(significant).replace(/\.?0+e/, 'e')})`
}

/** Raw units → human string (string math, no float drift). */
export function toUi(raw, decimals, { precision = 4 } = {}) {
  try {
    const d = Number(decimals ?? 0)
    const r = BigInt(String(raw).replace(/[^0-9-]/g, '') || '0')
    const neg = r < 0n
    const a = neg ? -r : r
    const div = 10n ** BigInt(d)
    const whole = a / div
    const frac = (a % div).toString().padStart(d, '0').slice(0, precision).replace(/0+$/, '')
    const s = d === 0 ? whole.toString() : `${whole}.${frac || '0'}`
    return (neg ? '-' : '') + s
  } catch {
    return '—'
  }
}

/* ---------------------------------------------------------------- slippage */

/** Slippage tolerance is stored in basis points; the SDK wants percent. */
export function bpsToPercent(bps) {
  return Number(bps) / 100
}

export function maxWithSlippage(amount, slippageBps) {
  const bn = new BN(amount.toString())
  if (!slippageBps) return bn
  return getMaxAmountWithSlippage(bn, bpsToPercent(slippageBps))
}

export function minWithSlippage(amount, slippageBps) {
  const bn = new BN(amount.toString())
  if (!slippageBps) return bn
  return bn.mul(new BN(10000 - Number(slippageBps))).div(new BN(10000))
}

/* ----------------------------------------------------------------- configs */

export const COLLECT_FEE_MODE_LABEL = {
  [CollectFeeMode.BothToken]: 'Fees paid out in both tokens',
  [CollectFeeMode.OnlyB]: 'Fees paid out in token B only',
  [CollectFeeMode.Compounding]: 'Fees compound into the position',
}

export const ACTIVATION_TYPE_LABEL = {
  [ActivationType.Slot]: 'Slot-based activation',
  [ActivationType.Timestamp]: 'Timestamp-based activation',
}

const BASE_FEE_MODE_LABEL = {
  [BaseFeeMode.FeeTimeSchedulerLinear]: 'Fee falls over time (linear)',
  [BaseFeeMode.FeeTimeSchedulerExponential]: 'Fee falls over time (exponential)',
  [BaseFeeMode.RateLimiter]: 'Rate-limited dynamic fee',
  [BaseFeeMode.FeeMarketCapSchedulerLinear]: 'Fee follows market cap (linear)',
  [BaseFeeMode.FeeMarketCapSchedulerExponential]: 'Fee follows market cap (exponential)',
}

/** Turn a decoded ConfigState into something a human can compare. */
export function describeConfig(config) {
  const state = config?.account ?? config
  const collectFeeMode = Number(state?.collectFeeMode ?? 0)
  const activationType = Number(state?.activationType ?? 0)
  let baseFeeMode = null
  let baseFeeModeLabel = 'Fee schedule not decoded'
  try {
    baseFeeMode = getBaseFeeModeFromBorshData(Buffer.from(state.poolFees.baseFee.data))
    baseFeeModeLabel = BASE_FEE_MODE_LABEL[baseFeeMode] ?? `Fee mode ${baseFeeMode}`
  } catch {
    /* leave the honest fallback label */
  }

  const dynamicFee = Boolean(state?.poolFees?.dynamicFee && isDynamicFeeEnabled(state.poolFees.dynamicFee))

  // First 8 bytes of the base-fee blob are the cliff/starting fee numerator for
  // the time-scheduler modes. Anything else is labelled rather than guessed.
  let startingFeeBps = null
  try {
    if (
      baseFeeMode === BaseFeeMode.FeeTimeSchedulerLinear ||
      baseFeeMode === BaseFeeMode.FeeTimeSchedulerExponential
    ) {
      const buf = Buffer.from(state.poolFees.baseFee.data)
      startingFeeBps = feeNumeratorToBps(new BN(buf.readBigUInt64LE(0).toString()))
    }
  } catch {
    startingFeeBps = null
  }

  const permission = new BN((state?.permission ?? 0).toString())
  const skipsMintValidation = isConfigPermissionAllow(permission, ConfigPermission.CreatePoolWithoutMintValidation)

  return {
    address: (config?.publicKey ?? config?.address)?.toString?.() ?? String(config?.publicKey ?? ''),
    collectFeeMode,
    collectFeeModeLabel: COLLECT_FEE_MODE_LABEL[collectFeeMode] ?? `Mode ${collectFeeMode}`,
    activationType,
    activationTypeLabel: ACTIVATION_TYPE_LABEL[activationType] ?? `Type ${activationType}`,
    baseFeeMode,
    baseFeeModeLabel,
    startingFeeBps,
    dynamicFee,
    protocolFeePercent: Number(state?.poolFees?.protocolFeePercent ?? 0),
    referralFeePercent: Number(state?.poolFees?.referralFeePercent ?? 0),
    compoundingFeeBps: Number(state?.poolFees?.compoundingFeeBps ?? 0),
    sqrtMinPrice: new BN(state?.sqrtMinPrice?.toString?.() ?? '0'),
    sqrtMaxPrice: new BN(state?.sqrtMaxPrice?.toString?.() ?? MAX_SQRT_PRICE.toString()),
    skipsMintValidation,
    state,
  }
}

/**
 * Static (permissionless) configs only. Sorted so the plain two-sided
 * BothToken configs come first, then Compounding, then everything else.
 */
export async function listPoolConfigs(connection, sdk = makeSdk(connection)) {
  const raw = await sdk.getStaticConfigs()
  const described = raw.map(describeConfig)
  const rank = (c) => (c.collectFeeMode === CollectFeeMode.BothToken ? 0 : c.collectFeeMode === CollectFeeMode.Compounding ? 1 : 2)
  described.sort((a, b) => rank(a) - rank(b) || (a.startingFeeBps ?? 999) - (b.startingFeeBps ?? 999))
  return described
}

/** Best-effort honest fee summary for an existing pool. */
export async function describePoolFees(sdk, pool) {
  try {
    const decoded = await sdk.fetchPoolFees(new PublicKey(pool))
    if (!decoded) return null
    const nums = Object.entries(decoded)
      .filter(([, v]) => BN.isBN(v) || typeof v === 'number' || typeof v === 'bigint')
      .map(([k, v]) => ({ field: k, value: new BN(v.toString()).toString() }))
    const feeFields = nums
      .filter((n) => /numerator/i.test(n.field))
      .map((n) => ({ label: n.field, bps: feeNumeratorToBps(new BN(n.value)) }))
    return { decoded, feeFields }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ pools */

export async function fetchPoolState(sdk, pool) {
  const state = await sdk.fetchPoolState(new PublicKey(pool))
  if (!state) throw new Error('That pool account does not exist.')
  return state
}

/** All DAMM v2 pools containing a given mint (either side). */
export async function findPoolsForMint(sdk, mint) {
  try {
    return await sdk.fetchPoolStatesByTokenMint(new PublicKey(mint))
  } catch {
    return []
  }
}

export function tokenProgramOf(poolState, side) {
  try {
    return getTokenProgram(Number(side === 'A' ? poolState.tokenAFlag : poolState.tokenBFlag))
  } catch {
    return TOKEN_PROGRAM_ID
  }
}

export function poolPrice(poolState, decimalsA, decimalsB) {
  return sqrtPriceToPrice(poolState.sqrtPrice, decimalsA, decimalsB)
}

/** Liquidity totals for a position, in Q64 units. */
export function positionLiquidity(positionState) {
  const unlocked = new BN(positionState.unlockedLiquidity?.toString() ?? '0')
  const vested = new BN(positionState.vestedLiquidity?.toString() ?? '0')
  const locked = new BN(positionState.permanentLockedLiquidity?.toString() ?? '0')
  return { unlocked, vested, permanentlyLocked: locked, total: unlocked.add(vested).add(locked) }
}

/**
 * "Lock everything" for a permanent lock: Compounding pools must keep
 * DEAD_LIQUIDITY withdrawable, exactly as the SDK's own createPool path does.
 */
export function lockableLiquidity(positionState, poolState) {
  const { unlocked } = positionLiquidity(positionState)
  if (Number(poolState?.collectFeeMode ?? 0) === CollectFeeMode.Compounding) {
    const keep = DEAD_LIQUIDITY
    return unlocked.gt(keep) ? unlocked.sub(keep) : new BN(0)
  }
  return unlocked
}

/* ------------------------------------------------------------ create pool */

/**
 * Build the create-pool transaction.
 *
 * @param {object} p
 * @param {Connection} p.connection
 * @param {CpAmm}    [p.sdk]
 * @param {PublicKey} p.payer           wallet paying for everything
 * @param {PublicKey} p.config          static config account
 * @param {PublicKey} p.tokenMint       the token being launched
 * @param {BN|string} p.tokenAmount     raw units of the token to deposit
 * @param {BN|string} p.quoteAmount     raw units of SOL (or other quote) to deposit
 * @param {PublicKey} [p.quoteMint]     defaults to wrapped SOL
 * @param {number}    p.tokenDecimals
 * @param {number}    p.quoteDecimals
 * @param {boolean}   [p.lockLiquidity] permanently lock the initial position
 * @param {BN|null}   [p.activationPoint]
 * @param {number}    [p.slippageBps]
 */
export async function planCreatePool({
  connection,
  sdk = makeSdk(connection),
  payer,
  config,
  tokenMint,
  tokenAmount,
  quoteMint = NATIVE_MINT,
  quoteAmount,
  tokenDecimals,
  quoteDecimals,
  tokenProgram = TOKEN_PROGRAM_ID,
  quoteProgram = TOKEN_PROGRAM_ID,
  lockLiquidity = false,
  activationPoint = null,
  slippageBps = 0,
}) {
  const configState = await sdk.fetchConfigState(new PublicKey(config))
  if (!configState) throw new Error('That pool config account does not exist.')
  const described = describeConfig({ account: configState, publicKey: new PublicKey(config) })

  const tokenAmt = new BN(tokenAmount.toString())
  const quoteAmt = new BN(quoteAmount.toString())
  if (tokenAmt.lte(new BN(0)) || quoteAmt.lte(new BN(0))) {
    throw new Error('Both sides of the initial deposit must be greater than zero.')
  }

  // Canonical A/B ordering (verified convention: A is the larger mint key).
  const side = orderSide(new PublicKey(tokenMint), tokenAmt, new PublicKey(quoteMint), quoteAmt)
  const { tokenAMint, tokenBMint, tokenAAmount, tokenBAmount, swapped } = side

  const decimalsA = swapped ? quoteDecimals : tokenDecimals
  const decimalsB = swapped ? tokenDecimals : quoteDecimals

  // Price of one unit of A expressed in B, decimal-adjusted.
  // Decimal-adjusted price, for display only ("1 token = X quote").
  const priceAinB =
    Number(tokenBAmount.toString()) /
    10 ** decimalsB /
    (Number(tokenAAmount.toString()) / 10 ** decimalsA)

  // preparePoolCreationParams derives initSqrtPrice from the raw amounts
  // (calculateInitSqrtPrice: price = rawB / rawA) and sizes the liquidity from
  // the binding side. We use ITS initSqrtPrice — the SDK's own value — rather
  // than recomputing, so rounding can never disagree with the math.
  const prepared = sdk.preparePoolCreationParams({
    tokenAAmount,
    tokenBAmount,
    minSqrtPrice: configState.sqrtMinPrice,
    maxSqrtPrice: configState.sqrtMaxPrice,
    collectFeeMode: configState.collectFeeMode,
  })
  const { initSqrtPrice } = prepared
  const liquidityDelta = prepared.liquidityDelta

  if (!liquidityDelta || liquidityDelta.lte(DEAD_LIQUIDITY)) {
    throw new Error(
      'That deposit is too small for this pool config — the resulting liquidity would be at or below the protocol minimum. Increase the amounts.'
    )
  }

  const positionNft = Keypair.generate()
  const positionNftAccount = derivePositionNftAccount(positionNft.publicKey)
  const pool = derivePoolAddress(new PublicKey(config), tokenAMint, tokenBMint)
  const position = derivePositionAddress(positionNft.publicKey)

  const tx = await sdk.createPool({
    payer,
    creator: payer,
    config: new PublicKey(config),
    positionNft: positionNft.publicKey,
    tokenAMint,
    tokenBMint,
    initSqrtPrice,
    liquidityDelta,
    tokenAAmount: maxWithSlippage(tokenAAmount, slippageBps),
    tokenBAmount: maxWithSlippage(tokenBAmount, slippageBps),
    activationPoint: activationPoint ? new BN(activationPoint.toString()) : null,
    tokenAProgram: swapped ? quoteProgram : tokenProgram,
    tokenBProgram: swapped ? tokenProgram : quoteProgram,
    isLockLiquidity: Boolean(lockLiquidity),
  })

  const tokenASymbol = swapped ? 'quote' : 'token'
  const tokenBSymbol = swapped ? 'token' : 'quote'

  const notes = [
    `Creates a Meteora DAMM v2 pool for ${tokenAMint.toBase58().slice(0, 6)}… / ${tokenBMint.toBase58().slice(0, 6)}…`,
    swapped
      ? 'Your token is side B of this pair (Meteora stores the larger mint address as A).'
      : 'Your token is side A of this pair.',
    `Initial price: 1 ${tokenASymbol} = ${formatPrice(priceAinB)} ${tokenBSymbol}.`,
    described.collectFeeModeLabel + '.',
    described.baseFeeModeLabel + (described.startingFeeBps !== null ? ` — starts at ${(described.startingFeeBps / 100).toString()}%` : '') + '.',
    lockLiquidity
      ? 'The initial LP position is PERMANENTLY locked in the same transaction. This cannot be undone.'
      : 'You keep the initial LP position and can withdraw it later.',
    'A new position-NFT mint keypair is generated locally and signs this transaction; it never leaves your browser.',
  ]

  return {
    tx,
    pool,
    position,
    positionNft,
    positionNftAccount,
    signerKeypairs: [positionNft],
    tokenAMint,
    tokenBMint,
    tokenAAmount,
    tokenBAmount,
    decimalsA,
    decimalsB,
    initSqrtPrice,
    liquidityDelta,
    priceAinB,
    swapped,
    config: described,
    lockLiquidity: Boolean(lockLiquidity),
    notes,
    steps: [
      {
        title: 'Create the pool',
        detail: `Deposit ${tokenAAmount.toString()} (A) and ${tokenBAmount.toString()} (B) raw units.`,
      },
      ...(lockLiquidity
        ? [{ title: 'Permanently lock the position', detail: 'Runs in the same transaction.' }]
        : []),
    ],
  }
}

/* ---------------------------------------------------------- add liquidity */

export async function planAddLiquidity({
  connection,
  sdk = makeSdk(connection),
  owner,
  pool,
  positionNftMint,
  inAmount,
  inIsTokenA,
  slippageBps = 50,
}) {
  const poolState = await fetchPoolState(sdk, pool)
  const nftMint = new PublicKey(positionNftMint)
  const position = derivePositionAddress(nftMint)
  const positionState = await sdk.fetchPositionState(position)
  if (!positionState) throw new Error('Position account not found.')

  const quote = sdk.getDepositQuote({
    inAmount: new BN(inAmount.toString()),
    isTokenA: Boolean(inIsTokenA),
    minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice,
    sqrtPrice: poolState.sqrtPrice,
    collectFeeMode: poolState.collectFeeMode,
    tokenAAmount: poolState.tokenAAmount,
    tokenBAmount: poolState.tokenBAmount,
    liquidity: poolState.liquidity,
  })

  const amountA = inIsTokenA ? quote.actualInputAmount : quote.outputAmount
  const amountB = inIsTokenA ? quote.outputAmount : quote.actualInputAmount

  const tx = await sdk.addLiquidity({
    owner,
    position,
    pool: new PublicKey(pool),
    positionNftAccount: derivePositionNftAccount(nftMint),
    liquidityDelta: quote.liquidityDelta,
    maxAmountTokenA: maxWithSlippage(amountA, slippageBps),
    maxAmountTokenB: maxWithSlippage(amountB, slippageBps),
    tokenAAmountThreshold: minWithSlippage(amountA, slippageBps),
    tokenBAmountThreshold: minWithSlippage(amountB, slippageBps),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgramOf(poolState, 'A'),
    tokenBProgram: tokenProgramOf(poolState, 'B'),
  })

  return {
    tx,
    pool: new PublicKey(pool),
    position,
    positionNftMint: nftMint,
    signerKeypairs: [],
    liquidityDelta: quote.liquidityDelta,
    amountA,
    amountB,
    maxA: maxWithSlippage(amountA, slippageBps),
    maxB: maxWithSlippage(amountB, slippageBps),
    notes: [
      `Adds liquidity to pool ${pool.toString().slice(0, 8)}…`,
      `You supply up to ${maxWithSlippage(amountA, slippageBps).toString()} of A and ${maxWithSlippage(amountB, slippageBps).toString()} of B (raw units).`,
      `Slippage tolerance ${Number(slippageBps) / 100}%.`,
      'The SDK wraps/unwraps SOL and creates missing token accounts for you.',
    ],
  }
}

/* ------------------------------------------------------- remove liquidity */

/**
 * Withdraw liquidity from a position.
 *
 * `percent` of the currently UNLOCKED liquidity (1–100). At 100% the SDK's
 * removeAllLiquidity / removeAllLiquidityAndClosePosition are used; below 100%
 * the program's partial removeLiquidity with a proportional liquidityDelta.
 *
 * Either way the withdrawn tokens go to the OWNER's own token accounts (the
 * SDK derives your ATAs), and if the pair contains SOL it is unwrapped back
 * to native SOL in the same transaction. `closePosition` is only honoured at
 * 100% (a partially filled position must stay open to keep earning fees).
 */
export async function planRemoveLiquidity({
  connection,
  sdk = makeSdk(connection),
  owner,
  pool,
  positionNftMint,
  percent = 100,
  slippageBps = 50,
  closePosition = false,
}) {
  const pct = Math.floor(Number(percent))
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
    throw new Error('Withdrawal percentage must be between 1 and 100.')
  }

  const poolState = await fetchPoolState(sdk, pool)
  const nftMint = new PublicKey(positionNftMint)
  const position = derivePositionAddress(nftMint)
  const positionState = await sdk.fetchPositionState(position)
  if (!positionState) throw new Error('Position account not found.')

  const liq = positionLiquidity(positionState)
  if (liq.unlocked.isZero()) {
    throw new Error('This position has no unlocked liquidity to withdraw.')
  }

  const full = pct === 100
  const liquidityDelta = full ? liq.unlocked : liq.unlocked.mul(new BN(pct)).div(new BN(100))
  if (liquidityDelta.isZero()) {
    throw new Error(`That percentage of ${liq.unlocked.toString()} liquidity rounds to zero. Use a larger percentage.`)
  }

  const currentPoint = await getCurrentPoint(connection, poolState.activationType)
  const vestings = await sdk.getAllVestingsByPosition(position)
  const vestingAccounts = vestings.map((v) => ({
    account: v.publicKey ?? v.account,
    vestingState: v.vestingState ?? v.state,
  }))

  const quote = sdk.getWithdrawQuote({
    liquidityDelta,
    minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice,
    sqrtPrice: poolState.sqrtPrice,
    collectFeeMode: poolState.collectFeeMode,
    tokenAAmount: poolState.tokenAAmount,
    tokenBAmount: poolState.tokenBAmount,
    liquidity: poolState.liquidity,
  })

  const nftAccount = derivePositionNftAccount(nftMint)
  const shared = {
    owner,
    position,
    pool: new PublicKey(pool),
    positionNftAccount: nftAccount,
    tokenAAmountThreshold: minWithSlippage(quote.outAmountA, slippageBps),
    tokenBAmountThreshold: minWithSlippage(quote.outAmountB, slippageBps),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgramOf(poolState, 'A'),
    tokenBProgram: tokenProgramOf(poolState, 'B'),
    vestings: vestingAccounts,
    currentPoint,
  }

  let tx
  if (full && closePosition) {
    tx = await sdk.removeAllLiquidityAndClosePosition({ ...shared, poolState, positionState })
  } else if (full) {
    tx = await sdk.removeAllLiquidity(shared)
  } else {
    tx = await sdk.removeLiquidity({ ...shared, liquidityDelta })
  }

  const notes = [
    `Withdraws ${full ? 'ALL' : `${pct}% of`} the unlocked liquidity from position ${position.toString().slice(0, 8)}…`,
    `Expected out: ${quote.outAmountA.toString()} A and ${quote.outAmountB.toString()} B (raw units).`,
    'The withdrawn tokens go to YOUR OWN token accounts; SOL is unwrapped back to your wallet in the same transaction.',
    full
      ? closePosition
        ? 'The position NFT is burned and its rent is returned to you.'
        : 'The position stays open (any permanently locked liquidity remains locked).'
      : `The position stays open with ${liq.unlocked.sub(liquidityDelta).toString()} liquidity units still working.`,
    liq.permanentlyLocked.isZero()
      ? ''
      : `WARNING: ${liq.permanentlyLocked.toString()} liquidity units are permanently locked and can never be withdrawn.`,
  ].filter(Boolean)

  return {
    tx,
    pool: new PublicKey(pool),
    position,
    signerKeypairs: [],
    percent: pct,
    full,
    outA: quote.outAmountA,
    outB: quote.outAmountB,
    minA: minWithSlippage(quote.outAmountA, slippageBps),
    minB: minWithSlippage(quote.outAmountB, slippageBps),
    liquidityRemoved: liquidityDelta,
    notes,
  }
}

/* ---------------------------------------------------------------- locking */

/**
 * Permanently lock liquidity. `amount` is the quantity to LOCK — the SDK's
 * parameter is misleadingly named `unlockedLiquidity` but is passed straight to
 * the on-chain `permanent_lock_liquidity` argument.
 */
export async function planPermanentLock({
  connection,
  sdk = makeSdk(connection),
  owner,
  pool,
  positionNftMint,
  amount,
}) {
  const nftMint = new PublicKey(positionNftMint)
  const position = derivePositionAddress(nftMint)
  const lockAmount = new BN(amount.toString())
  const poolState = await fetchPoolState(sdk, pool)
  const positionState = await sdk.fetchPositionState(position)
  const available = lockableLiquidity(positionState, poolState)
  if (lockAmount.gt(available)) {
    throw new Error(
      `You asked to lock ${lockAmount.toString()} but only ${available.toString()} liquidity units are lockable in this position.`
    )
  }

  const tx = await sdk.permanentLockPosition({
    owner,
    position,
    positionNftAccount: derivePositionNftAccount(nftMint),
    pool: new PublicKey(pool),
    unlockedLiquidity: lockAmount, // see file header, fact 3
  })

  return {
    tx,
    pool: new PublicKey(pool),
    position,
    signerKeypairs: [],
    lockAmount,
    remainingUnlocked: available.sub(lockAmount),
    notes: [
      `PERMANENTLY locks ${lockAmount.toString()} liquidity units in position ${position.toString().slice(0, 8)}…`,
      'This cannot be reversed. Locked liquidity can never be withdrawn by anyone, including you.',
      'You can still collect trading fees earned by the locked liquidity.',
    ],
  }
}

/** Time-based (vesting) lock — reversible as the schedule unlocks. */
export async function planVestingLock({
  connection,
  sdk = makeSdk(connection),
  owner,
  payer,
  pool,
  positionNftMint,
  cliffSeconds,
  periodSeconds,
  numberOfPeriods,
  cliffUnlockLiquidity = new BN(0),
}) {
  const nftMint = new PublicKey(positionNftMint)
  const position = derivePositionAddress(nftMint)
  const poolState = await fetchPoolState(sdk, pool)
  const positionState = await sdk.fetchPositionState(position)
  const currentPoint = await getCurrentPoint(connection, poolState.activationType)

  const periods = Math.max(1, Number(numberOfPeriods))
  const unlocked = positionLiquidity(positionState).unlocked
  const perPeriod = unlocked.div(new BN(periods))
  if (perPeriod.isZero() && cliffUnlockLiquidity.toString() === '0') {
    throw new Error('Nothing to lock: this position has no unlocked liquidity.')
  }

  const activationIsTimestamp = Number(poolState.activationType) === ActivationType.Timestamp
  const unit = activationIsTimestamp ? 'seconds' : 'slots'

  const tx = await sdk.lockPosition({
    owner,
    payer: payer ?? owner,
    pool: new PublicKey(pool),
    position,
    positionNftAccount: derivePositionNftAccount(nftMint),
    cliffPoint: currentPoint.add(new BN(cliffSeconds)),
    periodFrequency: new BN(periodSeconds),
    cliffUnlockLiquidity: new BN(cliffUnlockLiquidity.toString()),
    liquidityPerPeriod: perPeriod,
    numberOfPeriod: periods,
    innerPosition: true,
  })

  return {
    tx,
    pool: new PublicKey(pool),
    position,
    signerKeypairs: [],
    notes: [
      `Locks ${unlocked.toString()} liquidity units with a vesting schedule.`,
      `Cliff after ${cliffSeconds} ${unit}, then ${perPeriod.toString()} units unlock every ${periodSeconds} ${unit} for ${periods} periods.`,
      'Vesting locks are not permanent: liquidity becomes withdrawable as the schedule runs.',
    ],
  }
}

/* ------------------------------------------------------------------- fees */

export async function planClaimFees({ connection, sdk = makeSdk(connection), owner, pool, positionNftMint }) {
  const poolState = await fetchPoolState(sdk, pool)
  const nftMint = new PublicKey(positionNftMint)
  const position = derivePositionAddress(nftMint)
  const positionState = await sdk.fetchPositionState(position)
  if (!positionState) throw new Error('Position account not found.')

  const pending = getUnClaimLpFee(poolState, positionState)

  const tx = await sdk.claimPositionFee({
    owner,
    position,
    pool: new PublicKey(pool),
    positionNftAccount: derivePositionNftAccount(nftMint),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgramOf(poolState, 'A'),
    tokenBProgram: tokenProgramOf(poolState, 'B'),
  })

  return {
    tx,
    pool: new PublicKey(pool),
    position,
    signerKeypairs: [],
    feeA: pending.feeTokenA,
    feeB: pending.feeTokenB,
    notes: [
      `Claims trading fees for position ${position.toString().slice(0, 8)}…`,
      `Pending: ${pending.feeTokenA.toString()} of token A and ${pending.feeTokenB.toString()} of token B (raw units).`,
      'Fees are sent to your own token accounts. SOL fees arrive as wrapped SOL and are unwrapped in the same transaction.',
    ],
  }
}

/* ------------------------------------------------------------------ reads */

/**
 * Every DAMM v2 position the wallet owns, enriched with the pool it belongs to.
 * Uses the SDK's own resolver, which never scans the program's pool accounts.
 */
export async function readUserPositions(connection, sdk = makeSdk(connection), user) {
  const found = await sdk.getPositionsByUser(new PublicKey(user))
  const out = []
  for (const f of found) {
    try {
      const pool = f.positionState.pool
      const poolState = await sdk.fetchPoolState(pool)
      const liq = positionLiquidity(f.positionState)
      const pending = getUnClaimLpFee(poolState, f.positionState)
      out.push({
        positionNftMint: f.positionState.nftMint,
        positionNftAccount: f.positionNftAccount,
        position: f.position,
        positionState: f.positionState,
        pool,
        poolState,
        liquidity: liq,
        pendingFees: { a: pending.feeTokenA, b: pending.feeTokenB },
        isPermanentlyLocked: sdk.isPermanentLockedPosition(f.positionState),
        isLocked: sdk.isLockedPosition(f.positionState),
      })
    } catch {
      /* skip positions whose pool we cannot read */
    }
  }
  return out
}

export async function readPositionsForMint(connection, sdk = makeSdk(connection), user, mint) {
  const found = await sdk.getPositionsByUserAndTokenMint(new PublicKey(user), new PublicKey(mint))
  return found.map((f) => ({
    positionNftMint: f.positionState.nftMint,
    positionNftAccount: f.positionNftAccount,
    position: f.position,
    positionState: f.positionState,
    pool: f.pool,
    poolState: f.poolState,
    liquidity: positionLiquidity(f.positionState),
  }))
}
