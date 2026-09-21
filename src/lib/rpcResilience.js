/**
 * Shared RPC resilience for the read-heavy pages (Portfolio, Liquidity →
 * Pool holdings).
 *
 * Public devnet RPCs rate-limit per IP, and Render's shared hosting IPs get
 * hammered by lots of apps. Three things make the app survive that:
 *   1. withRetries — backoff on 429s before surfacing an error
 *   2. positionsCache — a 15-second TTL cache for the heavy positions read,
 *      SHARED between the Portfolio page and the Pool holdings tab, so
 *      switching between them costs zero extra RPC calls
 *   3. decimalsCache — mint decimals never change, so look them up once
 *
 * describeError turns raw JSON-RPC errors into a sentence a human can act on.
 */
import { WSOL } from './liquidity.js'

const CACHE_TTL_MS = 15_000

/* ------------------------------------------------------------- positions */

export const positionsCache = { key: null, data: null, at: 0 }

export function positionsCacheFresh(key) {
  return positionsCache.key === key &&
    positionsCache.data !== null &&
    Date.now() - positionsCache.at < CACHE_TTL_MS
    ? positionsCache.data
    : null
}

/** Last known data even if stale — used as a fallback when a refresh fails. */
export function positionsCacheStale(key) {
  return positionsCache.key === key && positionsCache.data !== null
    ? positionsCache.data
    : null
}

export function positionsCacheSet(key, data) {
  positionsCache.key = key
  positionsCache.data = data
  positionsCache.at = Date.now()
}

/* ------------------------------------------------------------------ retry */

export async function withRetries(fn, { attempts = 3, baseDelayMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const rateLimited = /429|too many requests/i.test(String(err?.message ?? ''))
      if (!rateLimited || i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)))
    }
  }
}

/* ------------------------------------------------------------------ error */

export function describeError(err) {
  const msg = String(err?.message ?? err ?? 'Unknown error')
  if (/429|too many requests/i.test(msg)) {
    return 'The public devnet RPC rate-limited this request. Tap Retry, or set a custom RPC in Settings — a free Helius or Triton devnet key makes it go away.'
  }
  return msg
}

/* --------------------------------------------------------------- decimals */

// Mint → decimals, for the life of the page. Decimals are immutable on-chain.
const decimalsCache = {}

export async function getMintDecimals(connection, mint) {
  const s = mint.toBase58()
  if (decimalsCache[s] !== undefined) return decimalsCache[s]
  if (WSOL.equals(mint)) {
    decimalsCache[s] = 9
    return 9
  }
  const parsed = await connection.getParsedAccountInfo(mint, { encoding: 'jsonParsed' })
  const d = parsed?.value?.data?.parsed?.info?.decimals
  if (typeof d !== 'number') throw new Error('not a mint')
  decimalsCache[s] = d
  return d
}

/** Synchronous read of the decimals cache (9 fallback — used after warm-up). */
export function decimalsOf(mint) {
  return decimalsCache[mint.toBase58?.() ?? String(mint)] ?? 9
}

/** Pre-seed known decimals (e.g. from the local token registry) — no RPC. */
export function seedMintDecimals(mintBase58, decimals) {
  if (Number.isFinite(decimals) && decimals >= 0) decimalsCache[mintBase58] = decimals
}
