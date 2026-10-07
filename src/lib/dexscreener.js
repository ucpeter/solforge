/**
 * DexScreener Public API integration for trending token cloning.
 * Free, keyless endpoints with ~60-300 req/min limits.
 */

export async function fetchTrendingSolanaTokens(limit = 12) {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) return []

    // Filter to Solana chain only and pick top items with valid token addresses
    const solanaTokens = data
      .filter((item) => item.chainId === 'solana' && item.tokenAddress)
      .slice(0, limit)

    return solanaTokens.map((item) => {
      let iconUrl = item.icon
      if (iconUrl && !iconUrl.startsWith('http')) {
        iconUrl = `https://cdn.dexscreener.com/cms/images/${iconUrl}?width=120&height=120&quality=90&format=auto`
      }
      return {
        tokenAddress: item.tokenAddress,
        url: item.url,
        description: item.description || '',
        icon: iconUrl || item.openGraph || '',
        totalBoosts: item.totalAmount || item.amount || 0,
        links: item.links || [],
      }
    })
  } catch (err) {
    console.error('Failed to fetch trending tokens from DexScreener:', err)
    return []
  }
}

export async function fetchTokenDetailsByAddress(address) {
  const clean = address.trim()
  if (!clean) throw new Error('Token address is required')

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${clean}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const pair = data.pairs?.[0]
    if (!pair) {
      throw new Error('Token details not found on DexScreener. Make sure it is a valid Solana token address.')
    }

    const base = pair.baseToken || {}
    const info = pair.info || {}

    // Extract social links
    let twitter = ''
    let telegram = ''
    let website = ''

    if (Array.isArray(info.websites) && info.websites.length > 0) {
      website = info.websites[0].url || ''
    }
    if (Array.isArray(info.socials)) {
      for (const soc of info.socials) {
        if (soc.type === 'twitter' || soc.url?.includes('twitter.com') || soc.url?.includes('x.com')) {
          twitter = soc.url
        } else if (soc.type === 'telegram' || soc.url?.includes('t.me')) {
          telegram = soc.url
        }
      }
    }

    return {
      name: base.name || '',
      symbol: base.symbol || '',
      address: base.address || clean,
      imageUrl: info.imageUrl || info.openGraph || '',
      description: info.description || '',
      twitter,
      telegram,
      website,
    }
  } catch (err) {
    throw new Error(err.message || 'Could not fetch token data from DexScreener')
  }
}
