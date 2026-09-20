import { Connection, PublicKey } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
const c = new Connection('https://api.devnet.solana.com', 'confirmed')
const sdk = new CpAmm(c)
const pools = await c.getProgramAccounts(CP_AMM_PROGRAM_ID, { dataSlice:{offset:0,length:0}, filters:[{dataSize:1112}] })
let pool, pos
for (const { pubkey } of pools.slice(0, 25)) { try { pool = await sdk.fetchPoolState(pubkey); break } catch {} }
console.log('POOL keys:', Object.keys(pool).join(', '))
console.log('POOL sample:', JSON.stringify(pool, (k,v)=>typeof v==='bigint'?v.toString():v?.toBase58?.()?v.toBase58():v, 1).slice(0,1400))
