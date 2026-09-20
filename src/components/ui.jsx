/**
 * Small presentational primitives. No business logic, no network calls.
 */
import { useEffect, useRef, useState } from 'react'
import { clsx, copyText } from '../lib/format.js'

export function Card({ title, subtitle, right, children, className, tone }) {
  return (
    <section className={clsx('card', tone && `card--${tone}`, className)}>
      {(title || right) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {right && <div className="card__right">{right}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Button({ children, variant = 'default', size = 'md', loading, disabled, ...rest }) {
  return (
    <button
      className={clsx('btn', `btn--${variant}`, `btn--${size}`)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      <span>{children}</span>
    </button>
  )
}

export function Spinner({ label }) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="spinner__label">{label}</span>}
    </span>
  )
}

export function Field({ label, hint, error, children, required }) {
  return (
    <label className={clsx('field', error && 'field--error')}>
      <span className="field__label">
        {label}
        {required && <em className="field__req">*</em>}
      </span>
      {children}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </label>
  )
}

export function TextInput({ value, onChange, placeholder, mono, maxLength, disabled, type = 'text', ...rest }) {
  return (
    <input
      className={clsx('input', mono && 'input--mono')}
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      {...rest}
    />
  )
}

export function Select({ value, onChange, options, disabled }) {
  return (
    <select className="input input--select" value={value} disabled={disabled} onChange={(e) => onChange?.(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({ checked, onChange, label, description, danger }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      className={clsx('toggle', checked && 'toggle--on', danger && 'toggle--danger')}
      onClick={() => onChange?.(!checked)}
    >
      <span className="toggle__track">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__text">
        <span className="toggle__label">{label}</span>
        {description && <span className="toggle__desc">{description}</span>}
      </span>
    </button>
  )
}

export function Banner({ tone = 'info', title, children, onDismiss }) {
  return (
    <div className={clsx('banner', `banner--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="banner__body">
        {title && <strong className="banner__title">{title}</strong>}
        {children && <div className="banner__text">{children}</div>}
      </div>
      {onDismiss && (
        <button className="banner__close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}

export function KeyValue({ items, dense }) {
  return (
    <dl className={clsx('kv', dense && 'kv--dense')}>
      {items
        .filter(Boolean)
        .map((it, i) => (
          <div className="kv__row" key={it.label + i}>
            <dt>{it.label}</dt>
            <dd className={clsx(it.mono && 'kv__mono', it.tone && `kv__tone--${it.tone}`)}>
              {it.copy ? <CopyChip text={String(it.value ?? '')}>{it.value}</CopyChip> : it.value}
            </dd>
          </div>
        ))}
    </dl>
  )
}

export function CopyChip({ text, children, label = 'Copied' }) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={clsx('chip', done && 'chip--done')}
      title="Copy to clipboard"
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyText(text)
        if (ok) {
          setDone(true)
          timer.current = setTimeout(() => setDone(false), 1400)
        }
      }}
    >
      <span className="chip__text">{children ?? text}</span>
      <span className="chip__icon">{done ? '✓' : '⧉'}</span>
      <span className="sr-only">{done ? label : 'Copy'}</span>
    </button>
  )
}

export function Address({ value, explorer, label }) {
  if (!value) return <span className="muted">—</span>
  const text = String(value)
  return (
    <span className="addr">
      {explorer ? (
        <a className="addr__link" href={explorer(text)} target="_blank" rel="noreferrer noopener">
          {label ?? `${text.slice(0, 4)}…${text.slice(-4)}`}
        </a>
      ) : (
        <span className="addr__plain">{label ?? `${text.slice(0, 4)}…${text.slice(-4)}`}</span>
      )}
      <CopyChip text={text} />
    </span>
  )
}

export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal__backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={clsx('modal', wide && 'modal--wide')} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={clsx('tabs__tab', active === t.id && 'tabs__tab--active')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge !== undefined && t.badge !== null && <span className="tabs__badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}

export function Stepper({ steps, current }) {
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li key={s} className={clsx('stepper__step', i < current && 'stepper__step--done', i === current && 'stepper__step--active')}>
          <span className="stepper__dot">{i < current ? '✓' : i + 1}</span>
          <span className="stepper__label">{s}</span>
        </li>
      ))}
    </ol>
  )
}

export function Amount({ value, decimals, symbol, precision }) {
  if (value === null || value === undefined) return <span className="muted">—</span>
  const raw = BigInt(String(value))
  const d = Number(decimals ?? 0)
  const div = 10n ** BigInt(d)
  const whole = raw / div
  const frac = (raw % div).toString().padStart(d, '0').slice(0, precision ?? 4)
  const text = d === 0 ? whole.toString() : `${whole}.${frac.replace(/0+$/, '') || '0'}`
  return (
    <span className="amount">
      {text}
      {symbol && <span className="amount__symbol"> {symbol}</span>}
    </span>
  )
}

export function Sol({ lamports, precision = 6 }) {
  if (lamports === null || lamports === undefined) return <span className="muted">—</span>
  const v = Number(lamports) / 1e9
  return (
    <span className="amount">
      {v === 0 ? '0' : v.toFixed(precision).replace(/\.?0+$/, '')}
      <span className="amount__symbol"> SOL</span>
    </span>
  )
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
    </div>
  )
}
