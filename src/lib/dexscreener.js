/**
 * DexScreener Public API integration for trending token cloning.
 * Supports:
 * - 'general': top active boosts on DexScreener (highest overall momentum/volume, 50+ tokens)
 * - 'new': strictly freshly created tokens (created within 24–48 hours, sorted newest first, 50+ tokens)
 * - 'pump': live trending tokens launched directly on Pump.fun (ending in 'pump'), ranked by real-time buy activity (5m/1h/24h) with last buy recency indicator (50+ tokens)
 */
import { compactUsd } from './format.js'

export async function fetchTrendingSolanaTokens(category = 'general', limit = 60) {
  try {
    const candidateAddresses = new Set()
    const addressToItem = new Map()

    // 1. Fetch from DexScreener official boost & profile streams
    const streamEndpoints = [
      'https://api.dexscreener.com/token-boosts/top/v1',
      'https://api.dexscreener.com/token-boosts/latest/v1',
      'https://api.dexscreener.com/token-profiles/latest/v1',
    ]

    const streamResults = await Promise.all(
      streamEndpoints.map((ep) =>
        fetch(ep, { headers: { 'User-Agent': 'Mozilla/5.0' } })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])
      )
    )

    for (const item of streamResults.flat()) {
      const addr = item.tokenAddress
      if (item.chainId === 'solana' && addr) {
        if (category === 'pump' && !addr.toLowerCase().endsWith('pump')) {
          continue
        }
        if (!candidateAddresses.has(addr)) {
          candidateAddresses.add(addr)
          addressToItem.set(addr, item)
        }
      }
    }

    // 2. If Pump.fun or General/New needs more candidate depth (to guarantee 50+ tokens), search top Solana DEX pairs
    const searchQueries =
      category === 'pump'
        ? ['pump', 'solana pump', 'pump.fun', 'raydium pump', 'ai pump', 'pepe pump', 'cat pump', 'dog pump']
        : ['solana', 'raydium', 'sol', 'ai', 'meme', 'trump', 'cat', 'dog', 'pepe']

    if (candidateAddresses.size < 70) {
      const searchResults = await Promise.all(
        searchQueries.map((q) =>
          fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          })
            .then((r) => (r.ok ? r.json() : { pairs: [] }))
            .catch(() => ({ pairs: [] }))
        )
      )

      for (const res of searchResults) {
        for (const pair of res.pairs || []) {
          const addr = pair.baseToken?.address
          if (pair.chainId === 'solana' && addr) {
            if (category === 'pump' && !addr.toLowerCase().endsWith('pump')) {
              continue
            }
            if (!candidateAddresses.has(addr)) {
              candidateAddresses.add(addr)
              addressToItem.set(addr, {
                tokenAddress: addr,
                icon: pair.info?.imageUrl || pair.info?.openGraph || '',
                description: pair.info?.description || '',
                url: pair.url,
              })
            }
          }
        }
      }
    }

    const allCandidateList = Array.from(candidateAddresses)
    if (allCandidateList.length === 0) return []

    // 3. Batch query pair details, volume, transactions, creation timestamps, and market caps
    // Using chunks of 30 for DexScreener's /tokens/v1/solana/{addresses}
    const chunks = []
    for (let i = 0; i < allCandidateList.length; i += 30) {
      chunks.push(allCandidateList.slice(i, i + 30))
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
          console.warn('Batch pair fetch error:', e)
        }
      })
    )

    const now = Date.now()
    const mapped = []

    for (const addr of allCandidateList) {
      const item = addressToItem.get(addr) || {}
      const pair = pairMap.get(addr) || {}
      const base = pair.baseToken || {}
      const info = pair.info || {}
      const txns = pair.txns || {}

      let iconUrl = info.imageUrl || info.openGraph || ''
      if (!iconUrl && item.icon) {
        iconUrl = item.icon.startsWith('http')
          ? item.icon
          : `https://cdn.dexscreener.com/cms/images/${item.icon}?width=800&height=800&quality=95&format=auto`
      }

      const mcap = pair.marketCap || pair.fdv || null
      const createdAt = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : null
      const ageMs = createdAt ? Math.max(0, now - createdAt) : null

      const symbol = base.symbol || ''
      const name = base.name || symbol || ''

      const m5Buys = txns.m5?.buys || 0
      const h1Buys = txns.h1?.buys || 0
      const h6Buys = txns.h6?.buys || 0
      const h24Buys = txns.h24?.buys || 0

      // Calculate last buy recency indicator based on real-time transaction buckets
      let lastBuyFormatted = 'inactive'
      if (m5Buys > 0) {
        lastBuyFormatted = '< 5m ago'
      } else if (h1Buys > 0) {
        lastBuyFormatted = '< 1h ago'
      } else if (h6Buys > 0) {
        lastBuyFormatted = '< 6h ago'
      } else if (h24Buys > 0) {
        lastBuyFormatted = '< 24h ago'
      }

      mapped.push({
        tokenAddress: addr,
        name,
        symbol,
        description: item.description || info.description || '',
        icon: iconUrl,
        marketCap: mcap,
        marketCapFormatted: mcap ? compactUsd(mcap) : null,
        createdAt,
        ageMs,
        ageFormatted: formatAge(createdAt),
        url: pair.url || item.url || `https://dexscreener.com/solana/${addr}`,
        totalBoosts: item.totalAmount || item.amount || 0,
        links: info.socials || item.links || [],
        isPump: addr.toLowerCase().endsWith('pump'),
        buys5m: m5Buys,
        buys1h: h1Buys,
        buys24h: h24Buys,
        lastBuyFormatted,
      })
    }

    if (category === 'pump') {
      // Sort strictly by buy activity:
      // 1. Highest 5m buy activity
      // 2. Highest 1h buy activity
      // 3. Highest 24h buy activity
      // 4. Highest market cap
      return mapped
        .sort((a, b) => {
          if (b.buys5m !== a.buys5m) return b.buys5m - a.buys5m
          if (b.buys1h !== a.buys1h) return b.buys1h - a.buys1h
          if (b.buys24h !== a.buys24h) return b.buys24h - a.buys24h
          return (b.marketCap || 0) - (a.marketCap || 0)
        })
        .slice(0, limit)
    }

    if (category === 'new') {
      const MAX_AGE_MS = 48 * 60 * 60 * 1000
      const freshlyCreated = mapped
        .filter((t) => t.createdAt && t.ageMs !== null && t.ageMs <= MAX_AGE_MS)
        .sort((a, b) => (a.ageMs || 0) - (b.ageMs || 0))

      if (freshlyCreated.length >= 50) {
        return freshlyCreated.slice(0, limit)
      }
      return mapped
        .filter((t) => t.createdAt)
        .sort((a, b) => (a.ageMs || 0) - (b.ageMs || 0))
        .slice(0, limit)
    }

    // General trending: keeps top boosted / volume order
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
    const txns = pair.txns || {}

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

    const m5Buys = txns.m5?.buys || 0
    const h1Buys = txns.h1?.buys || 0
    let lastBuyFormatted = 'inactive'
    if (m5Buys > 0) lastBuyFormatted = '< 5m ago'
    else if (h1Buys > 0) lastBuyFormatted = '< 1h ago'
    else if ((txns.h24?.buys || 0) > 0) lastBuyFormatted = '< 24h ago'

    return {
      name: base.name || '',
      symbol: base.symbol || '',
      address: base.address || clean,
      imageUrl,
      marketCap: mcap,
      marketCapFormatted: mcap ? compactUsd(mcap) : null,
      createdAt,
      ageFormatted: formatAge(createdAt),
      buys5m: m5Buys,
      buys1h: h1Buys,
      lastBuyFormatted,
      description: info.description || '',
      twitter,
      telegram,
      website,
    }
  } catch (err) {
    throw new Error(err.message || 'Could not fetch token data from DexScreener')
  }
}
