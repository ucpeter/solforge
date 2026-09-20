import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'
import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import { planCreatePool, listPoolConfigs, makeSdk } from '../src/lib/liquidity.js'
import { inspectTransaction, assertNoHiddenSOL, finalizeTransaction, simulateTransaction } from '../src/lib/txkit.js'

const connection = new Connection(process.env.RPC_URL || 'http://127.0.0.1:8899', 'confirmed')
const wallet = Keypair.generate()
await connection.requestAirdrop(wallet.publicKey, 3 * LAMPORTS_PER_SOL)
await new Promise(r => setTimeout(r, 2500))

// 1. token creation plan -> finalize -> inspect -> assert
const plan = await buildTokenCreation(connection, {
  payer: wallet.publicKey,
  form: { name: 'Trust Test', symbol: 'TRT', decimals: 9, supply: '1000000000', tokenProgram: 'spl', revokeMint: true, revokeFreeze: true, metadataImmutable: false, renounceMetadataUpdate: false },
  metadataUri: 'https://example.com/m.json',
})
const tx0 = packInstructions(plan.instructions)[0]
const fin0 = await finalizeTransaction(connection, tx0, { payer: wallet.publicKey, priorityFeeMicroLamports: 20000 })
const insp0 = await inspectTransaction(connection, fin0, wallet.publicKey, [plan.mintKeypair])
console.log('TOKEN CREATION: solMovements =', JSON.stringify(insp0.solMovements), ' unexplainedOut =', insp0.unexplainedSolOut)
assertNoHiddenSOL(insp0, wallet.publicKey)
const sim0 = await simulateTransaction(connection, fin0)
console.log('TOKEN CREATION: sim ok =', sim0.ok, ' units =', sim0.unitsConsumed)

// 2. pool creation with SOL wrap -> finalize -> inspect -> assert -> send
const sdk = makeSdk(connection)
const configs = await listPoolConfigs(connection, sdk)
const poolPlan = await planCreatePool({
  connection,
  sdk,
  payer: wallet.publicKey,
  config: configs[0].address,
  tokenMint: plan.mint,
  tokenAmount: new BN('1000000000'),
  quoteMint: NATIVE_MINT,
  quoteAmount: new BN('1000000000'),
  tokenDecimals: 9,
  quoteDecimals: 9,
  lockLiquidity: true, // exercise the in-tx permanent lock too
})
const fin1 = await finalizeTransaction(connection, poolPlan.tx, { payer: wallet.publicKey, priorityFeeMicroLamports: 20000 })
const sim1 = await simulateTransaction(connection, fin1, { withPostStates: true })
const insp1 = await inspectTransaction(connection, fin1, wallet.publicKey, [poolPlan.positionNft], sim1.postStates)
console.log('\nPOOL CREATION: solMovements =')
for (const m of insp1.solMovements) console.log(`  ${m.classification}: ${(m.lamports/1e9).toFixed(6)} SOL -> ${m.to.slice(0,8)}… ${m.note}`)
console.log('unexplainedOut =', insp1.unexplainedSolOut)
assertNoHiddenSOL(insp1, wallet.publicKey)
console.log('assertNoHiddenSOL: PASS')
console.log('POOL CREATION: sim ok =', sim1.ok, ' units =', sim1.unitsConsumed, sim1.error ? ' err=' + sim1.error : '')

// send it
fin1.sign(wallet, poolPlan.positionNft)
const sig = await connection.sendRawTransaction(fin1.serialize(), { skipPreflight: false, maxRetries: 5 })
await connection.confirmTransaction({ signature: sig, blockhash: fin1.recentBlockhash, lastValidBlockHeight: fin1.lastValidBlockHeight }, 'confirmed')
console.log('POOL CREATED+LOCKED:', sig.slice(0, 20) + '…')
const poolState = await sdk.fetchPoolState(poolPlan.pool)
console.log('on-chain pool liquidity =', poolState.liquidity.toString().slice(0, 18) + '…')
const pos = await sdk.fetchPositionState(poolPlan.position)
console.log('permanentLocked =', pos.permanentLockedLiquidity.toString().slice(0, 18) + '…  unlocked =', pos.unlockedLiquidity.toString())
console.log('\nTRUST TEST PASSED')
