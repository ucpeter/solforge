/**
 * Network layer: cluster selection, RPC connection, and *real* network stats.
 *
 * The original site hardcoded "Gas: 0.00002 SOL · TPS: 3,102" in its footer and
 * never queried anything. Here every figure is fetched from the RPC you chose,
 * stamped with the time it was read, and labelled as such.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Connection, clusterApiUrl } from '@solana/web3.js'
import { NETWORKS, DEFAULT_NETWORK } from './config.js'
import { loadNetwork, saveNetwork, loadSettings } from './registry.js'

const NetworkContext = createContext(null)

function buildConnection(networkId, customRpc) {
  const net = NETWORKS[networkId] ?? NETWORKS[DEFAULT_NETWORK]
  const endpoint = (customRpc || '').trim() || net.defaultRpc || clusterApiUrl(net.cluster)
  return new Connection(endpoint, {
    commitment: 'confirmed',
    // Retries matter more than speed when a user is mid-flow and watching a tx.
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: false,
  })
}

export function NetworkProvider({ children }) {
  const [networkId, setNetworkId] = useState(() => {
    try {
      return loadNetwork()
    } catch {
      return DEFAULT_NETWORK
    }
  })
  const [rpcOverride, setRpcOverride] = useState(() => {
    try {
      return loadSettings().customRpc || ''
    } catch {
      return ''
    }
  })
  const [stats, setStats] = useState(null)
  const [statsError, setStatsError] = useState(null)
  const [statsFetchedAt, setStatsFetchedAt] = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const connection = useMemo(() => buildConnection(networkId, rpcOverride), [networkId, rpcOverride])
  const endpoint = useMemo(
    () => (rpcOverride || '').trim() || (NETWORKS[networkId]?.defaultRpc ?? clusterApiUrl(networkId)),
    [networkId, rpcOverride]
  )

  const selectNetwork = useCallback((id) => {
    if (!NETWORKS[id]) return
    saveNetwork(id)
    setNetworkId(id)
    setStats(null)
  }, [])

  const setCustomRpc = useCallback((url) => {
    setRpcOverride(url || '')
  }, [])

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
    } finally {
      setStatsLoading(false)
    }
  }, [connection])

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
      rpcOverride,
      setCustomRpc,
      stats,
      statsError,
      statsFetchedAt,
      statsLoading,
      refreshStats,
      isMainnet: networkId === 'mainnet-beta',
    }),
    [
      networkId,
      selectNetwork,
      connection,
      endpoint,
      rpcOverride,
      setCustomRpc,
      stats,
      statsError,
      statsFetchedAt,
      statsLoading,
      refreshStats,
    ]
  )

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
}

export function useNetwork() {
  const ctx = useContext(NetworkContext)
  if (!ctx) throw new Error('useNetwork must be used inside <NetworkProvider>')
  return ctx
}
