/**
 * Wallet layer.
 *
 * Talks directly to the browser-injected provider (Phantom, Solflare, Backpack,
 * Coinbase Wallet, …). No WalletConnect relay, no third-party SDK sitting between
 * you and your keys, and no "connection" analytics event.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'

const WalletContext = createContext(null)

/** Every provider we know how to talk to, in display order. */
function detectProviders() {
  if (typeof window === 'undefined') return []
  const found = []
  const push = (id, label, provider) => {
    if (provider && typeof provider.connect === 'function') found.push({ id, label, provider })
  }
  push('phantom', 'Phantom', window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null))
  push('solflare', 'Solflare', window.solflare?.isSolflare ? window.solflare : null)
  push('backpack', 'Backpack', window.backpack?.isBackpack ? window.backpack : null)
  push('coinbase', 'Coinbase Wallet', window.coinbaseWalletProtocolProvider ?? null)
  push('glow', 'Glow', window.glow?.isGlow ? window.glow : null)
  // Generic fallback (Trust, Brave, OKX, TokenPocket all expose window.solana)
  if (window.solana && typeof window.solana.connect === 'function' && !found.length) {
    push('solana', window.solana.name || 'Browser wallet', window.solana)
  }
  const seen = new Set()
  return found.filter((p) => (seen.has(p.provider) ? false : (seen.add(p.provider), true)))
}

export function WalletProvider({ children }) {
  const [providers, setProviders] = useState(() => detectProviders())
  const [activeId, setActiveId] = useState(null)
  const [publicKey, setPublicKey] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(null)
  const [balance, setBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const listeners = useRef(new Map())

  // Providers inject asynchronously; keep looking for a moment after mount.
  useEffect(() => {
    if (providers.length) return
    let tries = 0
    const id = setInterval(() => {
      tries += 1
      const found = detectProviders()
      if (found.length) {
        setProviders(found)
        clearInterval(id)
      } else if (tries > 20) {
        clearInterval(id)
      }
    }, 250)
    return () => clearInterval(id)
  }, [providers.length])

  const active = useMemo(
    () => providers.find((p) => p.id === activeId) ?? null,
    [providers, activeId]
  )
  const isConnected = Boolean(active && publicKey)

  const disconnect = useCallback(async () => {
    const provider = active?.provider
    for (const [, off] of listeners.current) off?.()
    listeners.current.clear()
    setActiveId(null)
    setPublicKey(null)
    setBalance(null)
    try {
      await provider?.disconnect?.()
    } catch {
      /* provider already gone */
    }
  }, [active])

  const connect = useCallback(
    async (preferredId) => {
      setError(null)
      const candidates = providers.length ? providers : detectProviders()
      if (!candidates.length) {
        setError(
          'No Solana wallet found in this browser. Install Phantom or Solflare, or open this page inside a wallet browser.'
        )
        return null
      }
      const chosen =
        candidates.find((p) => p.id === (preferredId ?? activeId)) ?? candidates[0]
      setConnecting(true)
      try {
        const res = await chosen.provider.connect()
        const pk = res?.publicKey ?? chosen.provider.publicKey
        if (!pk) throw new Error('The wallet connected but returned no public key.')
        setActiveId(chosen.id)
        setPublicKey(new PublicKey(pk.toBase58 ? pk.toBase58() : pk))

        const onAccountChanged = (newPk) => {
          if (!newPk) {
            setPublicKey(null)
            setBalance(null)
          } else {
            setPublicKey(new PublicKey(newPk.toBase58()))
          }
        }
        const onDisconnect = () => {
          setPublicKey(null)
          setActiveId(null)
          setBalance(null)
        }
        if (typeof chosen.provider.on === 'function') {
          chosen.provider.on('accountChanged', onAccountChanged)
          chosen.provider.on('disconnect', onDisconnect)
          listeners.current.set(chosen.id, () => {
            try {
              chosen.provider.removeListener?.('accountChanged', onAccountChanged)
              chosen.provider.removeListener?.('disconnect', onDisconnect)
            } catch {
              /* noop */
            }
          })
        }
        return new PublicKey(pk.toBase58 ? pk.toBase58() : pk)
      } catch (err) {
        const msg = err?.message || String(err)
        // 4001 = user rejected the connect prompt. Say that plainly.
        setError(
          err?.code === 4001
            ? 'Connection request was rejected in your wallet.'
            : `Could not connect ${chosen.label}: ${msg}`
        )
        return null
      } finally {
        setConnecting(false)
      }
    },
    [providers, activeId]
  )

  const fetchBalance = useCallback(
    async (connection, pk) => {
      if (!connection || !pk) return null
      setBalanceLoading(true)
      try {
        const lamports = await connection.getBalance(pk, 'confirmed')
        setBalance(lamports)
        return lamports
      } catch (err) {
        setError(err?.message || 'Could not read balance')
        return null
      } finally {
        setBalanceLoading(false)
      }
    },
    []
  )

  const signTransaction = useCallback(
    async (tx) => {
      if (!active) throw new Error('No wallet connected.')
      if (typeof active.provider.signTransaction !== 'function') {
        throw new Error(`${active.label} cannot sign transactions from this page.`)
      }
      return active.provider.signTransaction(tx)
    },
    [active]
  )

  /**
   * Sign several transactions at once when the wallet supports it (Phantom and
   * Solflare both do). Otherwise fall back to one prompt per transaction so the
   * flow still works — the caller sends them sequentially either way.
   */
  const signAllTransactions = useCallback(
    async (txs) => {
      if (!active) throw new Error('No wallet connected.')
      if (Array.isArray(active.provider.signAllTransactions) || typeof active.provider.signAllTransactions === 'function') {
        try {
          return await active.provider.signAllTransactions(txs)
        } catch (err) {
          if (err?.code === 4001) throw err
          // Not supported → sequential fallback
        }
      }
      const signed = []
      for (const tx of txs) signed.push(await active.provider.signTransaction(tx))
      return signed
    },
    [active]
  )

  const supportsBatchSigning = Boolean(
    active && typeof active.provider?.signAllTransactions === 'function'
  )

  const value = useMemo(
    () => ({
      providers,
      active,
      activeId,
      publicKey,
      address: publicKey?.toBase58?.() ?? null,
      isConnected,
      connecting,
      error,
      clearError: () => setError(null),
      connect,
      disconnect,
      signTransaction,
      signAllTransactions,
      supportsBatchSigning,
      balance,
      balanceLamports: balance,
      balanceSol: balance === null ? null : balance / LAMPORTS_PER_SOL,
      balanceLoading,
      refreshBalance: fetchBalance,
    }),
    [
      providers,
      active,
      activeId,
      publicKey,
      isConnected,
      connecting,
      error,
      connect,
      disconnect,
      signTransaction,
      signAllTransactions,
      supportsBatchSigning,
      balance,
      balanceLoading,
      fetchBalance,
    ]
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}
