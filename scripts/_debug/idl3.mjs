import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
for (const t of CpAmmIdl.types || []) {
  if (/FeeTimeScheduler|FeeRateLimiter|FeeMarketCap|VestingParameters|Config$/.test(t.name)) {
    const f = t.type?.kind?.fields || t.type?.field || []
    console.log(`${t.name}: ${f.map(x => `${x.name}:${typeof x.type==='string'?x.type:(x.type?.defined?.name || JSON.stringify(x.type).slice(0,30))}`).join(', ')}`)
  }
}
