import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
const types = CpAmmIdl.types || []
console.log('type names:', types.map(t => t.name).join(', ').slice(0, 600))
for (const t of types) {
  if (/^position/i.test(t.name) || /^vesting/i.test(t.name)) {
    const f = t.type?.kind?.fields || []
    console.log(`\n${t.name}: ${f.map(x => x.name).join(', ')}`)
  }
}
