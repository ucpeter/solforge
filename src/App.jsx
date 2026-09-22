/**
 * App shell — providers, header, navigation, page switching.
 */
import { useEffect, useState } from 'react'
import { NetworkProvider, useNetwork, inferClusterFromUrl } from './lib/network.jsx'
import { WalletProvider, useWallet } from './lib/wallet.jsx'
import { NETWORKS, BRAND } from './lib/config.js'
import { Button, Banner, Modal, Sol } from './components/ui.jsx'
import Create from './pages/Create.jsx'
import Liquidity from './pages/Liquidity.jsx'
import Portfolio from './pages/Portfolio.jsx'
import Settings from './pages/Settings.jsx'
import About from './pages/About.jsx'
import { clsx } from './lib/format.js'
import { describeError } from './lib/rpcResilience.js'

export default function App() {
  return (
    <NetworkProvider>
      <WalletProvider>
        <Shell />
      </WalletProvider>
    </NetworkProvider>
  )
}

function Shell() {
  const { networkId, rpcOverride } = useNetwork()
  const [page, setPage] = useState('create')
  const [manageMint, setManageMint] = useState(null)
  const [manageTab, setManageTab] = useState(null)

  function openManager(mint, tab) {
    setManageMint(mint ?? null)
    setManageTab(tab ?? null)
    setPage('liquidity')
  }

  const customCluster = inferClusterFromUrl(rpcOverride)
  const hasMismatch = customCluster && customCluster !== networkId

  return (
    <div className="app">
      <Header page={page} setPage={setPage} />
      {hasMismatch && (
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '12px 16px 0' }}>
          <Banner tone="warn" title="RPC Cluster Mismatch">
            Your custom RPC is configured for <strong>{customCluster === 'mainnet-beta' ? 'Mainnet' : customCluster}</strong>, but SolForge is currently set to <strong>{networkId === 'mainnet-beta' ? 'Mainnet' : networkId}</strong>. Transactions will fail with "AccountNotFound" because {customCluster} cannot see {networkId} wallets. Go to <button className="linkish" onClick={() => setPage('settings')} style={{ textDecoration: 'underline', fontWeight: 600 }}>Settings</button> to reset it or switch networks.
          </Banner>
        </div>
      )}
      <main className="app__main">
        {page === 'create' && <Create />}
        {page === 'liquidity' && (
          <Liquidity
            manageMint={manageMint}
            manageTab={manageTab}
            onManageConsumed={() => {
              setManageMint(null)
              setManageTab(null)
            }}
          />
        )}
        {page === 'settings' && <Settings />}
        {page === 'portfolio' && (
          <Portfolio
            onManage={(mint) => openManager(mint, 'create')}
            onPositions={() => openManager(null, 'positions')}
          />
        )}
        {page === 'about' && <About />}
      </main>
      <footer className="app__foot">
        <span>{BRAND.name} — zero platform fee, no analytics, everything simulated before you sign.</span>
      </footer>
    </div>
  )
}

function Header({ page, setPage }) {
  const { network, networkId, selectNetwork, stats, statsLoading, statsError } = useNetwork()
  const wallet = useWallet()
  const [mainnetConfirm, setMainnetConfirm] = useState(false)

  function pickNetwork(id) {
    if (id === 'mainnet-beta' && networkId !== 'mainnet-beta') {
      setMainnetConfirm(true)
      return
    }
    selectNetwork(id)
  }

  return (
    <header className="hdr">
      <div className="hdr__inner">
        <div className="hdr__brand" onClick={() => setPage('create')}>
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#101a2e" />
            <path d="M8 20.5h9.2l-2.4 3.2H8zM14.8 8.3H24l-2.4 3.2h-9.2zM8 12.9h9.2l-2.4 3.2H8z" fill="#4fd1c5" />
          </svg>
          <span className="hdr__name">{BRAND.name}</span>
        </div>

        <nav className="hdr__nav" aria-label="Main">
          {[
            ['create', 'Create token'],
            ['liquidity', 'Liquidity'],
            ['portfolio', 'Portfolio'],
            ['settings', 'Settings'],
            ['about', 'About'],
          ].map(([id, label]) => (
            <button
              key={id}
              className={clsx('hdr__link', page === id && 'hdr__link--active')}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="hdr__right">
          <div className="netseg" role="group" aria-label="Cluster">
            {Object.values(NETWORKS).map((n) => (
              <button
                key={n.id}
                className={clsx('netseg__btn', networkId === n.id && 'netseg__btn--on', n.realMoney && 'netseg__btn--main')}
                onClick={() => pickNetwork(n.id)}
              >
                {n.shortLabel}
              </button>
            ))}
          </div>

          <NetworkStats />

          {wallet.isConnected ? (
            <div className="walletbox">
              <span className="walletbox__addr" title={wallet.address}>
                {wallet.address?.slice(0, 4)}…{wallet.address?.slice(-4)}
              </span>
              {wallet.balanceSol !== null && <Sol lamports={wallet.balanceLamports} precision={4} />}
              <button className="linkish" onClick={wallet.disconnect}>
                switch
              </button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={wallet.connecting}
              onClick={() => wallet.connect(wallet.providers[0]?.id)}
            >
              {wallet.providers.length ? 'Connect wallet' : 'No wallet detected'}
            </Button>
          )}
        </div>
      </div>

      {wallet.error && (
        <Banner tone="danger" title={wallet.error} onDismiss={wallet.clearError} />
      )}

      <Modal
        open={mainnetConfirm}
        onClose={() => setMainnetConfirm(false)}
        title="Switch to mainnet?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMainnetConfirm(false)}>
              Stay on devnet
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                selectNetwork('mainnet-beta')
                setMainnetConfirm(false)
              }}
            >
              Yes, switch to mainnet
            </Button>
          </>
        }
      >
        <p>
          On mainnet your SOL and tokens are <b>real and irreversible</b>. The default for this tool is devnet
          because that is where you can make mistakes for free.
        </p>
        <p>Every transaction will still show you the full instruction list and simulation before you sign.</p>
        <p className="muted">
          Mainnet public RPCs are often stricter than devnet. If a read fails, this app automatically tries other
          public endpoints, and you can add a free Helius key in Settings for a reliable connection.
        </p>
      </Modal>
    </header>
  )
}

function NetworkStats() {
  const { stats, statsLoading, statsError, refreshStats, endpoint, endpointSource } = useNetwork()

  // The provider already polls every 30s with the current connection. We only
  // re-fetch when the endpoint changes (refreshStats identity changes with it),
  // so a live RPC switch updates the header immediately and never polls a
  // stale connection.
  useEffect(() => {
    refreshStats()
  }, [refreshStats])

  if (statsError) {
    return (
      <span
        className="netstats netstats--err"
        title={`${describeError(statsError)}\n\nEndpoint: ${endpoint} (${endpointSource}) — click to retry`}
      >
        <span className="netstats__dot" />
        <button className="linkish" onClick={refreshStats}>
          RPC error
        </button>
      </span>
    )
  }
  return (
    <span className="netstats" title={stats ? `slot ${stats.slot.toLocaleString()}` : 'connecting…'}>
      <span className={clsx('netstats__dot', !statsLoading && stats ? 'netstats__dot--ok' : 'netstats__dot--wait')} />
      {stats ? `slot ${stats.slot.toLocaleString()}` : statsLoading ? 'connecting…' : 'idle'}
    </span>
  )
}
