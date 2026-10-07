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
                <div className="clone-card" style={{ marginTop: '14px', padding: '14px', background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: '12px' }}>
                  <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                    {inspectedToken.imageUrl ? (
                      <img
                        src={inspectedToken.imageUrl}
                        alt={inspectedToken.symbol}
                        style={{ width: '56px', height: '56px', borderRadius: '50%', objectFit: 'cover', background: 'var(--bg-4)', flexShrink: 0 }}
                      />
                    ) : (
                      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'var(--bg-4)', flexShrink: 0 }} />
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '17px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span>{inspectedToken.name || 'Unnamed'}</span>
                        <span style={{ color: 'var(--accent)', fontSize: '15px' }}>(${inspectedToken.symbol || '???'})</span>
                        {inspectedToken.marketCapFormatted && (
                          <span style={{ background: 'var(--bg-4)', color: 'var(--good)', fontSize: '12px', padding: '2px 8px', borderRadius: '99px', border: '1px solid var(--line-2)' }}>
                            MCap: {inspectedToken.marketCapFormatted}
                          </span>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: '12px', fontFamily: 'var(--mono)', marginTop: '3px' }}>
                        {shorthead(inspectedToken.address)}
                      </div>
                    </div>
                  </div>

                  {inspectedToken.description && (
                    <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: '12px 0 6px', lineHeight: 1.5 }}>
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
          <Card title="Live Trending on Solana" subtitle="Real-time top boosted coins on DexScreener. Tap any coin to clone its metadata.">
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
                      padding: '12px',
                      background: 'var(--bg-3)',
                      border: '1px solid var(--line)',
                      borderRadius: '10px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                      {t.icon ? (
                        <img
                          src={t.icon}
                          alt=""
                          onError={(e) => { e.currentTarget.style.display = 'none' }}
                          style={{ width: '42px', height: '42px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: 'var(--bg-4)' }}
                        />
                      ) : (
                        <div style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'var(--bg-4)', flexShrink: 0 }} />
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 650, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span>{t.name || shorten(t.tokenAddress, 6, 4)}</span>
                          {t.symbol && <span style={{ color: 'var(--accent)', fontSize: '13px' }}>(${t.symbol})</span>}
                          {t.marketCapFormatted && (
                            <span style={{ fontSize: '11px', color: 'var(--good)', background: 'var(--bg-4)', padding: '1px 6px', borderRadius: '4px' }}>
                              {t.marketCapFormatted}
                            </span>
                          )}
                        </div>
                        {t.description && (
                          <div className="muted" style={{ fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '280px', marginTop: '2px' }}>
                            {t.description}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        handleLaunch({
                          name: t.name,
                          symbol: t.symbol,
                          description: t.description,
                          imageUrl: t.icon,
                        })
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
