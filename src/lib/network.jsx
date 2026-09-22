/**
 * Network layer: cluster selection, RPC connection, and *real* network stats.
 *
 * The original site hardcoded "Gas: 0.00002 SOL · TPS: 3,102" in its footer and
 * never queried anything. Here every figure is fetched from the RPC you chose,
 * stamped with the time it was read, and labelled as such.
 *
 * RPC resilience: public cluster RPCs block or rate-limit per IP — the official
 * mainnet endpoint, for example, returns 403 "Access forbidden" for many phone
 * networks. When the active endpoint rejects requests (or is unreachable) and
 * you have NOT set a custom RPC, the app probes the other public endpoints in
 * the cluster's fallback list and switches to the first one that answers. The
 * working endpoint is remembered per cluster so the next visit goes straight
 * to it. A custom RPC from Settings always wins — the app never overrides it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Connection } from '@solana/web3.js'
import { NETWORKS, DEFAULT_NETWORK, STORAGE_KEYS } from './config.js'
import { loadNetwork, saveNetwork, loadSettings } from './registry.js'

const NetworkContext = createContext(null)

/**
 * Extra public endpoints tried (in order) after the cluster default.
 * All are keyless public RPCs; availability varies by network, which is
 * exactly why we probe instead of assuming.
 */
const EXTRA_PUBLIC = {
  devnet: ['https://solana-devnet-rpc.publicnode.com'],
  'mainnet-beta': [
    // Official alias (a different edge than the default host).
    'https://api.mainnet.solana.com',
    'https://endpoints.omniatech.io/v1/sol/mainnet/public',
    'https://solana-mainnet.public.blastapi.io',
  ],
}

function fallbacksFor(networkId) {
  const net = NETWORKS[networkId] ?? NETWORKS[DEFAULT_NETWORK]
  const list = [net.defaultRpc, ...(EXTRA_PUBLIC[networkId] ?? [])]
  return [...new Set(list.map((u) => u.trim()).filter(Boolean))]
}

/**
 * Infer the cluster an RPC URL is meant for, from its host.
 * Returns 'devnet' | 'testnet' | 'mainnet-beta', or null when the URL gives no
 * hint (self-hosted node, IP address, …) — in which case no warning is shown.
 *
 * Why this matters: a custom RPC is ONE URL applied to whichever cluster the
 * app is on. A mainnet URL used while on devnet cannot see devnet wallets, so
 * every transaction fails with AccountNotFound. Catch that mix-up loudly.
 */
export function inferClusterFromUrl(url) {
  try {
    const host = new URL(url.trim()).host.toLowerCase()
    if (host.includes('devnet')) return 'devnet'
    if (host.includes('testnet')) return 'testnet'
    if (host.includes('mainnet')) return 'mainnet-beta'
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------- remembered endpoint */

function loadFallbackMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.rpcFallback) || 'null')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}
function saveFallbackIndex(networkId, idx) {
  const map = loadFallbackMap()
  map[networkId] = idx
  try {
    localStorage.setItem(STORAGE_KEYS.rpcFallback, JSON.stringify(map))
  } catch {
    /* private mode etc. */
  }
}

/* --------------------------------------------------------------- probing */

const PROBE_COOLDOWN_MS = 45_000

/** Cheap liveness check: one getSlot with a hard timeout. */
async function endpointWorks(url) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8_000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok) return false
    const j = await res.json()
    return typeof j?.result === 'number'
  } catch {
    return false
  }
}

function buildConnection(endpoint) {
  return new Connection(endpoint, {
    commitment: 'confirmed',
    // Retries matter more than speed when a user is mid-flow and watching a tx.
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: false,
  })
}

/* -------------------------------------------------------------- provider */

