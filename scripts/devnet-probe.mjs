/**
 * Devnet integration probe.
 *
 * Runs the *actual* library code end-to-end on devnet with a locally generated
 * keypair, so the browser app is not shipping unverified instruction builders.
 *
 *   1. airdrop devnet SOL
 *   2. create a token (legacy SPL + Metaplex, incl. the token_standard append)
 *   3. create a Token-2022 token
 *   4. list Meteora DAMM v2 static configs
 *   5. determine which mint ordering the cp-amm program accepts
 *   6. create a pool, add liquidity, permanent-lock, claim fees, remove
 *
 * Usage: node scripts/devnet-probe.mjs [--skip-airdrop <pubkey>]
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  CpAmm,
  CollectFeeMode,
  getSqrtPriceFromPrice,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  derivePoolAddress,
  derivePositionNftAccount,
  ConfigPermission,
  isConfigPermissionAllow,
  getCurrentPoint,
  ActivationType,
} from '@meteora-ag/cp-amm-sdk'
import BN from 'bn.js'
import { readFileSync } from 'node:fs'

import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import { PROGRAM } from '../src/lib/programs.js'
import {
  listPoolConfigs,
  planCreatePool,
  planPermanentLock,
  planClaimFees,
  readUserPositions,
  lockableLiquidity,
  sqrtPriceToPrice,
} from '../src/lib/liquidity.js'
import { describeInstruction, estimateComputeUnits, finalizeTransaction, simulateTransaction } from '../src/lib/txkit.js'

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')

const log = (...a) => console.log(...a)
const hr = (t) => log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`)

async function airdrop(keypair, targetSol = 2) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const balance = await connection.getBalance(keypair.publicKey)
    if (balance >= targetSol * LAMPORTS_PER_SOL) {
      log(`  already funded: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
      return balance
    }
    const want = Math.min(1, targetSol - balance / LAMPORTS_PER_SOL) * LAMPORTS_PER_SOL
    try {
      log(`  airdrop attempt ${attempt}: requesting ${want / LAMPORTS_PER_SOL} SOL …`)
      const sig = await connection.requestAirdrop(keypair.publicKey, want)
      await connection.confirmTransaction(sig, 'confirmed')
      log(`  ✓ airdropped (${sig.slice(0, 12)}…)`)
    } catch (err) {
      log(`  ✗ ${err.message?.slice(0, 110)}`)
    }
    await new Promise((r) => setTimeout(r, 4000))
  }
  return connection.getBalance(keypair.publicKey)
}

async function sendWithKeypair(tx, signers = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = signers[0]?.publicKey ?? tx.feePayer
  const cu = await estimateComputeUnits(connection, tx, 400_000)
  const rebuilt = await finalizeTransaction(connection, tx, {
    payer: tx.feePayer,
    cuLimit: cu,
    priorityFeeMicroLamports: 20_000,
  })
  rebuilt.sign(...signers)
  const sim = await simulateTransaction(connection, rebuilt)
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error}\n${sim.logs?.slice(-6).join('\n')}`)
  const sig = await connection.sendRawTransaction(rebuilt.serialize(), { skipPreflight: false, maxRetries: 5 })
  await connection.confirmTransaction({ signature: sig, blockhash: rebuilt.recentBlockhash, lastValidBlockHeight: rebuilt.lastValidBlockHeight }, 'confirmed')
  return sig
}

async function createToken(keypair, { name, symbol, tokenProgram, supply = '1000000', decimals = 9, revokeMint = false, revokeFreeze = false }) {
  const plan = await buildTokenCreation(connection, {
    payer: keypair.publicKey,
    form: {
      name,
      symbol,
      decimals,
      supply,
      tokenProgram,
      revokeMint,
      revokeFreeze,
      metadataImmutable: false,
      renounceMetadataUpdate: false,
    },
    metadataUri: 'https://raw.githubusercontent.com/solflare-wallet/token-list/main/tokens/demo.json',
  })
  const txs = packInstructions(plan.instructions)
  log(`  program=${tokenProgram}  instructions=${plan.instructions.length}  transactions=${txs.length}`)
  log(`  rent: mint=${plan.rent.mint} ata=${plan.rent.ata} metadata≈${plan.rent.metadata}`)
  for (const d of plan.instructions.map(describeInstruction)) log(`   • ${d.action}`)
  const sig = await sendWithKeypair(txs[0], [keypair, plan.mintKeypair])
  log(`  ✓ mint ${plan.mint.toBase58()}  tx ${sig.slice(0, 16)}…`)
  return plan
}

async function main() {
  hr('STEP 1 — keypair + devnet airdrop')
  let wallet
  let balance
  if (process.env.PAYER_KEYPAIR) {
    const raw = JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, 'utf8'))
    wallet = Keypair.fromSecretKey(Uint8Array.from(raw))
    log(`  wallet (from ${process.env.PAYER_KEYPAIR}): ${wallet.publicKey.toBase58()}`)
    balance = await connection.getBalance(wallet.publicKey)
  } else {
    wallet = Keypair.generate()
    log(`  wallet: ${wallet.publicKey.toBase58()}`)
    balance = await airdrop(wallet, 1.5)
  }
  log(`  balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    log('\n!! Devnet faucet is rate-limiting. Cannot run the on-chain steps.')
    log('!! Re-run later, or fund this address manually: ' + wallet.publicKey.toBase58())
    process.exit(2)
  }

  hr('STEP 2 — create an SPL Token (legacy) + Metaplex metadata')
  const legacy = await createToken(wallet, { name: 'SolForge Probe', symbol: 'PROBE', tokenProgram: 'spl', supply: '1000000000' })

  hr('STEP 3 — create a Token-2022 token with native metadata')
  let token2022 = null
  try {
    token2022 = await createToken(wallet, { name: 'SolForge 2022', symbol: 'P22', tokenProgram: 'token2022', supply: '1000000', revokeFreeze: true })
  } catch (err) {
    log(`  ✗ Token-2022 path failed: ${err.message?.slice(0, 300)}`)
  }

  hr('STEP 4 — verify metadata on chain')
  try {
    const metaplex = new PublicKey(PROGRAM.metaplexMetadata)
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), metaplex.toBuffer(), legacy.mint.toBuffer()], metaplex)
    const info = await connection.getAccountInfo(pda)
    log(`  metadata account ${pda.toBase58()}`)
    log(`  exists=${!!info}  lamports=${info?.lamports}  dataLen=${info?.data?.length}`)
    if (info?.data) {
      // Layout: key(1) + updateAuthority(32) + mint(32), then DataV2 strings.
      const buf = info.data
      let off = 1 + 32 + 32
      const readStr = () => {
        const len = buf.readUInt32LE(off)
        off += 4
        const str = buf.subarray(off, off + len).toString('utf8')
        off += len
        return str
      }
      log(`  name="${readStr()}" symbol="${readStr()}" uri="${readStr().slice(0, 60)}…"`)
      log(`  sellerFeeBps=${buf.readUInt16LE(off)}`)
    }
  } catch (err) {
    log(`  ✗ metadata read failed: ${err.message}`)
  }

  hr('STEP 5 — pool configs (via liquidity.js)')
  const sdk = new CpAmm(connection)
  const configs = await listPoolConfigs(connection)
  log(`  ${configs.length} static configs, best first:`)
  for (const c of configs.slice(0, 5)) {
    log(`   • ${c.address}  ${c.collectFeeModeLabel}  ${c.activationTypeLabel}  starts ${c.startingFeeBps !== null ? (c.startingFeeBps / 100).toFixed(2) + "%" : "?"}  dyn=${c.dynamicFee}  proto=${c.protocolFeePercent}%`)
  }

  hr('STEP 6 — plan + send pool creation (via liquidity.js)')
  let plan = null
  try {
    plan = await planCreatePool({
      connection,
      payer: wallet.publicKey,
      config: configs[0].address,
      tokenMint: legacy.mint,
      tokenAmount: new BN('1000000000'), // 1 token (9 dec)
      quoteMint: NATIVE_MINT,
      quoteAmount: new BN('1000000000'), // 1 SOL
      tokenDecimals: 9,
      quoteDecimals: 9,
      lockLiquidity: false,
    })
    log(`  pool=${plan.pool.toBase58()}`)
    log(`  side A=${plan.tokenAMint.toBase58().slice(0, 8)}… side B=${plan.tokenBMint.toBase58().slice(0, 8)}… (swapped=${plan.swapped})`)
    log(`  initSqrtPrice=${plan.initSqrtPrice.toString()}  liquidityDelta=${plan.liquidityDelta.toString().slice(0, 16)}…  price=${plan.priceAinB}`)
    for (const n of plan.notes) log(`   • ${n}`)
  } catch (err) {
    log(`  ✗ plan failed: ${err.message?.slice(0, 300)}`)
    process.exit(3)
  }

  const poolSig = await sendWithKeypair(plan.tx, [wallet, plan.positionNft])
  log(`  ✓ pool created  tx ${poolSig.slice(0, 16)}…`)

  const poolState = await sdk.fetchPoolState(plan.pool)
  log(`  on-chain A=${poolState.tokenAMint.toBase58().slice(0, 10)}… B=${poolState.tokenBMint.toBase58().slice(0, 10)}…`)
  log(`  liquidity=${poolState.liquidity.toString().slice(0, 18)}… sqrtPrice=${poolState.sqrtPrice.toString().slice(0, 14)}…`)
  const priceBack = sqrtPriceToPrice(poolState.sqrtPrice, plan.decimalsA, plan.decimalsB)
  log(`  price A→B from chain: ${priceBack}`)
  const orderMatch =
    plan.tokenAMint.equals(poolState.tokenAMint) && plan.tokenBMint.equals(poolState.tokenBMint)
  log(`  ordering matches on-chain: ${orderMatch}`)

  hr('STEP 7 — read user positions (via liquidity.js)')
  const positions = await readUserPositions(connection, sdk, wallet.publicKey)
  log(`  ${positions.length} position(s)`)
  let mine = null
  for (const p of positions) {
    if (!p.pool.equals(plan.pool)) continue
    mine = p
    log(`   • position=${p.position.toBase58().slice(0, 12)}… unlocked=${p.liquidity.unlocked.toString().slice(0, 14)}… permanent=${p.liquidity.permanentlyLocked.toString().slice(0, 14)}…`)
  }
  if (!mine) throw new Error('created position not found for the wallet')

  hr('STEP 8 — permanent lock (via liquidity.js)')
  const lockable = lockableLiquidity(mine.positionState, mine.poolState)
  log(`  lockable (Compounding keeps DEAD_LIQUIDITY): ${lockable.toString().slice(0, 18)}…`)
  const lockPlan = await planPermanentLock({
    connection,
    owner: wallet.publicKey,
    pool: mine.pool,
    positionNftMint: mine.positionNftMint,
    amount: lockable,
  })
  const lockSig = await sendWithKeypair(lockPlan.tx, [wallet])
  log(`  ✓ permanent lock tx ${lockSig.slice(0, 16)}…`)
  const after = await sdk.fetchPositionState(mine.position)
  log(`  unlocked=${after.unlockedLiquidity.toString()}  permanentLocked=${after.permanentLockedLiquidity.toString().slice(0, 18)}…`)

  hr('STEP 9 — claim fees (via liquidity.js, simulate + send)')
  const claimPlan = await planClaimFees({
    connection,
    owner: wallet.publicKey,
    pool: mine.pool,
    positionNftMint: mine.positionNftMint,
  })
  log(`  pending fees: A=${claimPlan.feeA.toString()} B=${claimPlan.feeB.toString()}`)
  const claimSig = await sendWithKeypair(claimPlan.tx, [wallet])
  log(`  ✓ claim fees tx ${claimSig.slice(0, 16)}…`)

  hr('DONE')
  const finalBalance = await connection.getBalance(wallet.publicKey)
  log(`  wallet ${wallet.publicKey.toBase58()}  final balance ${(finalBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
}

main().catch((err) => {
  console.error('PROBE FAILED:', err)
  process.exit(1)
})
