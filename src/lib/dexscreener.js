/**
 * DexScreener Public API integration for trending token cloning.
 * Free, keyless endpoints with ~60-300 req/min limits.
 */
import { compactUsd } from './format.js'

export async function fetchTrendingSolanaTokens(limit = 12) {
  try {
    // 1. Fetch top boosted tokens
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) return []

    // Filter to Solana chain only and pick top items with valid token addresses
    const solanaTokens = data
      .filter((item) => item.chainId === 'solana' && item.tokenAddress)
      .slice(0, limit)

    if (solanaTokens.length === 0) return []

    const addresses = solanaTokens.map((t) => t.tokenAddress)

    // 2. Batch fetch real token details, pairs, logos, and market caps
    let pairMap = new Map()
    try {
      const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(',')}`)
      if (pairsRes.ok) {
        const pairsData = await pairsRes.json()
        for (const p of pairsData.pairs || []) {
          const addr = p.baseToken?.address
          if (addr && (!pairMap.has(addr) || (p.marketCap || 0) > (pairMap.get(addr).marketCap || 0))) {
            pairMap.set(addr, p)
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch detailed pair info:', e)
    }

    return solanaTokens.map((item) => {
      const pair = pairMap.get(item.tokenAddress) || {}
      const base = pair.baseToken || {}
      const info = pair.info || {}

      // Robust image resolution: pair info imageUrl -> openGraph -> CDN fallback
      let iconUrl = info.imageUrl || info.openGraph || ''
      if (!iconUrl && item.icon) {
        iconUrl = item.icon.startsWith('http')
          ? item.icon
          : `https://cdn.dexscreener.com/cms/images/${item.icon}?width=800&height=800&quality=95&format=auto`
      }

      const mcap = pair.marketCap || pair.fdv || null

      return {
        tokenAddress: item.tokenAddress,
        name: base.name || '',
        symbol: base.symbol || '',
        description: item.description || info.description || '',
        icon: iconUrl,
        marketCap: mcap,
        marketCapFormatted: mcap ? compactUsd(mcap) : null,
        url: pair.url || item.url || `https://dexscreener.com/solana/${item.tokenAddress}`,
        totalBoosts: item.totalAmount || item.amount || 0,
        links: info.socials || item.links || [],
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

    let imageUrl = info.imageUrl || info.openGraph || ''
    const mcap = pair.marketCap || pair.fdv || null

    return {
      name: base.name || '',
      symbol: base.symbol || '',
      address: base.address || clean,
      imageUrl,
      marketCap: mcap,
      marketCapFormatted: mcap ? compactUsd(mcap) : null,
      description: info.description || '',
      twitter,
      telegram,
      website,
    }
  } catch (err) {
    throw new Error(err.message || 'Could not fetch token data from DexScreener')
  }
}
