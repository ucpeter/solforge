import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'
import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import { planCreatePool, listPoolConfigs, makeSdk } from '../src/lib/liquidity.js'
import { finalizeTransaction, messageAccountKeys } from '../src/lib/txkit.js'

const connection = new Connection('http://127.0.0.1:8899', 'confirmed')
const wallet = Keypair.generate()
await connection.requestAirdrop(wallet.publicKey, 3 * LAMPORTS_PER_SOL)
await new Promise(r => setTimeout(r, 2500))
const plan = await buildTokenCreation(connection, {
  payer: wallet.publicKey,
  form: { name: 'D', symbol: 'D', decimals: 9, supply: '1000000000', tokenProgram: 'spl', revokeMint: true, revokeFreeze: true, metadataImmutable: false, renounceMetadataUpdate: false },
  metadataUri: 'https://example.com/m.json',
})
const fin0 = await finalizeTransaction(connection, packInstructions(plan.instructions)[0], { payer: wallet.publicKey })
fin0.sign(wallet, plan.mintKeypair)
await connection.sendRawTransaction(fin0.serialize(), { skipPreflight: false })
await new Promise(r => setTimeout(r, 1500))

const sdk = makeSdk(connection)
const configs = await listPoolConfigs(connection, sdk)
const poolPlan = await planCreatePool({
  connection, sdk, payer: wallet.publicKey, config: configs[0].address,
  tokenMint: plan.mint, tokenAmount: new BN('1000000000'),
  quoteMint: NATIVE_MINT, quoteAmount: new BN('1000000000'),
  tokenDecimals: 9, quoteDecimals: 9, lockLiquidity: true,
})
const fin1 = await finalizeTransaction(connection, poolPlan.tx, { payer: wallet.publicKey })
const keys = messageAccountKeys(fin1)
console.log('messageAccountKeys count:', keys.length)

// find the sol-transfer destination
const { extractInstructions, describeInstruction } = await import('../src/lib/txkit.js')
for (const ix of extractInstructions(fin1)) {
  const d = describeInstruction(ix)
  if (d.kind === 'sol-transfer') console.log('TRANSFER TO:', d.to.toBase58(), ' in keys?', keys.includes(d.to.toBase58()))
}

const sim = await connection.simulateTransaction(new (await import('@solana/web3.js')).VersionedTransaction(fin1.compileMessage()), {
  sigVerify: false, replaceRecentBlockhash: true,
  accounts: { addresses: keys, states: 'base64' },
})
console.log('sim err:', JSON.stringify(sim.value.err))
console.log('returned accounts:', sim.value.accounts?.length)
const destIdx = keys.indexOf('34HaRpNK2u8gDPCkQUzSXtuNBEtKpbztop4SKjxiw73S')
console.log('dest idx in keys:', destIdx)
const d = sim.value.accounts?.[destIdx]
console.log('dest post-state:', d ? JSON.stringify({lamports: d.lamports, owner: d.owner, len: d.data?.[0]?.length}) : 'NULL/missing')
// also check pre-state
const pre = await connection.getAccountInfo(new PublicKey('34HaRpNK2u8gDPCkQUzSXtuNBEtKpbztop4SKjxiw73S'))
console.log('dest pre-state:', pre ? `exists owner=${pre.owner.toBase58()}` : 'null')
for (let i = 0; i < fin1.instructions.length; i++) {
  const ix = fin1.instructions[i]
  const d = describeInstruction(ix)
  console.log(`IX[${i}] ${d.kind} ${d.action} prog=${ix.programId.toBase58().slice(0,8)}… accounts: ${ix.keys.map(k => (k.isSigner?'S':'')+(k.isWritable?'W':'')+k.pubkey.toBase58().slice(0,6)).join(' ')}`)
}
// what creates it? list all instructions with that account
for (const ix of fin1.instructions) {
  if (ix.keys.some(k => k.pubkey.toBase58() === '34HaRpNK2u8gDPCkQUzSXtuNBEtKpbztop4SKjxiw73S')) {
    const d2 = describeInstruction(ix)
    console.log('IX touching dest:', d2.kind, d2.action, 'program=', ix.programId.toBase58().slice(0,8))
  }
}
sim.value.accounts?.forEach((a, i) => {
  if (!a) return
  const lam = a.lamports
  if (lam === 1000000000 || lam === 1002039280) console.log(`idx=${i} addr=${keys[i]} lamports=${lam} owner=${a.owner}`)
})
