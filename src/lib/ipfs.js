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

/**
 * Which IPFS network Pinata actually stored the file on.
 *
 * The v3 API defaults this to "private" when the caller does not say otherwise,
 * and private files are deliberately unreachable through public gateways. For
 * token metadata that is fatal: wallets and explorers fetch over public IPFS,
 * so the logo simply never appears. We read it back so we can refuse to
 * continue on a private upload rather than finding out after launch.
 */
function extractNetwork(json) {
  return json?.network || json?.data?.network || null
}

/** Pull a human string out of whatever shape Pinata's error body has. */
function pickMessage(v) {
  if (!v) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return v.message || v.msg || v.error || JSON.stringify(v)
  return String(v)
}

async function readError(res) {
  let detail = ''
  try {
    const body = await res.json()
    detail = pickMessage(body?.error?.message ?? body?.error ?? body?.message ?? body) || JSON.stringify(body)
  } catch {
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      detail = res.statusText
    }
  }
  let msg = `Pinata responded ${res.status}: ${detail}`
  if (res.status === 401 || res.status === 403) {
    msg +=
      ' — Pinata rejected the key. A valid Pinata JWT is a very long string (400+ characters) starting with "eyJ". ' +
      'In Settings, re-copy the full JWT from pinata.cloud (Account → API Keys); a short hex code is the key ID, not the JWT.'
  }
  return msg
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
    // v3 defaults `network` to PRIVATE when it is not sent. Private files are
    // not served over public IPFS, so token metadata uploaded that way can
    // never be read by wallets or explorers. Always ask for public.
    form.append('network', 'public')
    const res = await fetch(`${PINATA_V3_BASE}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.trim()}`, Accept: 'application/json' },
      body: form,
    })
    if (res.ok) {
      const json = await res.json()
      const cid = extractCid(json)
      if (cid) {
        const network = extractNetwork(json)
        // Belt and braces: if Pinata still reports private, stop immediately
        // rather than writing a URI that can never resolve.
        if (network && network !== 'public') {
          throw new Error(
            `Pinata stored this file on its "${network}" network. Private files are not ` +
              'reachable through public IPFS, so wallets and explorers would never load it. ' +
              'In pinata.cloud → Files, switch the file to Public and upload again.',
          )
        }
        return { cid, api: 'v3', network: network ?? 'public' }
      }
    } else if (res.status !== 404 && res.status !== 405) {
      throw new Error(await readError(res))
    }
  } catch (err) {
    // A network/CORS failure here should still let v1 have a go.
    const transient = /Failed to fetch|NetworkError|CORS/i.test(err?.message || '')
    if (!transient) throw err
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
  const json = await res.json()
  const cid = extractCid(json)
  if (!cid) throw new Error('Pinata accepted the upload but returned no CID.')
  // The v1 pinFileToIPFS endpoint has no public/private concept — it pins public.
  return { cid, api: 'v1', network: extractNetwork(json) ?? 'public' }
}

/* ----------------------------------------------------- post-upload checks */

/**
 * Confirm that a CID is genuinely retrievable through the gateway.
 *
 * Pinata can answer an upload with HTTP 200 and a perfectly well-formed CID
 * while never actually storing the bytes — usually because the account is out
 * of storage quota. The gateway then reports ERR_ID:00016 ("timed out searching
 * for a file on the non-pinata IPFS network"). Taking the CID at face value
 * writes a dead URI on-chain, and if the token is immutable that mistake is
 * permanent. So: check before we let anyone launch.
 *
 * Retries because IPFS propagation is not instant — a brand new CID can take a
 * few seconds to start resolving even when everything is healthy.
 */
export async function verifyCid({
  cid,
  gateway = DEFAULT_GATEWAY,
  attempts = 4,
  timeoutMs = 12000,
  onAttempt,
} = {}) {
  const url = gatewayUrl(cid, gateway)
  let lastError = 'unknown error'

  for (let i = 0; i < attempts; i++) {
    onAttempt?.({ attempt: i + 1, attempts, url })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      clearTimeout(timer)
      if (res.ok) {
        const text = await res.text()
        if (text && text.trim()) {
          return { ok: true, url, text, bytes: text.length, attempts: i + 1 }
        }
        lastError = 'the gateway returned an empty response'
      } else {
        lastError = `the gateway returned HTTP ${res.status}`
      }
    } catch (err) {
      clearTimeout(timer)
      lastError =
        err?.name === 'AbortError'
          ? `no response from the gateway within ${Math.round(timeoutMs / 1000)}s`
          : err?.message || 'the request failed'
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
  return { ok: false, url, error: lastError }
}

/**
 * Validate the shape of a metadata document: real JSON, carrying an image.
 * Returns the parsed doc so callers can check the image URL too.
 */
export function inspectMetadataDocument(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'the file is not valid JSON' }
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, problem: 'the JSON is not an object' }
  }
  const image = typeof doc.image === 'string' ? doc.image.trim() : ''
  if (!image) {
    return {
      ok: false,
      problem: 'the JSON has no "image" field, so wallets and explorers will show no logo',
    }
  }
  return { ok: true, doc, image, name: doc.name, symbol: doc.symbol }
}

/**
 * Does this image URL actually load?
 *
 * Uses an <img> rather than fetch on purpose: image loads are not subject to
 * CORS, so a working image on another host will not be falsely reported broken.
 */
export function checkImageLoads(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!url) return resolve(false)
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    try {
      const img = new Image()
      img.onload = () => finish(true)
      img.onerror = () => finish(false)
      img.src = url
    } catch {
      finish(false)
    }
  })
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
