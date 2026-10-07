/**
 * DexScreener Public API integration for trending token cloning.
 * Supports both "General Trending" (top boosted) and "New Trending" (latest boosts/profiles).
 */
import { compactUsd } from './format.js'

/**
 * Fetch trending tokens by category:
 * - 'general': top active boosts on DexScreener (highest momentum/volume)
 * - 'new': newly boosted / recently created profiles on DexScreener
 */
export async function fetchTrendingSolanaTokens(category = 'general', limit = 50) {
  try {
    let endpoints = []
    if (category === 'new') {
      endpoints = [
        'https://api.dexscreener.com/token-boosts/latest/v1',
        'https://api.dexscreener.com/token-profiles/latest/v1',
      ]
    } else {
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

    // Filter to unique Solana token addresses
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

    // Batch fetch pair details, market caps, symbols, names, and creation timestamps
    // DexScreener /tokens/v1/solana/{addresses} accepts up to 30 comma-separated addresses
    const addresses = slice.map((t) => t.tokenAddress)
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

    // Secondary fallback for tokens that weren't returned in multi-token queries
    const missing = slice.filter((t) => !pairMap.has(t.tokenAddress)).slice(0, 8)
    if (missing.length > 0) {
      await Promise.all(
        missing.map(async (t) => {
          try {
            const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
            })
            if (res.ok) {
              const data = await res.json()
              const best = data.pairs?.[0]
              if (best?.baseToken?.address) {
                pairMap.set(best.baseToken.address, best)
              }
            }
          } catch {
            /* ignore individual fetch errors */
          }
        })
      )
    }

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
