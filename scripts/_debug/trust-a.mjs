import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import { inspectTransaction, assertNoHiddenSOL, finalizeTransaction, simulateTransaction } from '../src/lib/txkit.js'
const connection = new Connection(process.env.RPC_URL || 'http://127.0.0.1:8899', 'confirmed')
console.log('airdrop…')
const wallet = Keypair.generate()
await connection.requestAirdrop(wallet.publicKey, 3 * LAMPORTS_PER_SOL)
console.log('airdrop requested')
await new Promise(r => setTimeout(r, 3000))
const bal = await connection.getBalance(wallet.publicKey)
console.log('balance:', bal / 1e9)
const plan = await buildTokenCreation(connection, {
  payer: wallet.publicKey,
  form: { name: 'Trust Test', symbol: 'TRT', decimals: 9, supply: '1000000000', tokenProgram: 'spl', revokeMint: true, revokeFreeze: true, metadataImmutable: false, renounceMetadataUpdate: false },
  metadataUri: 'https://example.com/m.json',
})
console.log('plan built')
const tx0 = packInstructions(plan.instructions)[0]
const fin0 = await finalizeTransaction(connection, tx0, { payer: wallet.publicKey, priorityFeeMicroLamports: 20000 })
console.log('finalized')
const insp0 = await inspectTransaction(connection, fin0, wallet.publicKey, [plan.mintKeypair])
console.log('TOKEN CREATION: solMovements =', JSON.stringify(insp0.solMovements), ' unexplainedOut =', insp0.unexplainedSolOut)
assertNoHiddenSOL(insp0, wallet.publicKey)
console.log('assertNoHiddenSOL: PASS')
const sim0 = await simulateTransaction(connection, fin0)
console.log('TOKEN CREATION: sim ok =', sim0.ok, ' units =', sim0.unitsConsumed, sim0.error ?? '')
