import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'
import { buildTokenCreation, packInstructions } from '../src/lib/tokenCreator.js'
import { planCreatePool, listPoolConfigs, makeSdk } from '../src/lib/liquidity.js'
import { finalizeTransaction } from '../src/lib/txkit.js'
import { VersionedTransaction } from '@solana/web3.js'

const connection = new Connection('http://127.0.0.1:8899', 'confirmed')
const wallet = Keypair.generate()
await connection.requestAirdrop(wallet.publicKey, 3 * LAMPORTS_PER_SOL)
await new Promise(r => setTimeout(r, 2500))
const plan = await buildTokenCreation(connection, {
  payer: wallet.publicKey,
  form: { name: 'PS', symbol: 'PS', decimals: 9, supply: '1000000000', tokenProgram: 'spl', revokeMint: true, revokeFreeze: true, metadataImmutable: false, renounceMetadataUpdate: false },
  metadataUri: 'https://example.com/m.json',
})
const tx0 = packInstructions(plan.instructions)[0]
const fin0 = await finalizeTransaction(connection, tx0, { payer: wallet.publicKey })
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
fin1.sign(wallet, poolPlan.positionNft)

// collect all account keys in the message
const keys = new Set()
for (const ix of fin1.instructions) for (const a of ix.keys) keys.add(a.pubkey.toBase58())
keys.add(wallet.publicKey.toBase58())
keys.add(poolPlan.pool.toBase58())
console.log('accounts in tx:', keys.size)
const sim = await connection.simulateTransaction(new VersionedTransaction(fin1.compileMessage()), {
  sigVerify: false,
  replaceRecentBlockhash: true,
  accounts: { addresses: [...keys], states: 'base64' },
})
console.log('sim err =', JSON.stringify(sim.value.err))
for (const a of sim.value.accounts || []) {
  if (!a) continue
  const buf = a.executable || (a.lamports && a.lamports > 0) ? a : null
  if (!a.lamports) continue
  const owner = a.owner
  let tokenOwner = null
  if (owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && a.data?.[0]?.length > 64) {
    const b = Buffer.from(a.data[0], 'base64')
    tokenOwner = new PublicKey(b.subarray(32, 64)).toBase58()
  }
  console.log(`${a.pubkey}  lamports=${a.lamports}  owner=${owner}  tokenOwner=${tokenOwner ?? ''}  createdInTx=${a.executable ? '?' : (a.lamports > 0 ? 'yes' : 'no')}  existsPre?`)
}
// pre-state of the mystery account
const pre = await connection.getAccountInfo(new PublicKey('DWoSuG4g64vQfDW3nRqpmDtiWVnXZhbBp2QQ3YrZ2QzW'))
console.log('mystery pre-state:', pre ? `exists owner=${pre.owner.toBase58()} lamports=${pre.lamports}` : 'null')
console.log('wallet:', wallet.publicKey.toBase58())
