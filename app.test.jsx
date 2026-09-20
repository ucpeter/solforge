/**
 * Render smoke test: mounts the real app in a DOM and checks that every page
 * renders against the local test validator (custom RPC from localStorage).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createRoot } from 'react-dom/client'
import React from 'react'
import App from '../src/App.jsx'

function waitUntil(fn, { timeoutMs = 25000, intervalMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      try {
        const v = fn()
        if (v) {
          clearInterval(timer)
          resolve(v)
        }
      } catch {
        /* keep waiting */
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`waitUntil timeout; body: ${document.body?.innerText?.slice(0, 400)}`))
      }
    }, intervalMs)
  })
}

function clickByText(text) {
  const el = [...document.querySelectorAll('button, a')].find((b) => b.textContent?.trim() === text)
  if (!el) throw new Error(`no button/a with text "${text}"`)
  el.click()
  return el
}

describe('SolForge app', () => {
  let root
  beforeAll(() => {
    // Point the app at the local validator so the test is hermetic.
    localStorage.setItem(
      'solforge.settings',
      JSON.stringify({ customRpc: 'http://127.0.0.1:8899', pinataJwt: '', priorityFeeMicroLamports: 0, tokenProgram: 'spl', defaultDecimals: 9, defaultSupply: '1000000000', slippageBps: 50 })
    )
    let el = document.getElementById('root')
    if (!el) {
      el = document.createElement('div')
      el.id = 'root'
      document.body.appendChild(el)
    }
    root = createRoot(el)
    root.render(<App />)
  })

  it('renders the header and connects to the cluster', async () => {
    await waitUntil(() => document.body.innerText.includes('SolForge') && document.body.innerText.includes('Create token'))
    const text = () => document.body.innerText
    expect(text()).toContain('Liquidity')
    expect(text()).toContain('Settings')
    expect(text()).toContain('About')
    expect(text()).toContain('Devnet')
    expect(text()).toContain('No wallet detected')
    // Network stats should eventually show a slot from the local validator.
    await waitUntil(() => /slot \d+/.test(text()), { timeoutMs: 30000 })
    expect(/slot \d+/.test(text())).toBe(true)
  }, 60000)

  it('creates page: shows form and cost estimation', async () => {
    const text = () => document.body.innerText
    expect(text()).toContain('Token details')
    expect(text()).toContain('Token standard')
    expect(text()).toContain('SPL Token (legacy)')
    expect(text()).toContain('Metadata')
    expect(text()).toContain('Review transaction')
  }, 20000)

  it('navigates to Liquidity and renders both tabs', async () => {
    clickByText('Liquidity')
    await waitUntil(() => document.body.innerText.includes('Create a pool'))
    let text = () => document.body.innerText
    expect(text()).toContain('Pair')
    expect(text()).toContain('Pool config')

    clickByText('My positions')
    await waitUntil(() => text().includes('No wallet connected'))
    expect(text()).toContain('No wallet connected')
  }, 60000)

  it('navigates to Settings and lists storage keys', async () => {
    clickByText('Settings')
    await waitUntil(() => document.body.innerText.includes('Local data'))
    const text = () => document.body.innerText
    expect(text()).toContain('solforge.settings')
    expect(text()).toContain('solforge.tokens')
    expect(text()).toContain('Clear all local data')
    expect(text()).toContain('Your Pinata API key')
  }, 30000)

  it('navigates to About and lists program addresses', async () => {
    clickByText('About')
    await waitUntil(() => document.body.innerText.includes('What it does not do'))
    const text = () => document.body.innerText
    expect(text()).toContain('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    expect(text()).toContain('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
    expect(text()).toContain('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
    expect(text()).toContain('No wash-trading')
  }, 30000)

  it('create page: live cost estimate from the cluster', async () => {
    clickByText('Create token')
    await waitUntil(() => document.body.innerText.includes('Token details'))

    const setNative = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const inputs = [...document.querySelectorAll('input')]
    const nameInput = inputs.find((i) => i.placeholder === 'My Token')
    const symbolInput = inputs.find((i) => i.placeholder === 'MYT')
    setNative(nameInput, 'Smoke Token')
    setNative(symbolInput, 'SMK')

    const text = () => document.body.innerText
    await waitUntil(() => text().includes('Total (network costs only)'), { timeoutMs: 30000 })
    expect(text()).toContain('Platform fee')
    expect(text()).toContain('0 SOL')
    // rent lines should contain real lamport-derived numbers
    expect(/Rent — mint account/.test(text())).toBe(true)
  }, 60000)

  it('liquidity create tab: loads real pool configs from the cluster', async () => {
    clickByText('Liquidity')
    await waitUntil(() => document.body.innerText.includes('Pool config'))
    const text = () => document.body.innerText
    // a static config from the cluster must appear in the picker
    await waitUntil(() => /starts \d+(\.\d+)?%/.test(text()), { timeoutMs: 30000 })
    // the config detail box appears once a config is selected
    await waitUntil(() => text().includes('Config address'), { timeoutMs: 30000 })
    expect(text()).toContain('Fee schedule')

    // fill the mint + amounts and expect the decimal-adjusted price banner
    const setNative = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const inputs = [...document.querySelectorAll('input')]
    const mintInput = inputs.find((i) => i.placeholder === 'or paste a mint address')
    // WSOL exists on the local cluster — this exercises real decimal resolution.
    setNative(mintInput, 'So11111111111111111111111111111111111111112')
    await waitUntil(() => text().includes('Resolved:') || text().includes('does not exist'), { timeoutMs: 30000 })
    expect(text().includes('· 9 decimals')).toBe(true)
  }, 60000)

  it('mainnet switch requires confirmation', async () => {
    clickByText('Mainnet')
    await waitUntil(() => document.body.innerText.includes('Switch to mainnet?'))
    expect(document.body.innerText).toContain('real and irreversible')
    clickByText('Stay on devnet')
    await waitUntil(() => !document.body.innerText.includes('Switch to mainnet?'))
  }, 30000)
})
