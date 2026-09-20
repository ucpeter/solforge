import { Connection, PublicKey } from '@solana/web3.js'
import * as M from '@meteora-ag/cp-amm-sdk'
const c = new Connection('https://api.mainnet-beta.solana.com', 'confirmed')
const sdk = new M.CpAmm(c)
const addrs = ['6sWazXVC4Wkuz9CqsDEtsznZ4ZV6g5asxb4UsX9KdWJ','9PzBJvXhGJtZR8SKSNgjRo8hgFfU6h1EXHSWNrXkkx4','9m3uWcWo37E7eUz9MQubmx28H3PUrir7FfLyQfZzADY','A83gixEQAJaYtFyuiNycARqawSVHiLGmZZFf2KcvQwp','Etw8N289252x1vYYrA6vH8p6mSBTNcVwfNJR3VyosdG']
for (const a of addrs) {
  const s = await sdk.fetchConfigState(new PublicKey(a))
  const mode = M.getBaseFeeModeFromBorshData(s.poolFees.baseFee.data)
  let extra = ''
  try {
    const h = M.getBaseFeeHandlerFromBorshData(s.poolFees.baseFee)
    extra = 'methods=' + Object.getOwnPropertyNames(Object.getPrototypeOf(h)).filter(m=>m!=='constructor').join('|')
  } catch (e) { extra = 'handler err: ' + e.message.slice(0,60) }
  console.log(`\n${a.slice(0,10)} mode=${M.BaseFeeMode[mode]} collectFee=${M.CollectFeeMode[s.collectFeeMode]} activation=${M.ActivationType[s.activationType]} dyn=${M.isDynamicFeeEnabled(s.poolFees.dynamicFee)} protocolFee%=${s.poolFees.protocolFeePercent} referral%=${s.poolFees.referralFeePercent}`)
  console.log('   ', extra)
}