export function NetworkProvider({ children }) {
  const [networkId, setNetworkId] = useState(() => {
    try {
      return loadNetwork()
    } catch {
      return DEFAULT_NETWORK
    }
  })
  const [rpcSettings, setRpcSettings] = useState(() => {
    try {
      const s = loadSettings()
      return {
        customRpc: s.customRpc || '',
        customRpcDevnet: s.customRpcDevnet || '',
        customRpcMainnet: s.customRpcMainnet || '',
      }
    } catch {
      return { customRpc: '', customRpcDevnet: '', customRpcMainnet: '' }
    }
  })

  // Active custom RPC is specific to the current network cluster.
  // Backward compatibility: if per-cluster setting is not set, use customRpc.
  const rpcOverride = useMemo(() => {
    if (networkId === 'mainnet-beta') {
      return rpcSettings.customRpcMainnet || rpcSettings.customRpc || ''
    }
    return rpcSettings.customRpcDevnet || ''
  }, [networkId, rpcSettings])
  const [fallbackIdx, setFallbackIdx] = useState(() => {
    const map = loadFallbackMap()
    const i = Number(map[loadNetworkSafe()])
    return Number.isInteger(i) && i >= 0 ? i : 0
  })
  const [stats, setStats] = useState(null)
  const [statsError, setStatsError] = useState(null)
  const [statsFetchedAt, setStatsFetchedAt] = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const custom = (rpcOverride || '').trim()
  const list = useMemo(() => fallbacksFor(networkId), [networkId])
  const endpoint = useMemo(() => {
    if (custom) return custom
    return list[Math.min(fallbackIdx, list.length - 1)]
  }, [custom, list, fallbackIdx])

  const connection = useMemo(() => buildConnection(endpoint), [endpoint])

  const endpointSource = custom
    ? 'your override (Settings)'
    : Math.min(fallbackIdx, list.length - 1) > 0
      ? `public fallback ${Math.min(fallbackIdx, list.length - 1) + 1}/${list.length} (auto)`
      : 'cluster default'

  const lastProbeAt = useRef(0)
  const probeFallbacks = useCallback(async () => {
    if (custom) return // a user-chosen RPC is never overridden
    const now = Date.now()
    if (now - lastProbeAt.current < PROBE_COOLDOWN_MS) return
    lastProbeAt.current = now
    const list = fallbacksFor(networkId)
    // Try the others first, wrap around.
    for (let step = 1; step < list.length; step++) {
      const idx = (fallbackIdx + step) % list.length
      if (await endpointWorks(list[idx])) {
        setFallbackIdx(idx)
        saveFallbackIndex(networkId, idx)
        return
      }
    }
  }, [custom, networkId, fallbackIdx])

  const selectNetwork = useCallback((id) => {
    if (!NETWORKS[id]) return
    saveNetwork(id)
    setNetworkId(id)
    setStats(null)
    const remembered = loadFallbackMap()[id]
    const i = Number(remembered)
    setFallbackIdx(Number.isInteger(i) && i >= 0 ? i : 0)
  }, [])

  const setCustomRpc = useCallback((url, cluster = null) => {
    const targetCluster = cluster || networkId
    setRpcSettings((prev) => {
      const next = { ...prev }
      if (targetCluster === 'mainnet-beta') {
        next.customRpcMainnet = url || ''
        next.customRpc = url || ''
      } else {
        next.customRpcDevnet = url || ''
      }
      return next
    })
  }, [networkId])

  /**
   * Real network conditions:
   *  - TPS from getRecentPerformanceSamples (actual confirmed tx/s)
   *  - priority-fee guidance from getRecentPrioritizationFees (75th/95th pct)
   *  - current slot, and whether the RPC is reachable at all
   */
  const refreshStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const [samples, prioritization, slot] = await Promise.all([
        connection.getRecentPerformanceSamples(20).catch(() => []),
        connection.getRecentPrioritizationFees().catch(() => []),
        connection.getSlot('confirmed'),
      ])

      let tps = null
      if (samples?.length) {
        const perSecond = samples
          .filter((s) => s.samplePeriodSecs > 0)
          .map((s) => s.numTransactions / s.samplePeriodSecs)
        if (perSecond.length) {
          tps = perSecond.reduce((a, b) => a + b, 0) / perSecond.length
        }
      }

      const fees = (prioritization || [])
        .map((f) => Number(f.prioritizationFee) || 0)
        .filter((f) => f > 0)
        .sort((a, b) => a - b)
      const pct = (p) => (fees.length ? fees[Math.min(fees.length - 1, Math.floor(fees.length * p))] : 0)

      setStats({
        slot,
        tps: tps === null ? null : Math.round(tps),
        priorityFee: {
          median: pct(0.5),
          p75: pct(0.75),
          p95: pct(0.95),
          samples: fees.length,
        },
      })
      setStatsFetchedAt(Date.now())
    } catch (err) {
      setStatsError(err?.message || 'Could not reach the RPC endpoint')
      // The endpoint may be blocking this network — look for a working one.
      probeFallbacks()
    } finally {
      setStatsLoading(false)
    }
  }, [connection, probeFallbacks])

  // Fetch once per connection change, then every 30s while the tab is visible.
  const timer = useRef(null)
  useEffect(() => {
    refreshStats()
    timer.current = setInterval(() => {
      if (document.visibilityState === 'visible') refreshStats()
    }, 30_000)
    return () => clearInterval(timer.current)
  }, [refreshStats])

  const value = useMemo(
    () => ({
      network: NETWORKS[networkId] ?? NETWORKS[DEFAULT_NETWORK],
      networkId,
      selectNetwork,
      connection,
      endpoint,
      endpointSource,
      rpcOverride,
      setCustomRpc,
      stats,
      statsError,
      statsFetchedAt,
      statsLoading,
      refreshStats,
      probeFallbacks,
      isMainnet: networkId === 'mainnet-beta',
    }),
    [
      networkId,
      selectNetwork,
      connection,
      endpoint,
      endpointSource,
      rpcOverride,
      setCustomRpc,
      stats,
      statsError,
      statsFetchedAt,
      statsLoading,
      refreshStats,
      probeFallbacks,
    ]
  )

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
}

function loadNetworkSafe() {
  try {
    return loadNetwork()
  } catch {
    return DEFAULT_NETWORK
  }
}

export function useNetwork() {
  const ctx = useContext(NetworkContext)
  if (!ctx) throw new Error('useNetwork must be used inside <NetworkProvider>')
  return ctx
}
