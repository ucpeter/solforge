/** Small, dependency-light formatting + validation helpers. */
import { PublicKey } from '@solana/web3.js'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'

const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** On-chain metadata limits are in BYTES, not characters — "Doge🌙" is 8 bytes. */
export function byteLength(str) {
  if (!str) return 0
  if (utf8) return utf8.encode(str).length
  return new Blob([str]).size
}

export function isValidPublicKey(value) {
  if (!value || typeof value !== 'string') return false
  try {
    return PublicKey.isOnCurve ? true && !!new PublicKey(value.trim()) : !!new PublicKey(value.trim())
  } catch {
    return false
  }
}

export function shorten(addr, head = 4, tail = 4) {
  if (!addr) return ''
  const s = typeof addr === 'string' ? addr : addr.toBase58?.() ?? String(addr)
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function lamportsToSol(lamports) {
  return Number(lamports ?? 0) / LAMPORTS_PER_SOL
}

/** Format a lamport amount as SOL with enough precision to never round to 0. */
export function formatSol(lamports, maxDecimals = 9) {
  const sol = lamportsToSol(lamports)
  if (sol === 0) return '0 SOL'
  const abs = Math.abs(sol)
  const digits = abs < 0.0001 ? 9 : abs < 1 ? 6 : maxDecimals > 4 ? 4 : maxDecimals
  return `${sol.toLocaleString(undefined, { maximumFractionDigits: digits })} SOL`
}

/** Convert a raw token amount (BN/string/number) to a UI amount. */
export function toUiAmount(raw, decimals) {
  if (raw === null || raw === undefined) return 0
  const s = typeof raw === 'string' ? raw : raw.toString()
  if (!/^\d+$/.test(s)) return Number(s) || 0
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const padded = body.padStart(decimals + 1, '0')
  const int = padded.slice(0, padded.length - decimals) || '0'
  const frac = decimals > 0 ? padded.slice(padded.length - decimals) : ''
  const trimmed = frac.replace(/0+$/, '')
  return Number(`${neg ? '-' : ''}${int}${trimmed ? `.${trimmed}` : ''}`)
}

/** Convert a UI amount to a raw integer string, truncating (never rounding up). */
/** Largest value that fits in an on-chain u64. */
export const U64_MAX = 18446744073709551615n

export function toRawAmount(ui, decimals) {
  if (ui === null || ui === undefined || ui === '') return '0'
  const str = String(ui).trim().replace(/,/g, '')
  if (!/^\d*\.?\d*$/.test(str) || str === '' || str === '.') return '0'
  const [int = '0', frac = ''] = str.split('.')
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  const raw = (int + fracPadded).replace(/^0+/, '')
  return raw === '' ? '0' : raw
}

export function formatNumber(value, maxDecimals = 6) {
  const n = Number(value)
  if (!isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : maxDecimals
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function compactUsd(n) {
  const v = Number(n)
  if (!isFinite(v)) return '—'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

export function formatDateTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** A real URL check, used to validate pasted metadata URIs and social links. */
export function isHttpUrl(value) {
  try {
    const u = new URL(String(value).trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function isIpfsUrl(value) {
  const v = String(value || '').trim()
  return v.startsWith('ipfs://') || /^https?:\/\/[^/]*ipfs[^/]*\//i.test(v) || isHttpUrl(v)
}

export function clsx(...parts) {
  return parts.filter(Boolean).join(' ')
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
