import { Connection } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
const connection = new Connection('https://api.devnet.solana.com', 'confirmed')
const sdk = new CpAmm(connection)
const pools = await connection.getProgramAccounts(CP_AMM_PROGRAM_ID, {
  dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: sdk._program.account.pool.size }],
})
console.log('devnet pool accounts:', pools.length)
let gt=0, lt=0, eq=0, checked=0
for (const { publicKey } of pools.slice(0, 200)) {
  try {
    const p = await sdk.fetchPoolState(publicKey)
    const c = Buffer.compare(p.tokenAMint.toBuffer(), p.tokenBMint.toBuffer())
    if (c>0) gt++; else if (c<0) lt++; else eq++
    checked++
    if (checked<=6) console.log(`  A=${p.tokenAMint.toBase58()}  B=${p.tokenBMint.toBase58()}  A${c>0?'>':c<0?'<':'=='}B`)
    if (checked>=30) break
  } catch {}
}
console.log(`checked=${checked} A>B=${gt} A<B=${lt} eq=${eq}`)
console.log(gt>lt ? '⇒ tokenA = LARGER key' : lt>gt ? '⇒ tokenA = SMALLER key' : '⇒ INCONCLUSIVE')
