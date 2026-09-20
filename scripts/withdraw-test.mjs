/**
 * On-chain withdrawal test: proves removed liquidity lands in the connected
 * wallet's own accounts (and SOL comes back unwrapped), for BOTH partial and
 * full withdrawals, including position close + rent recovery.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'
import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import {
  listPoolConfigs,
  makeSdk,
  planCreatePool,
  planRemoveLiquidity,
} from '../src/lib/liquidity.js'
import { finalizeTransaction, simulateTransaction } from '../src/lib/txkit.js'

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8899'
const connection = new Connection(RPC, 'confirmed')
const log = (...a) => console.log(...a)

async function send(fin, signers) {
  const sim = await simulateTransaction(connection, fin)
  if (!sim.ok) throw new Error(`sim failed: ${sim.error}\n${(sim.logs || []).slice(-8).join('\n')}`)
  fin.sign(...signers)
  const sig = await connection.sendRawTransaction(fin.serialize(), { skipPreflight: false, maxRetries: 5 })
  await connection.confirmTransaction({ signature: sig, blockhash: fin.recentBlockhash, lastValidBlockHeight: fin.lastValidBlockHeight }, 'confirmed')
  return sig
}

function lam(v) { return Number(v) }

async function solBal(pk) { return lam(await connection.getBalance(pk)) }
async function tokenBal(ata) { const a = await getAccount(connection, ata); return lam(a.amount) }

async function main() {
  const wallet = Keypair.generate()
  await connection.requestAirdrop(wallet.publicKey, 10 * LAMPORTS_PER_SOL)
  await new Promise((r) => setTimeout(r, 2500))
  log(`wallet ${wallet.publicKey.toBase58()}`)

  // 1. token
  const plan = await buildTokenCreation(connection, {
    payer: wallet.publicKey,
    form: { name: 'Wd Token', symbol: 'WDT', decimals: 9, supply: '2000000000', tokenProgram: 'spl', revokeMint: true, revokeFreeze: true, metadataImmutable: false, renounceMetadataUpdate: false },
    metadataUri: 'https://example.com/m.json',
  })
  const tx0 = packInstructions(plan.instructions)[0]
  const fin0 = await finalizeTransaction(connection, tx0, { payer: wallet.publicKey })
  const sig0 = await send(fin0, [wallet, plan.mintKeypair])
  log(`token ${plan.mint.toBase58()}  tx ${sig0.slice(0, 14)}…`)

  // 2. pool: 1,000 WDT + 5 SOL  → price 0.005 SOL/WDT
  const sdk = makeSdk(connection)
  const configs = await listPoolConfigs(connection, sdk)
  const poolPlan = await planCreatePool({
    connection,
    sdk,
    payer: wallet.publicKey,
    config: configs[0].address,
    tokenMint: plan.mint,
    tokenAmount: new BN('1000000000000'), // 1,000 WDT (9 dec)
    quoteMint: NATIVE_MINT,
    quoteAmount: new BN('5000000000'), // 5 SOL
    tokenDecimals: 9,
    quoteDecimals: 9,
    lockLiquidity: false,
  })
  const fin1 = await finalizeTransaction(connection, poolPlan.tx, { payer: wallet.publicKey })
  const sig1 = await send(fin1, [wallet, poolPlan.positionNft])
  log(`pool ${poolPlan.pool.toBase58()}  tx ${sig1.slice(0, 14)}…`)

  const tokenAta = getAssociatedTokenAddressSync(plan.mint, wallet.publicKey)
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey)
  const position = poolPlan.position
  const nftMint = poolPlan.positionNft.publicKey

  let posState = await sdk.fetchPositionState(position)
  let unlocked0 = posState.unlockedLiquidity
  log(`position unlocked liquidity = ${unlocked0.toString().slice(0, 16)}…`)
  const solBefore = await solBal(wallet.publicKey)
  const tokBefore = await tokenBal(tokenAta)
  log(`before partial: SOL=${solBefore / 1e9}  WDT=${(tokBefore / 1e9).toFixed(4)}`)

  // 3. PARTIAL withdrawal: 50%
  const part = await planRemoveLiquidity({
    connection,
    sdk,
    owner: wallet.publicKey,
    pool: poolPlan.pool,
    positionNftMint: nftMint,
    percent: 50,
    closePosition: false,
  })
  log('partial notes:', part.notes.join(' | ').slice(0, 200))
  const fin2 = await finalizeTransaction(connection, part.tx, { payer: wallet.publicKey })
  const sig2 = await send(fin2, [wallet])
  log(`partial withdraw tx ${sig2.slice(0, 14)}…`)

  posState = await sdk.fetchPositionState(position)
  const unlocked1 = posState.unlockedLiquidity
  const solAfter = await solBal(wallet.publicKey)
  const tokAfter = await tokenBal(tokenAta)
  const dTok = tokAfter - tokBefore
  const dSol = solAfter - solBefore
  log(`after 50%: WDT received ≈ ${dTok / 1e9} (expect ~500)  SOL received ≈ ${dSol / 1e9} (expect ~2.5 minus fees)`)
  const half = unlocked0.div(new BN(2))
  if (unlocked1.lt(half.sub(new BN(10))) || unlocked1.gt(half.add(new BN(10)))) throw new Error(`liquidity not halved: ${unlocked1.toString()} vs ${half.toString()}`)
  if (dTok < 4.9e11) throw new Error(`token withdrawal too small: ${dTok}`)
  if (dSol < 2.2 * 1e9) throw new Error(`SOL withdrawal too small: ${dSol}`)
  log('✓ PARTIAL WITHDRAWAL VERIFIED — tokens + SOL (unwrapped) landed in the wallet')

  // 4. FULL withdrawal + close position
  const full = await planRemoveLiquidity({
    connection,
    sdk,
    owner: wallet.publicKey,
    pool: poolPlan.pool,
    positionNftMint: nftMint,
    percent: 100,
    closePosition: true,
  })
  const fin3 = await finalizeTransaction(connection, full.tx, { payer: wallet.publicKey })
  const sig3 = await send(fin3, [wallet])
  log(`full withdraw + close tx ${sig3.slice(0, 14)}…`)

  const posAfter = await connection.getAccountInfo(position)
  const nftAfter = await connection.getAccountInfo(nftMint)
  const solEnd = await solBal(wallet.publicKey)
  log(`position account exists? ${!!posAfter}   position NFT mint exists? ${!!nftAfter}`)
  if (posAfter) throw new Error('position account should be closed')
  if (nftAfter) throw new Error('position NFT mint should be closed (rent returned)')
  const dSol2 = solEnd - solAfter
  log(`SOL delta from full+close ≈ ${dSol2 / 1e9} (≈2.5 SOL + ~0.04 rent recovered, minus fees)`)
  if (dSol2 < 2.2 * 1e9) throw new Error(`full withdrawal too small: ${dSol2}`)
  log('✓ FULL WITHDRAWAL + CLOSE VERIFIED — everything returned to wallet, rent recovered')

  log('\nWITHDRAWAL TEST PASSED')
}

main().catch((e) => {
  console.error('WITHDRAWAL TEST FAILED:', e.message)
  process.exit(1)
})
