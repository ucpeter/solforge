/**
 * Clone — Clone Trending Tokens from DexScreener or paste any Solana token address.
 * Inspects name, symbol, logo image, description, and socials, and launches into SolForge.
 */
import { useEffect, useState } from 'react'
import { Banner, Button, Card, Field, Spinner, TextInput } from '../components/ui.jsx'
import { fetchTrendingSolanaTokens, fetchTokenDetailsByAddress } from '../lib/dexscreener.js'
import { shorten } from '../lib/format.js'

export default function Clone({ onClone }) {
  const [trending, setTrending] = useState([])
  const [loadingTrending, setLoadingTrending] = useState(true)
  const [trendingError, setTrendingError] = useState(null)

  const [customAddress, setCustomAddress] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectError, setInspectError] = useState(null)
  const [inspectedToken, setInspectedToken] = useState(null)

  // Load trending tokens on mount
  useEffect(() => {
    loadTrending()
  }, [])

  async function loadTrending() {
    setLoadingTrending(true)
    setTrendingError(null)
    try {
      const list = await fetchTrendingSolanaTokens(12)
      setTrending(list)
    } catch (err) {
      setTrendingError('Could not load trending tokens from DexScreener.')
    } finally {
      setLoadingTrending(false)
    }
  }

  async function handleInspect(addressToInspect) {
    const addr = (addressToInspect || customAddress).trim()
    if (!addr) return
    setInspecting(true)
    setInspectError(null)
    setInspectedToken(null)
    try {
      const details = await fetchTokenDetailsByAddress(addr)
      setInspectedToken(details)
    } catch (err) {
      setInspectError(err.message || 'Failed to fetch token metadata from DexScreener.')
    } finally {
      setInspecting(false)
    }
  }

  function handleLaunch(token) {
    if (!token) return
    onClone?.({
      name: token.name || '',
      symbol: token.symbol || '',
      description: token.description || '',
      imageUrl: token.imageUrl || token.icon || '',
      twitter: token.twitter || '',
      telegram: token.telegram || '',
      website: token.website || '',
    })
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Copy Trending Tokens</h1>
          <p className="page__sub">
            Clone any live trending token from DexScreener with its logo, name, ticker, and metadata, then launch your own token on Solana with 0 platform fees.
          </p>
        </div>
        <Button variant="ghost" onClick={loadTrending} disabled={loadingTrending}>
          {loadingTrending ? 'Refreshing…' : 'Refresh Trending'}
        </Button>
      </div>

      <div className="page__grid page__grid--2col">
        {/* Left Column: Custom Address Inspect */}
        <div className="page__col">
          <Card title="Clone Any Solana Token" subtitle="Paste any token contract address from Pump.fun, Raydium, Birdeye, or DexScreener.">
            <div className="form__stack">
              <Field label="Token Mint Address">
                <div className="form__row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px' }}>
                  <TextInput
                    mono
                    value={customAddress}
                    onChange={setCustomAddress}
                    placeholder="e.g. J9qzFhTLYnmf3tZYvHBaF96rH3YKToELAAVMzz66pump"
                  />
                  <Button
                    variant="primary"
                    disabled={!customAddress.trim() || inspecting}
                    onClick={() => handleInspect()}
                  >
                    {inspecting ? 'Fetching…' : 'Inspect'}
                  </Button>
                </div>
              </Field>

              {inspectError && <Banner tone="danger">{inspectError}</Banner>}

              {inspectedToken && (
                <div className="clone-card" style={{ marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                    {inspectedToken.imageUrl && (
                      <img
                        src={inspectedToken.imageUrl}
                        alt={inspectedToken.symbol}
                        style={{ width: '56px', height: '56px', borderRadius: '50%', objectFit: 'cover', background: 'var(--bg-3)' }}
                      />
                    )}
                    <div>
                      <div style={{ fontSize: '17px', fontWeight: 700 }}>
                        {inspectedToken.name} <span style={{ color: 'var(--accent)' }}>(${inspectedToken.symbol})</span>
                      </div>
                      <div className="muted" style={{ fontSize: '12.5px', fontFamily: 'var(--mono)', marginTop: '2px' }}>
                        {shorthead(inspectedToken.address)}
                      </div>
                    </div>
                  </div>

                  {inspectedToken.description && (
                    <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: '10px 0 6px', lineHeight: 1.5 }}>
                      {inspectedToken.description}
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexWrap: 'wrap' }}>
                    <Button variant="primary" onClick={() => handleLaunch(inspectedToken)}>
                      Clone & Open in Creator →
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right Column: Live Trending Feed from DexScreener */}
        <div className="page__col">
          <Card title="Live Trending on Solana" subtitle="Real-time top boosted coins on DexScreener right now. Tap any coin to inspect and clone.">
            {loadingTrending && <Spinner label="Loading live trending tokens from DexScreener…" />}
            {trendingError && (
              <div className="sectionerr">
                <p>{trendingError}</p>
                <Button size="sm" onClick={loadTrending}>Retry</Button>
              </div>
            )}

            {!loadingTrending && trending.length === 0 && !trendingError && (
              <p className="muted">No trending Solana tokens found right now.</p>
            )}

            {!loadingTrending && trending.length > 0 && (
              <div className="trending-grid" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {trending.map((t) => (
                  <div
                    key={t.tokenAddress}
                    className="clone-item"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      padding: '10px 12px',
                      background: 'var(--bg-3)',
                      border: '1px solid var(--line)',
                      borderRadius: '10px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                      {t.icon ? (
                        <img
                          src={t.icon}
                          alt=""
                          style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: 'var(--bg-4)' }}
                        />
                      ) : (
                        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'var(--bg-4)', flexShrink: 0 }} />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 650, fontSize: '13.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {shorten(t.tokenAddress, 6, 6)}
                        </div>
                        {t.description && (
                          <div className="muted" style={{ fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '240px' }}>
                            {t.description}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCustomAddress(t.tokenAddress)
                        handleInspect(t.tokenAddress)
                      }}
                    >
                      Clone
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function shorthead(addr) {
  if (!addr) return ''
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`
}
