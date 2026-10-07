/**
 * DexScreener Public API integration for trending token cloning.
 * Free, keyless endpoints with ~60-300 req/min limits.
 */
import { compactUsd } from './format.js'

export async function fetchTrendingSolanaTokens(limit = 60) {
  try {
    // 1. Fetch from multiple endpoints concurrently to get 50+ unique Solana tokens
    const [topRes, latestRes, profilesRes] = await Promise.all([
      fetch('https://api.dexscreener.com/token-boosts/top/v1').catch(() => null),
      fetch('https://api.dexscreener.com/token-boosts/latest/v1').catch(() => null),
      fetch('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => null),
    ])

    const [topData, latestData, profilesData] = await Promise.all([
      topRes && topRes.ok ? topRes.json().catch(() => []) : [],
      latestRes && latestRes.ok ? latestRes.json().catch(() => []) : [],
      profilesRes && profilesRes.ok ? profilesRes.json().catch(() => []) : [],
    ])

    const allItems = [
      ...(Array.isArray(topData) ? topData : []),
      ...(Array.isArray(latestData) ? latestData : []),
      ...(Array.isArray(profilesData) ? profilesData : []),
    ]

    // Filter to Solana chain and unique token addresses
    const seen = new Set()
    const solanaTokens = []
    for (const item of allItems) {
      if (item.chainId === 'solana' && item.tokenAddress && !seen.has(item.tokenAddress)) {
        seen.add(item.tokenAddress)
        solanaTokens.push(item)
      }
    }

    const slice = solanaTokens.slice(0, limit)
    if (slice.length === 0) return []

    // 2. Batch fetch pair details, market caps, and created timestamps in chunks of 30
    const addresses = slice.map((t) => t.tokenAddress)
    const chunks = []
    for (let i = 0; i < addresses.length; i += 30) {
      chunks.push(addresses.slice(i, i + 30))
    }

    const pairMap = new Map()
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`)
          if (res.ok) {
            const data = await res.json()
            for (const p of data.pairs || []) {
              const addr = p.baseToken?.address
              if (addr) {
                const prev = pairMap.get(addr)
                if (!prev || (p.marketCap || 0) > (prev.marketCap || 0)) {
                  pairMap.set(addr, p)
                }
              }
            }
          }
        } catch (e) {
          console.warn('Batch pair fetch failed:', e)
        }
      })
    )

    return slice.map((item) => {
      const pair = pairMap.get(item.tokenAddress) || {}
      const base = pair.baseToken || {}
      const info = pair.info || {}

      let iconUrl = info.imageUrl || info.openGraph || ''
      if (!iconUrl && item.icon) {
        iconUrl = item.icon.startsWith('http')
          ? item.icon
          : `https://cdn.dexscreener.com/cms/images/${item.icon}?width=800&height=800&quality=95&format=auto`
      }

      const mcap = pair.marketCap || pair.fdv || null
      const createdAt = pair.pairCreatedAt || null

      return {
        tokenAddress: item.tokenAddress,
        name: base.name || '',
        symbol: base.symbol || '',
        description: item.description || info.description || '',
        icon: iconUrl,
        marketCap: mcap,
        marketCapFormatted: mcap ? compactUsd(mcap) : null,
        createdAt,
        ageFormatted: formatAge(createdAt),
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

export function formatAge(timestamp) {
  if (!timestamp) return null
  const now = Date.now()
  const diffMs = Math.max(0, now - Number(timestamp))
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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
    const createdAt = pair.pairCreatedAt || null

    return {
      name: base.name || '',
      symbol: base.symbol || '',
      address: base.address || clean,
      imageUrl,
      marketCap: mcap,
      marketCapFormatted: mcap ? compactUsd(mcap) : null,
      createdAt,
      ageFormatted: formatAge(createdAt),
      description: info.description || '',
      twitter,
      telegram,
      website,
    }
  } catch (err) {
    throw new Error(err.message || 'Could not fetch token data from DexScreener')
  }
}
