/**
 * Settings — everything that lives in this browser, shown as-is, with a
 * visible way to delete it. No hidden state, no hidden keys.
 */
import { useState, useEffect } from 'react'
import { Connection } from '@solana/web3.js'
import { BRAND, FEE_POLICY, NETWORKS, STORAGE_DESCRIPTIONS } from '../lib/config.js'
import { describeStorage, clearAllLocalData, loadSettings, saveSettings, listCreatedTokens, listCreatedPools, removeCreatedToken, removeCreatedPool } from '../lib/registry.js'
import { useNetwork, inferClusterFromUrl } from '../lib/network.jsx'
import { describeError } from '../lib/rpcResilience.js'
import { Address, Banner, Button, Card, Field, KeyValue, Modal, TextInput } from '../components/ui.jsx'

export default function Settings() {
  const { networkId, endpoint, endpointSource, setCustomRpc } = useNetwork()
  const [s, setS] = useState(() => loadSettings())
  const isMainnet = networkId === 'mainnet-beta'

  const initialRpc = () => {
    const loaded = loadSettings()
    if (isMainnet) return loaded.customRpcMainnet || loaded.customRpc || ''
    return loaded.customRpcDevnet || ''
  }

  const [draft, setDraft] = useState(() => ({
    customRpc: initialRpc(),
    pinataJwt: loadSettings().pinataJwt ?? '',
    priorityFeeMicroLamports: String(loadSettings().priorityFeeMicroLamports ?? 0),
    tokenProgram: loadSettings().tokenProgram ?? 'spl',
    defaultDecimals: String(loadSettings().defaultDecimals ?? 9),
    defaultSupply: loadSettings().defaultSupply ?? '1000000000',
    slippageBps: String(loadSettings().slippageBps ?? 50),
  }))
  const [saved, setSaved] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [cleared, setCleared] = useState(null)

  // Update draft when active network changes
  useEffect(() => {
    setDraft((d) => ({ ...d, customRpc: initialRpc() }))
  }, [networkId])

  const tokens = listCreatedTokens()
  const pools = listCreatedPools()

  function save() {
    const trimmedRpc = draft.customRpc.trim()
    const patch = {
      customRpc: isMainnet ? trimmedRpc : (loadSettings().customRpc || ''),
      customRpcDevnet: isMainnet ? (loadSettings().customRpcDevnet || '') : trimmedRpc,
      customRpcMainnet: isMainnet ? trimmedRpc : (loadSettings().customRpcMainnet || ''),
      pinataJwt: draft.pinataJwt.trim(),
      priorityFeeMicroLamports: Math.max(0, Number(draft.priorityFeeMicroLamports) || 0),
      tokenProgram: draft.tokenProgram,
      defaultDecimals: Math.min(9, Math.max(0, Number(draft.defaultDecimals) || 9)),
      defaultSupply: draft.defaultSupply.trim(),
      slippageBps: Math.min(10000, Math.max(0, Number(draft.slippageBps) || 0)),
    }
    const next = saveSettings(patch)
    // Activate immediately for current cluster
    setCustomRpc(trimmedRpc, networkId)
    setS(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  // Test the URL as typed (not the currently-active endpoint), so what you
  // see is exactly what Save will switch the app to.
  async function testRpc() {
    const url = (draft.customRpc || '').trim()
    if (!url) {
      alert('Paste an RPC URL first (e.g. your Alchemy or Helius endpoint).')
      return
    }
    try {
      const probe = new Connection(url, { commitment: 'confirmed' })
      const slot = await probe.getSlot()
      alert(`Connected — current slot ${slot.toLocaleString()}`)
    } catch (err) {
      alert(`Could not reach that endpoint: ${describeError(err)}`)
    }
  }

  function doClear() {
    const removed = clearAllLocalData()
    setCleared(removed)
    setConfirmClear(false)
  }

  return (
    <div className="page">
      <div className="page__grid page__grid--2col">
        <div className="page__col">
          <Card title="Network">
            <KeyValue
              dense
              items={[
                { label: 'RPC endpoint', value: endpoint, mono: true },
                { label: 'Source', value: endpointSource },
              ]}
            />
            <div className="form__stack">
              <Field
                label={`Custom RPC for ${isMainnet ? 'Mainnet' : 'Devnet'} (optional)`}
                hint={`Configured separately for each network. Stored only in this browser.`}
              >
                <div className="form__row">
                  <TextInput mono value={draft.customRpc} onChange={(v) => setDraft((d) => ({ ...d, customRpc: v }))} placeholder="https://…" />
                  <Button variant="ghost" onClick={testRpc}>Test</Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft((d) => ({ ...d, customRpc: '' }))
                      const patch = isMainnet
                        ? { customRpcMainnet: '', customRpc: '' }
                        : { customRpcDevnet: '' }
                      saveSettings(patch)
                      setCustomRpc('', networkId)
                    }}
                  >
                    Reset
                  </Button>
                </div>
              </Field>
              {(() => {
                const inferred = inferClusterFromUrl(draft.customRpc)
                if (inferred && inferred !== networkId) {
                  return (
                    <Banner tone="warn" title="Cluster mismatch">
                      This URL looks like a <strong>{inferred === 'mainnet-beta' ? 'Mainnet' : inferred}</strong> endpoint, but SolForge is currently set to <strong>{networkId === 'mainnet-beta' ? 'Mainnet' : networkId}</strong>. A Mainnet RPC cannot see Devnet wallets, causing "AccountNotFound" errors during transactions. Switch the header to the matching network or use an RPC URL for {networkId}.
                    </Banner>
                  )
                }
                return null
              })()}
            </div>
          </Card>

          <Card
            title="Your Pinata API key"
            subtitle="Used only to upload your metadata from this browser, directly to api.pinata.cloud. It is never sent anywhere else and never appears in any transaction."
          >
            <Field label="Pinata JWT" hint="Create one at pinata.cloud → Account Settings → Keys.">
              <div className="form__row">
                <TextInput mono type="password" value={draft.pinataJwt} onChange={(v) => setDraft((d) => ({ ...d, pinataJwt: v }))} placeholder="eyJhbGciOi…" />
                <Button variant="ghost" onClick={() => setDraft((d) => ({ ...d, pinataJwt: '' }))}>Clear</Button>
              </div>
            </Field>
          </Card>

          <Card title="Defaults">
            <div className="form__row form__row--3">
              <Field label="Priority fee (µLamports/CU)" hint="0 = no priority fee instruction.">
                <TextInput type="number" value={draft.priorityFeeMicroLamports} onChange={(v) => setDraft((d) => ({ ...d, priorityFeeMicroLamports: v }))} />
              </Field>
              <Field label="Default decimals">
                <TextInput type="number" value={draft.defaultDecimals} onChange={(v) => setDraft((d) => ({ ...d, defaultDecimals: v }))} />
              </Field>
              <Field label="Default supply">
                <TextInput value={draft.defaultSupply} onChange={(v) => setDraft((d) => ({ ...d, defaultSupply: v }))} />
              </Field>
            </div>
            <div className="form__row form__row--3">
              <Field label="Default token standard">
                <select className="input input--select" value={draft.tokenProgram} onChange={(e) => setDraft((d) => ({ ...d, tokenProgram: e.target.value }))}>
                  <option value="spl">SPL Token (legacy)</option>
                  <option value="token2022">Token-2022</option>
                </select>
              </Field>
              <Field label="Default slippage (bps)">
                <TextInput type="number" value={draft.slippageBps} onChange={(v) => setDraft((d) => ({ ...d, slippageBps: v }))} />
              </Field>
            </div>
          </Card>

          <Button variant="primary" onClick={save} className="w-full">
            {saved ? 'Saved ✓' : 'Save settings'}
          </Button>
        </div>

        <div className="page__col">
          <Card title="Local data" subtitle="Everything this app stores, all in your browser's localStorage. Nothing is sent to any server.">
            <div className="storage">
              {describeStorage().map((row) => (
                <div className="storage__row" key={row.key}>
                  <code>{row.key}</code>
                  <span className="storage__desc">{row.description}</span>
                  <span className={row.bytes ? 'storage__bytes' : 'muted'}>{row.summary}</span>
                </div>
              ))}
            </div>
            <div className="storage__actions">
              <Button variant="danger" onClick={() => setConfirmClear(true)}>
                Clear all local data
              </Button>
              <span className="muted">Deletes every key above — settings, registry, keys you stored.</span>
            </div>
          </Card>

          <Card title="Created here" subtitle="A local registry only — removing an entry never touches the chain.">
            {tokens.length === 0 && pools.length === 0 && <p className="muted">Nothing recorded yet.</p>}
            {tokens.length > 0 && (
              <>
                <h4 className="subhead">Tokens</h4>
                <ul className="registry">
                  {tokens.map((t) => (
                    <li key={t.mint}>
                      <span className="registry__name">
                        {t.name} <b>{t.symbol}</b>
                      </span>
                      <Address value={t.mint} />
                      <button className="linkish danger" onClick={() => removeCreatedToken(t.mint)}>remove</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {pools.length > 0 && (
              <>
                <h4 className="subhead">Pools</h4>
                <ul className="registry">
                  {pools.map((pl) => (
                    <li key={pl.pool}>
                      <span className="registry__name">{pl.locked ? 'locked' : 'unlocked'} pool</span>
                      <Address value={pl.pool} />
                      <button className="linkish danger" onClick={() => removeCreatedPool(pl.pool)}>remove</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card title="Fee policy" tone="good">
            <p>{FEE_POLICY.statement}</p>
          </Card>
        </div>
      </div>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear all local data?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="danger" onClick={doClear}>Yes, delete everything</Button>
          </>
        }
      >
        <p>
          This deletes {Object.keys(STORAGE_DESCRIPTIONS).length} browser keys: your RPC override, Pinata key,
          preferences and the local token/pool registry. Your on-chain tokens and pools are not affected.
        </p>
        {cleared && (
          <Banner tone="good" title={`Removed ${cleared.length} key(s)`}>
            {cleared.join(', ')}
          </Banner>
        )}
      </Modal>
    </div>
  )
}
