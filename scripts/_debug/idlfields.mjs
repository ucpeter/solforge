import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
for (const a of CpAmmIdl.accounts || []) {
  const fields = a.type?.kind?.fields || []
  console.log(`\n${a.name}:`)
  console.log('  ' + fields.map(f => `${f.name}${f.type && typeof f.type === 'object' ? '' : ':' + (typeof f.type === 'string' ? f.type : JSON.stringify(f.type))}`).join(', '))
}
