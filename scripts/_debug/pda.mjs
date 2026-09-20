import { PublicKey } from '@solana/web3.js'
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
for (const p of ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG','metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s']) {
  const [data] = PublicKey.findProgramAddressSync([new PublicKey(p).toBuffer(), Buffer.from('programdata')], LOADER)
  console.log(p, '->', data.toBase58())
}
