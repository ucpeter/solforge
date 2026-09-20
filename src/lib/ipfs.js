/**
 * Metadata & image hosting.
 *
 * Two honest options, and a third-party relay is never involved:
 *
 *  1. "Upload with my own Pinata key" — the JWT lives in your browser's
 *     localStorage, is sent only to Pinata, and the resulting IPFS CID is
 *     yours. There is no SolForge server that could silently control your
 *     token's metadata (that is exactly what the original did).
 *  2. "I'll paste a URI" — nothing is uploaded at all.
 */
import { isHttpUrl } from './format.js'

const PINATA_V3_BASE = 'https://uploads.pinata.cloud/v3'
const PINATA_V1_BASE = 'https://api.pinata.cloud/pinning'
export const DEFAULT_GATEWAY = 'https://gateway.pinata.cloud/ipfs'

export function gatewayUrl(cid, gateway = DEFAULT_GATEWAY) {
  const base = (gateway || DEFAULT_GATEWAY).replace(/\/+$/, '')
  if (cid.startsWith('ipfs://')) return `${base}/${cid.slice(7)}`
  if (isHttpUrl(cid)) return cid
  return `${base}/${cid}`
}

/** Normalise whatever Pinata returns into a bare CID. */
function extractCid(json) {
  return json?.cid || json?.IpfsHash || json?.ipfsHash || json?.data?.cid || null
}

async function readError(res) {
  let detail = ''
  try {
    const body = await res.json()
    detail = body?.error?.message || body?.error || body?.message || JSON.stringify(body)
  } catch {
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      detail = res.statusText
    }
  }
  return `Pinata responded ${res.status}: ${detail}`
}

/**
 * Upload a Blob/File to IPFS through Pinata using the caller's own JWT.
 * Tries the current v3 API first and falls back to v1 (still widely used).
 */
export async function uploadToPinata({ file, jwt, name }) {
  if (!jwt?.trim()) throw new Error('No Pinata API key set. Add one in Settings, or choose "paste a metadata URI".')

  // --- v3 ---------------------------------------------------------------
  try {
    const form = new FormData()
    form.append('file', file, name || file.name || 'upload')
    const res = await fetch(`${PINATA_V3_BASE}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.trim()}`, Accept: 'application/json' },
      body: form,
    })
    if (res.ok) {
      const cid = extractCid(await res.json())
      if (cid) return { cid, api: 'v3' }
    } else if (res.status !== 404 && res.status !== 405) {
      throw new Error(await readError(res))
    }
  } catch (err) {
    // A network/CORS failure here should still let v1 have a go.
    if (!/Failed to fetch|NetworkError|CORS/i.test(err?.message || '')) throw err
  }

  // --- v1 fallback ------------------------------------------------------
  const form = new FormData()
  form.append('file', file, name || file.name || 'upload')
  const res = await fetch(`${PINATA_V1_BASE}/pinFileToIPFS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt.trim()}`, Accept: 'application/json' },
    body: form,
  })
  if (!res.ok) throw new Error(await readError(res))
  const cid = extractCid(await res.json())
  if (!cid) throw new Error('Pinata accepted the upload but returned no CID.')
  return { cid, api: 'v1' }
}

export async function uploadJsonToPinata({ json, jwt, name = 'metadata.json' }) {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
  return uploadToPinata({ file: blob, jwt, name })
}

/* ------------------------------------------------------- metadata document */

/**
 * Build the fungible-token metadata document.
 *
 * Social links are written twice on purpose: inside `extensions` (the Metaplex
 * convention) and at the top level (what several indexers, DexScreener
 * included, read). Duplicating a few strings beats a token that launches with
 * no socials showing up.
 */
export function buildMetadataJson({ name, symbol, description, imageUri, socials = {} }) {
  const website = (socials.website || '').trim()
  const twitter = (socials.twitter || '').trim()
  const telegram = (socials.telegram || '').trim()
  const discord = (socials.discord || '').trim()

  const extensions = {}
  if (website) extensions.website = website
  if (twitter) extensions.twitter = twitter
  if (telegram) extensions.telegram = telegram
  if (discord) extensions.discord = discord

  const doc = {
    name: name.trim(),
    symbol: symbol.trim().toUpperCase(),
    description: description?.trim() || '',
    image: imageUri || '',
    attributes: [],
    properties: {
      files: imageUri ? [{ uri: imageUri, type: 'image' }] : [],
      category: imageUri ? 'image' : undefined,
    },
    extensions: Object.keys(extensions).length ? extensions : undefined,
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {}),
  }
  // Drop undefined keys so the JSON is clean.
  return JSON.parse(JSON.stringify(doc))
}

/* ------------------------------------------------------------- URI checks */

/**
 * Validate a user-supplied metadata URI by actually fetching it. Falls back to
 * a syntax-only check if the host blocks cross-origin reads (common for IPFS
 * gateways) — we say so rather than pretending we verified it.
 */
export async function inspectMetadataUri(uri, { timeoutMs = 12_000 } = {}) {
  const trimmed = String(uri || '').trim()
  if (!trimmed) return { ok: false, reason: 'empty', message: 'Enter a metadata URI, or upload an image and let this app build one.' }

  if (trimmed.startsWith('ipfs://')) {
    return { ok: true, uri: trimmed, verified: false, message: 'ipfs:// URIs are accepted; content was not fetched.' }
  }
  if (!isHttpUrl(trimmed)) {
    return { ok: false, uri: trimmed, verified: false, message: 'Not a valid http(s) or ipfs:// URI.' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(trimmed, { signal: controller.signal })
    if (!res.ok) return { ok: false, uri: trimmed, verified: true, message: `Fetch failed: HTTP ${res.status}` }
    const json = await res.json()
    const problems = []
    if (!json?.name) problems.push('no "name"')
    if (!json?.symbol) problems.push('no "symbol"')
    if (!json?.image) problems.push('no "image"')
    return {
      ok: problems.length === 0,
      uri: trimmed,
      verified: true,
      json,
      message: problems.length ? `Fetched, but the JSON is missing: ${problems.join(', ')}` : 'Fetched and parsed successfully.',
    }
  } catch (err) {
    const blocked = /Failed to fetch|abort|CORS|NetworkError/i.test(err?.message || '')
    return {
      ok: blocked, // not fatal — gateways often block browser reads
      uri: trimmed,
      verified: false,
      message: blocked
        ? 'Could not fetch from this browser (CORS or network). The URI will still be used — verify it opens in a new tab.'
        : `Fetch failed: ${err?.message || err}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
