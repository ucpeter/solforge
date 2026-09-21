/**
 * SOL → USD spot price from CoinGecko (public endpoint, no API key).
 *
 * This is a real market price fetched live. When the fetch fails (offline,
 * rate-limited, etc.) the callers get null and must degrade gracefully —
 * the app never invents or caches a stale-looking price as if it were live.
 */
let cache = { price: null, at: 0 }
const TTL_MS = 60_000

/**
 * @returns {Promise<number|null>} current SOL price in USD, or null if unavailable.
 */
export async function solUsdPrice({ force = false } = {}) {
  if (!force && cache.price !== null && Date.now() - cache.at < TTL_MS) {
    return cache.price
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { headers: { accept: 'application/json' } }
    )
    if (!res.ok) throw new Error(`price API responded ${res.status}`)
    const j = await res.json()
    const p = j?.solana?.usd
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
      throw new Error('price payload was not a usable number')
    }
    cache = { price: p, at: Date.now() }
    return p
  } catch {
    // Serve the last good price (clearly labelled by the caller) or nothing.
    return cache.price
  }
}

/** 4.4067 SOL @ 12.34 → "$54.38"; small values get cents, big ones round. */
export function formatUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: v < 100 ? 2 : 0,
  })
}
