import { Connection, PublicKey } from '@solana/web3.js'
import * as M from '@meteora-ag/cp-amm-sdk'
const c = new Connection('https://api.mainnet-beta.solana.com', 'confirmed')
const sdk = new M.CpAmm(c)
for (const a of ['6sWazXVC4Wkuz9CqsDEtsznZ4ZV6g5asxb4UsX9KdWJ','9m3uWcWo37E7eUz9MQubmx28H3PUrir7FfLyQfZzADY','A83gixEQAJaYtFyuiNycARqawSVHiLGmZZFf2KcvQwp']) {
  const s = await sdk.fetchConfigState(new PublicKey(a))
  const buf = Buffer.from(s.poolFees.baseFee.data)
  console.log('\n' + a.slice(0,12), 'mode=', M.BaseFeeMode[M.getBaseFeeModeFromBorshData(buf)])
  try {
    const h = M.getBaseFeeHandlerFromBorshData(s.poolFees.baseFee)
    console.log('  handler proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(h)).filter(x=>x!=='constructor').join(', '))
    console.log('  JSON:', JSON.stringify(h, (k,v)=>typeof v==='bigint'?v.toString():v?.toString?.()?v.toString():v).slice(0,400))
  } catch (e) { console.log('  handler err', e.message.slice(0,80)) }
  try { console.log('  decodeFeeTimeSchedulerParams:', JSON.stringify(M.decodeFeeTimeSchedulerParams(buf), (k,v)=>typeof v==='bigint'?v.toString():v?.toString?.()?v.toString():v)) } catch (e) { console.log('  decode err:', e.message.slice(0,80)) }
}
