/**
 * SuccessModal — the post-action popup.
 *
 * After a token is created, or a liquidity pool is opened, the user gets a
 * single window that answers the two questions they actually have:
 *
 *   1. Did it work?  -> "View transaction on Solana Explorer" (works on
 *                       devnet AND mainnet, because Explorer takes ?cluster=)
 *   2. How is my coin doing? -> one-tap buttons for every charting, tracking
 *                       and trading platform (Photon, DexScreener, Birdeye,
 *                       GeckoTerminal, DEXTools, Jupiter, RugCheck, plus the
 *                       DEX the pool lives on).
 *
 * Every external link opens in a NEW TAB with rel="noopener noreferrer" —
 * no window.opener handle back to the app, and no referrer leak.
 */
import { Modal, Button, Banner, KeyValue } from './ui.jsx'
import { clsx } from '../lib/format.js'
import { MAINNET_ONLY_NOTE, buildLinks } from '../lib/links.js'

/** An anchor styled exactly like the app's buttons. Always a new tab. */
export function ExternalButton({ href, children, primary, small }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={clsx('btn', primary ? 'btn--primary' : 'btn--secondary', small && 'btn--sm')}
      style={{ textDecoration: 'none' }}
    >
      <span>{children}</span>
      <span aria-hidden="true" style={{ fontSize: '11px', opacity: 0.65 }}>
        ↗
      </span>
    </a>
  )
}

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontSize: '11.5px',
        fontWeight: 650,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-mute)',
        margin: '18px 0 9px',
      }}
    >
      {children}
    </div>
  )
}

/**
 * The success popup.
 *
 * Props:
 *   open, onClose   — modal plumbing
 *   title           — e.g. "Token created"
 *   subtitle        — one honest sentence about what happened
 *   rows            — KeyValue items (mint, pool, amounts…)
 *   linkData        — { mint, pool, protocol, signature, address, addressLabel }
 *   network         — the active network object (for cluster-aware explorer URLs)
 *   hidePlatforms   — set true for a brand-new token with no pool yet
 */
export default function SuccessModal({
  open,
  onClose,
  title,
  subtitle,
  rows = [],
  network,
  linkData = {},
  hidePlatforms = false,
}) {
  const { explorer, platforms, showMainnetNote } = buildLinks({ network, ...linkData })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <div
          style={{
            flex: '0 0 auto',
            width: 32,
            height: 32,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            background: 'color-mix(in srgb, var(--good) 20%, var(--bg-3))',
            border: '1px solid color-mix(in srgb, var(--good) 45%, var(--line))',
            color: 'var(--good)',
            fontWeight: 700,
          }}
          aria-hidden="true"
        >
          ✓
        </div>
        <div style={{ minWidth: 0 }}>
          {subtitle && (
            <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '14px', lineHeight: 1.55 }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <KeyValue items={rows} />
        </div>
      )}

      {explorer.length > 0 && (
        <>
          <SectionLabel>On chain</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {explorer.map((l) => (
              <ExternalButton key={l.id} href={l.url} primary={l.primary}>
                {l.label}
              </ExternalButton>
            ))}
          </div>
        </>
      )}

      {!hidePlatforms && platforms.length > 0 && (
        <>
          <SectionLabel>Track &amp; trade your coin</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {platforms.map((l) => (
              <ExternalButton key={l.id} href={l.url} small>
                {l.label}
              </ExternalButton>
            ))}
          </div>
          {showMainnetNote && (
            <div style={{ marginTop: '12px' }}>
              <Banner tone="warn" title="These platforms are mainnet-only">
                {MAINNET_ONLY_NOTE}
              </Banner>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/**
 * The compact button row that sits on a pool card — the same three-plus row
 * the Meteora UI shows (Photon / Meteora / DexScreener), plus the rest.
 *
 * `compact` limits it to the headline platforms so a card does not turn into a
 * wall of buttons; the full set stays one click away in the success modal.
 */
export function PlatformLinks({ network, mint, pool, protocol, compact = false, showNote = false }) {
  const { platforms, showMainnetNote } = buildLinks({ network, mint, pool, protocol })
  if (!platforms.length) return null

  const compactIds = ['meteora', 'raydium', 'photon', 'dexscreener']
  const shown = compact ? platforms.filter((l) => compactIds.includes(l.id)) : platforms
  const list = shown.length ? shown : platforms

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {list.map((l) => (
          <ExternalButton key={l.id} href={l.url} small>
            {l.label}
          </ExternalButton>
        ))}
      </div>
      {showNote && showMainnetNote && (
        <p style={{ margin: '8px 0 0', fontSize: '11.5px', color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Mainnet-only platforms — a devnet token will not appear there yet.
        </p>
      )}
    </div>
  )
}
