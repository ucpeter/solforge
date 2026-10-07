/**
 * DexScreener Public API integration for trending token cloning.
 * Supports:
 * - 'general': top active boosts on DexScreener (highest overall momentum/volume)
 * - 'new': strictly freshly created tokens (created within the last 24–48 hours, sorted newest first)
 */
import { compactUsd } from './format.js'

export async function fetchTrendingSolanaTokens(category = 'general', limit = 50) {
  try {
    let endpoints = []
    if (category === 'new') {
      // For new trending, combine latest token boosts and latest token profiles
      endpoints = [
        'https://api.dexscreener.com/token-boosts/latest/v1',
        'https://api.dexscreener.com/token-profiles/latest/v1',
      ]
    } else {
      // General trending combines top boosts with latest boosts
      endpoints = [
        'https://api.dexscreener.com/token-boosts/top/v1',
        'https://api.dexscreener.com/token-boosts/latest/v1',
      ]
    }

    const responses = await Promise.all(
      endpoints.map((ep) =>
        fetch(ep, { headers: { 'User-Agent': 'Mozilla/5.0' } })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])
      )
    )

    const allItems = responses.flat()

    // Deduplicate unique Solana token addresses
    const seen = new Set()
    const solanaTokens = []
    const itemMetaMap = new Map()

    for (const item of allItems) {
      if (item.chainId === 'solana' && item.tokenAddress && !seen.has(item.tokenAddress)) {
        seen.add(item.tokenAddress)
        solanaTokens.push(item)
        itemMetaMap.set(item.tokenAddress, item)
      }
    }

    // We scan up to 90 candidate tokens to ensure we get a deep batch of truly new coins
    const candidateSlice = solanaTokens.slice(0, 90)
    if (candidateSlice.length === 0) return []

    // Batch fetch pair details, creation timestamps, symbols, names, and market caps
    const addresses = candidateSlice.map((t) => t.tokenAddress)
    const chunks = []
    for (let i = 0; i < addresses.length; i += 30) {
      chunks.push(addresses.slice(i, i + 30))
    }

    const pairMap = new Map()
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          })
          if (res.ok) {
            const pairsData = await res.json()
            if (Array.isArray(pairsData)) {
              for (const p of pairsData) {
                const addr = p.baseToken?.address
                if (addr) {
                  const prev = pairMap.get(addr)
                  if (!prev || (p.marketCap || 0) > (prev.marketCap || 0)) {
                    pairMap.set(addr, p)
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn('Batch pair fetch failed:', e)
        }
      })
    )

    const now = Date.now()
    const mapped = []

    for (const item of candidateSlice) {
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
      const createdAt = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : null
      const ageMs = createdAt ? Math.max(0, now - createdAt) : null

      // Fallback name & symbol: if pair isn't indexed yet, derive from address or fallback
      const symbol = base.symbol || ''
      const name = base.name || symbol || ''

      mapped.push({
        tokenAddress: item.tokenAddress,
        name,
        symbol,
        description: item.description || info.description || '',
        icon: iconUrl,
        marketCap: mcap,
        marketCapFormatted: mcap ? compactUsd(mcap) : null,
        createdAt,
        ageMs,
        ageFormatted: formatAge(createdAt),
        url: pair.url || item.url || `https://dexscreener.com/solana/${item.tokenAddress}`,
        totalBoosts: item.totalAmount || item.amount || 0,
        links: info.socials || item.links || [],
      })
    }

    if (category === 'new') {
      // Filter strictly to tokens created within the last 48 hours (48 * 3600 * 1000 ms)
      // And sort by newest creation date first (shortest age)
      const MAX_AGE_MS = 48 * 60 * 60 * 1000
      const freshlyCreated = mapped
        .filter((t) => t.createdAt && t.ageMs !== null && t.ageMs <= MAX_AGE_MS)
        .sort((a, b) => (a.ageMs || 0) - (b.ageMs || 0))

      if (freshlyCreated.length >= 10) {
        return freshlyCreated.slice(0, limit)
      }
      // If fewer than 10 are <48h, sort all available by newest creation time first
      return mapped
        .filter((t) => t.createdAt)
        .sort((a, b) => (a.ageMs || 0) - (b.ageMs || 0))
        .slice(0, limit)
    }

    // General trending: keeps top boosted order
    return mapped.slice(0, limit)
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
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${clean}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
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
