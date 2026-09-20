import { Connection } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
const connection = new Connection('https://api.devnet.solana.com', 'confirmed')
const sdk = new CpAmm(connection)
const pools = await connection.getProgramAccounts(CP_AMM_PROGRAM_ID, { dataSlice:{offset:0,length:0}, filters:[{dataSize:1112}] })
console.log('n=', pools.length, 'first elem keys:', Object.keys(pools[0] || {}))
console.log('first elem:', JSON.stringify(pools[0]).slice(0, 200))
const p0 = pools[0]?.pubkey ?? pools[0]?.publicKey
console.log('p0 =', p0?.toString())
let gt=0, lt=0, n=0
for (const item of pools.slice(0, 40)) {
  const key = item.pubkey || item.publicKey
  try {
    const p = await sdk._program.account.pool.fetch(key)
    const c = Buffer.compare(p.tokenAMint.toBuffer(), p.tokenBMint.toBuffer())
    if (c>0) gt++; else lt++; n++
    if (n<=6) console.log(`  A=${p.tokenAMint.toBase58().slice(0,10)} B=${p.tokenBMint.toBase58().slice(0,10)} ${c>0?'A>B':'A<B'}`)
  } catch (e) { console.log('  ERR', String(e.message).slice(0,90)) }
}
console.log(`decoded=${n} A>B=${gt} A<B=${lt}`)
