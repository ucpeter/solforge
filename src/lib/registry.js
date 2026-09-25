/**
 * Local persistence: your settings, and the registry of tokens/pools you created.
 *
 * Everything here is browser-local. There is no backend, so nothing is uploaded,
 * synced or sold. Settings → Local data lists every key and lets you wipe it.
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS, STORAGE_DESCRIPTIONS, DEFAULT_NETWORK, NETWORKS } from './config.js'

function safeParse(raw, fallback) {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ settings */

export function loadSettings() {
  const stored = safeParse(localStorage.getItem(STORAGE_KEYS.settings), {})
  return { ...DEFAULT_SETTINGS, ...stored }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(next))
  return next
}

/* ------------------------------------------------------------------- network */

export function loadNetwork() {
  const raw = localStorage.getItem(STORAGE_KEYS.network)
  return NETWORKS[raw] ? raw : DEFAULT_NETWORK
}

export function saveNetwork(id) {
  if (NETWORKS[id]) localStorage.setItem(STORAGE_KEYS.network, id)
}

/* ------------------------------------------------------------------ registry */

function readList(key) {
  const raw = safeParse(localStorage.getItem(key), [])
  return Array.isArray(raw) ? raw : []
}

function writeList(key, list) {
  localStorage.setItem(key, JSON.stringify(list.slice(0, 500)))
  return list
}

/** Tokens created through this app, newest first. Filtered by cluster when specified. */
export function listCreatedTokens(networkId = null) {
  const all = readList(STORAGE_KEYS.tokens)
  if (!networkId) return all
  return all.filter((t) => {
    // Legacy entries without explicit cluster tag default to devnet (where all initial testing was done)
    const cluster = t.networkId || 'devnet'
    return cluster === networkId
  })
}

export function addCreatedToken(entry) {
  const list = readList(STORAGE_KEYS.tokens).filter((t) => t.mint !== entry.mint)
  list.unshift({ ...entry, createdAt: Date.now() })
  return writeList(STORAGE_KEYS.tokens, list)
}

export function removeCreatedToken(mint) {
  return writeList(
    STORAGE_KEYS.tokens,
    readList(STORAGE_KEYS.tokens).filter((t) => t.mint !== mint)
  )
}

export function getTokenByMint(mint, networkId = null) {
  return listCreatedTokens(networkId).find((t) => t.mint === mint) || null
}

/** Pools created through this app, newest first. Filtered by cluster when specified. */
export function listCreatedPools(networkId = null) {
  const all = readList(STORAGE_KEYS.pools)
  if (!networkId) return all
  return all.filter((p) => {
    const cluster = p.networkId || 'devnet'
    return cluster === networkId
  })
}

export function addCreatedPool(entry) {
  const list = readList(STORAGE_KEYS.pools).filter((p) => p.pool !== entry.pool)
  list.unshift({ ...entry, createdAt: Date.now() })
  return writeList(STORAGE_KEYS.pools, list)
}

export function removeCreatedPool(pool) {
  return writeList(
    STORAGE_KEYS.pools,
    readList(STORAGE_KEYS.pools).filter((p) => p.pool !== pool)
  )
}

/* --------------------------------------------------------------- transparency */

/** Used by the Settings page to show exactly what this app has stored. */
export function describeStorage() {
  return Object.keys(STORAGE_KEYS)
    .map((k) => STORAGE_KEYS[k])
    .concat([STORAGE_KEYS.acknowledgedMainnet])
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((key) => {
      const raw = localStorage.getItem(key)
      let bytes = raw ? raw.length : 0
      let summary = 'empty'
      if (raw) {
        if (key === STORAGE_KEYS.tokens || key === STORAGE_KEYS.pools) {
          const list = safeParse(raw, [])
          summary = `${Array.isArray(list) ? list.length : 0} record(s)`
        } else if (key === STORAGE_KEYS.settings) {
          const s = safeParse(raw, {})
          const hasDev = s.customRpcDevnet ? 'devnet' : ''
          const hasMain = s.customRpcMainnet || s.customRpc ? 'mainnet' : ''
          const rpcSummary = [hasDev, hasMain].filter(Boolean).join('+') || 'none'
          summary = `RPC: ${rpcSummary} · Pinata: ${s.pinataJwt ? 'set' : 'no'}`
        } else {
          summary = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
        }
      }
      return { key, bytes, summary, description: STORAGE_DESCRIPTIONS[key] ?? '' }
    })
}

export function clearAllLocalData() {
  const removed = []
  for (const key of Object.values(STORAGE_KEYS)) {
    if (localStorage.getItem(key) !== null) removed.push(key)
    localStorage.removeItem(key)
  }
  return removed
}
