import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import { finalizeTransaction, estimateComputeUnits, simulateTransaction, inspectTransaction } from '../src/lib/txkit.js'
const connection = new Connection(process.env.RPC_URL || 'http://127.0.0.1:8899', 'confirmed')
const kp = Keypair.generate()
await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL); await new Promise(r => setTimeout(r, 3000))
const plan = await buildTokenCreation(connection, {
  payer: kp.publicKey,
  form: { name: 'Dbg Token', symbol: 'DBG', decimals: 9, supply: '1000000', tokenProgram: 'spl', revokeMint: true, revokeFreeze: true, metadataImmutable: false, renounceMetadataUpdate: false },
  metadataUri: 'https://example.com/m.json',
})
const tx = packInstructions(plan.instructions)[0]
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = kp.publicKey
const cu = await estimateComputeUnits(connection, tx, 400000)
const fin = await finalizeTransaction(connection, tx, { payer: kp.publicKey, cuLimit: cu, priorityFeeMicroLamports: 20000 })
console.log('cu estimate:', cu, ' instructions after finalize:', fin.instructions.length)
const sim = await simulateTransaction(connection, fin)
console.log('sim.ok =', sim.ok, ' units =', sim.unitsConsumed, ' error =', sim.error)
console.log('logs:\n' + (sim.logs || []).join('\n'))
const insp = await inspectTransaction(connection, fin)
console.log('\ninspectTransaction:'); console.log(JSON.stringify(insp, (k,v)=> typeof v==='bigint'? v.toString(): v, 1).slice(0, 2000))
