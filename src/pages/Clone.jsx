/**
 * Clone — Clone Trending Tokens from DexScreener or paste any Solana token address.
 * Categories:
 * 1. "🔥 General" (top boosted, 50+ tokens)
 * 2. "⚡ New Pairs" (freshly launched within 24-48h, 50+ tokens)
 * 3. "💊 Pump.fun" (ranked by live buy activity, last buy recency indicator, 50+ tokens)
 *
 * Pinned sticky header with independent smooth scrolling token list.
 */
import { useEffect, useState } from 'react'
import { Banner, Button, Card, Field, Spinner, TextInput } from '../components/ui.jsx'
import { fetchTrendingSolanaTokens, fetchTokenDetailsByAddress } from '../lib/dexscreener.js'
import { shorten, clsx } from '../lib/format.js'

export default function Clone({ onClone }) {
  const [category, setCategory] = useState('general') // 'general' | 'new' | 'pump'
  const [trending, setTrending] = useState([])
  const [loadingTrending, setLoadingTrending] = useState(true)
  const [trendingError, setTrendingError] = useState(null)

  const [customAddress, setCustomAddress] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectError, setInspectError] = useState(null)
  const [inspectedToken, setInspectedToken] = useState(null)

  useEffect(() => {
    loadTrending(category)
  }, [category])

  async function loadTrending(cat = category) {
    setLoadingTrending(true)
    setTrendingError(null)
    try {
      const list = await fetchTrendingSolanaTokens(cat, 60)
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
            Clone any live trending, newly launched, or active Pump.fun token with its logo, name, ticker, and metadata, then launch your own token on Solana with 0 platform fees.
          </p>
        </div>
        <Button variant="ghost" onClick={() => loadTrending(category)} disabled={loadingTrending}>
          {loadingTrending ? 'Refreshing…' : 'Refresh'}
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
                        {inspectedToken.ageFormatted && (
                          <span style={{ background: 'var(--bg-2)', color: 'var(--text-mute)', fontSize: '12px', padding: '2px 8px', borderRadius: '99px', border: '1px solid var(--line-2)' }}>
                            🕒 {inspectedToken.ageFormatted}
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

        {/* Right Column: Trending Feed with Category Tabs */}
        <div className="page__col">
          <Card
            title={`Solana Trending Tokens (${trending.length})`}
            subtitle={
              category === 'pump'
                ? 'Ranked by highest live buy activity on Pump.fun with last purchase recency.'
                : category === 'new'
                ? 'Freshly launched pairs created within the last 24–48 hours.'
                : 'Highest boosted tokens by market momentum on DexScreener.'
            }
          >
            {/* Sticky Header Container */}
            <div
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 10,
                background: 'var(--bg-2, #141721)',
                paddingBottom: '12px',
                paddingTop: '2px',
                borderBottom: '1px solid var(--line, rgba(255, 255, 255, 0.08))',
                marginBottom: '14px',
              }}
            >
              <div className="seg" style={{ margin: 0, display: 'flex', gap: '4px', overflowX: 'auto' }}>
                <button
                  type="button"
                  className={clsx('seg__btn', category === 'general' && 'seg__btn--on')}
                  onClick={() => setCategory('general')}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  🔥 General
                </button>
                <button
                  type="button"
                  className={clsx('seg__btn', category === 'new' && 'seg__btn--on')}
                  onClick={() => setCategory('new')}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  ⚡ New Pairs
                </button>
                <button
                  type="button"
                  className={clsx('seg__btn', category === 'pump' && 'seg__btn--on')}
                  onClick={() => setCategory('pump')}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  💊 Pump.fun (Buy Volume)
                </button>
              </div>
            </div>

            {loadingTrending && <Spinner label={`Loading ${category === 'pump' ? 'most active Pump.fun' : category === 'new' ? 'newly launched' : 'trending'} tokens…`} />}
            {trendingError && (
              <div className="sectionerr">
                <p>{trendingError}</p>
                <Button size="sm" onClick={() => loadTrending(category)}>Retry</Button>
              </div>
            )}

            {!loadingTrending && trending.length === 0 && !trendingError && (
              <p className="muted">No tokens found in this category right now.</p>
            )}

            {!loadingTrending && trending.length > 0 && (
              <div
                className="trending-scroll-list"
                style={{
                  maxHeight: '620px',
                  overflowY: 'auto',
                  paddingRight: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  WebkitOverflowScrolling: 'touch',
                }}
              >
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
                          {t.isPump && (
                            <span style={{ fontSize: '10px', color: '#10b981', background: 'rgba(16, 185, 129, 0.12)', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '1px 5px', borderRadius: '4px', fontWeight: 600 }}>
                              pump
                            </span>
                          )}
                          {t.marketCapFormatted && (
                            <span style={{ fontSize: '11px', color: 'var(--good)', background: 'var(--bg-4)', padding: '1px 6px', borderRadius: '4px' }}>
                              {t.marketCapFormatted}
                            </span>
                          )}
                          {t.ageFormatted && (
                            <span style={{ fontSize: '11px', color: 'var(--text-mute)', background: 'var(--bg-2)', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--line-2)' }}>
                              🕒 {t.ageFormatted}
                            </span>
                          )}
                        </div>

                        {/* Buy Activity & Recency for Pump.fun or active tokens */}
                        {category === 'pump' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', marginTop: '4px', flexWrap: 'wrap' }}>
                            <span style={{ color: '#10b981', fontWeight: 600 }}>
                              🛒 {t.buys5m > 0 ? `${t.buys5m} buys (5m)` : `${t.buys1h} buys (1h)`}
                            </span>
                            <span style={{ color: 'var(--text-mute)' }}>•</span>
                            <span style={{ color: t.lastBuyFormatted.includes('5m') ? '#10b981' : 'var(--text-mute)' }}>
                              ⚡ Last buy: {t.lastBuyFormatted}
                            </span>
                          </div>
                        )}

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
