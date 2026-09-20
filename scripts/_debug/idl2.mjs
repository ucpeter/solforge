import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
const ixs = CpAmmIdl.instructions || []
console.log('instructions:', ixs.length)
console.log(ixs.map(i => i.name).join(', ').slice(0, 800))
for (const ix of ixs) {
  if (/permanent|lock/i.test(ix.name)) {
    console.log('\n===', ix.name, '===')
    console.log('docs:', JSON.stringify(ix.docs || []))
    for (const a of ix.args || []) console.log(`  arg ${a.name}: ${typeof a.type==='string'?a.type:JSON.stringify(a.type)}  docs=${JSON.stringify(a.docs||[])}`)
  }
}
