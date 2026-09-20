import { Connection, PublicKey } from '@solana/web3.js'
const c = new Connection('https://api.mainnet-beta.solana.com', 'confirmed')
for (const p of ['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG']) {
  const a = await c.getAccountInfo(new PublicKey(p))
  console.log(p)
  console.log('  owner:', a.owner.toBase58(), ' executable:', a.executable, ' len:', a.data.length)
  if (a.data.length === 36) {
    const state = a.data.readUInt32LE(0)
    console.log('  loader state:', state, '(2 = Program)  programdata:', new PublicKey(a.data.subarray(4, 36)).toBase58())
  } else {
    console.log('  not an upgradeable program stub (data len != 36) → BPFLoader2 style, program account holds the ELF')
  }
}
