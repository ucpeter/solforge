import { Connection } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
const c = new Connection('https://api.devnet.solana.com', 'confirmed')
const sdk = new CpAmm(c)
const accs = await c.getProgramAccounts(CP_AMM_PROGRAM_ID, { dataSlice:{offset:0,length:0}, filters:[{dataSize:408}] })
console.log('position-like accounts:', accs.length)
for (const { pubkey } of accs.slice(0, 10)) {
  try {
    const p = await sdk._program.account.position.fetch(pubkey)
    console.log('\nPOSITION keys:', Object.keys(p).join(', '))
    console.log(JSON.stringify(p, (k,v)=>typeof v==='bigint'?v.toString():v?.toBase58?.()?v.toBase58():v).slice(0,700))
    break
  } catch {}
}
