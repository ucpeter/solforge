/**
 * Create — token creation.
 *
 * Two genuinely different standards, both implemented and both labelled
 * honestly. One transaction. Live cost estimate. Full review before signing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import {
  Banner,
  Button,
  Card,
  Field,
  KeyValue,
  Select,
  Sol,
  Spinner,
  TextInput,
  Toggle,
} from '../components/ui.jsx'
import TxReview from '../components/TxReview.jsx'
import SuccessModal from '../components/SuccessModal.jsx'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { TOKEN_PROGRAM_CHOICES, tokenProgramById, PROGRAM } from '../lib/programs.js'
import {
  buildTokenCreation,
  estimateCreationCost,
  packInstructions,
  validateTokenForm,
} from '../lib/tokenCreator.js'
import {
  buildMetadataJson,
  gatewayUrl,
  inspectMetadataUri,
  uploadToPinata,
  uploadJsonToPinata,
  verifyCid,
  inspectMetadataDocument,
  checkImageLoads,
} from '../lib/ipfs.js'
import { addCreatedToken } from '../lib/registry.js'
import { loadSettings, saveSettings } from '../lib/registry.js'
import { clsx } from '../lib/format.js'

export default function Create({ initialClone = null, onClearClone = () => {} }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()
  const [settings, setSettings] = useState(() => loadSettings())

  // ---- token form ---------------------------------------------------------
  const [form, setForm] = useState({
    name: '',
    symbol: '',
    decimals: String(settings.defaultDecimals ?? 9),
    supply: settings.defaultSupply ?? '1000000000',
    tokenProgram: settings.tokenProgram ?? 'spl',
    revokeMint: true,
    revokeFreeze: true,
    metadataImmutable: false,
    renounceMetadataUpdate: false,
  })
  const [fieldErrors, setFieldErrors] = useState({})
  const [touch, setTouch] = useState(false)

  // ---- metadata -----------------------------------------------------------
  const [metaMode, setMetaMode] = useState('build') // 'build' | 'uri'
  const [meta, setMeta] = useState({
    description: initialClone?.description || '',
    twitter: initialClone?.twitter || '',
    telegram: initialClone?.telegram || '',
    website: initialClone?.website || '',
  })
  const [imageFile, setImageFile] = useState(null)
  const [imageUri, setImageUri] = useState(initialClone?.imageUrl || '')

  useEffect(() => {
    if (initialClone) {
      setForm((prev) => ({
        ...prev,
        name: initialClone.name || prev.name,
        symbol: initialClone.symbol || prev.symbol,
      }))
      setMeta({
        description: initialClone.description || '',
        twitter: initialClone.twitter || '',
        telegram: initialClone.telegram || '',
        website: initialClone.website || '',
      })
      if (initialClone.imageUrl) {
        setImageUri(initialClone.imageUrl)
      }
      setMetaMode('build')
      onClearClone()
    }
  }, [initialClone])
  const [pastedUri, setPastedUri] = useState('')
  const [uriCheck, setUriCheck] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [metadataUri, setMetadataUri] = useState('') // final on-chain URI

  // Upload verification. Pinata can return a CID without storing the file, and
  // an immutable token can never have its URI corrected — so we refuse to
  // proceed on an unverified URI unless the user explicitly overrides.
  const [verifying, setVerifying] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState('')
  const [uriVerified, setUriVerified] = useState(null) // true | false | null
  const [pendingUri, setPendingUri] = useState('') // the URI that failed checks
  const [overrideUnverified, setOverrideUnverified] = useState(false)
  const fileRef = useRef(null)

  const set = (k) => (v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setTouch(true)
  }

  // ---- live validation + cost ---------------------------------------------
  const [cost, setCost] = useState(null)
  const [costError, setCostError] = useState(null)
  const [planning, setPlanning] = useState(false)

  const formOk = useMemo(() => {
    const v = validateTokenForm(form)
    setFieldErrors(v.errors)
    return v.ok
  }, [form, touch])

  useEffect(() => {
    if (!formOk) {
      setCost(null)
      return
    }
    let cancelled = false
    setPlanning(true)
    setCostError(null)
    ;(async () => {
      try {
        const plan = await buildTokenCreation(connection, {
          payer: wallet.publicKey ?? new PublicKey('11111111111111111111111111111111'),
          form,
          metadataUri,
        })
        if (cancelled) return
        const c = await estimateCreationCost(connection, plan, {
          priorityFeeMicroLamports: settings.priorityFeeMicroLamports,
          transactionCount: packInstructions(plan.instructions, { payer: wallet.publicKey ?? undefined }).length,
          signatureCount: 2,
        })
        if (!cancelled) setCost(c)
      } catch (err) {
        if (!cancelled) setCostError(err.message)
      } finally {
        if (!cancelled) setPlanning(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOk, form, metadataUri, connection, settings.priorityFeeMicroLamports])

  // ---- metadata URI plumbing ------------------------------------------------
  useEffect(() => {
    if (metaMode !== 'uri') return
    if (!pastedUri.trim()) {
      setUriCheck(null)
      setMetadataUri('')
      return
    }
    let cancelled = false
    setUriCheck({ busy: true })
    inspectMetadataUri(pastedUri.trim()).then((r) => {
      if (cancelled) return
      setUriCheck(r)
      setMetadataUri(r.ok ? r.uri : '')
    })
    return () => {
      cancelled = true
    }
  }, [metaMode, pastedUri])

  async function handleUpload() {
    if (!imageFile) return
    const jwt = settings.pinataJwt
    if (!jwt?.trim()) {
      setUploadError('Add your Pinata API key in Settings first (it never leaves this browser), or paste a metadata URI instead.')
      return
    }
    setUploading(true)
    setUploadError(null)
    setVerifying(true)
    try {
      const { cid } = await uploadToPinata({ file: imageFile, jwt, name: imageFile.name })
      const url = gatewayUrl(cid)
      // Pinata can hand back a CID it never stored. Confirm before we rely on it.
      const probe = await verifyCid({ cid })
      if (!probe.ok) {
        setUploadError(
          `Pinata accepted the upload and returned ${cid}, but the image is not retrievable: ${probe.error}. ` +
            'Nothing has been written on-chain yet — check your Pinata storage quota and upload again.',
        )
        return
      }
      setImageUri(url)
      setUploadError(null)
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setVerifying(false)
      setUploading(false)
    }
  }

  async function handleBuildMetadata() {
    const jwt = settings.pinataJwt
    if (!jwt?.trim()) {
      setUploadError('Add your Pinata API key in Settings first, or switch to "paste a metadata URI".')
      return
    }
    if (!imageUri) {
      setUploadError('Upload an image first — the metadata document needs an image field.')
      return
    }
    setUploading(true)
    setUploadError(null)
    setVerifying(true)
    setVerifyMsg('Checking that the metadata JSON is actually being served…')
    setUriVerified(null)
    setPendingUri('')
    try {
      const doc = buildMetadataJson({
        name: form.name,
        symbol: form.symbol,
        description: meta.description,
        imageUri,
        socials: { twitter: meta.twitter, telegram: meta.telegram, website: meta.website },
      })
      const { cid, network: pinataNetwork } = await uploadJsonToPinata({ json: doc, jwt })
      const url = gatewayUrl(cid)

      // 1. Is the document retrievable at all?
      const probe = await verifyCid({ cid })
      if (!probe.ok) {
        fail(
          url,
          `Pinata accepted the upload and returned ${cid}, but the file is not retrievable: ${probe.error}. ` +
            'This usually means the account is out of storage quota. Do not launch — the token would be ' +
            'permanently stuck with a dead metadata URI.',
        )
        return
      }

      // 2. Is it real metadata, with an image field?
      const shape = inspectMetadataDocument(probe.text)
      if (!shape.ok) {
        fail(url, `The file at ${url} is live but unusable: ${shape.problem}.`)
        return
      }

      // 3. Does the image inside it actually load?
      setVerifyMsg('Checking that the image inside the metadata loads…')
      const imageOk = await checkImageLoads(shape.image)
      if (!imageOk) {
        fail(
          url,
          `The metadata is live, but the image inside it did not load: ${shape.image}. ` +
            'Wallets would show no logo. Fix the image and upload again.',
        )
        return
      }

      setMetadataUri(url)
      setUriVerified(true)
      setVerifyMsg(
        `Verified — the metadata JSON and its image both load from Pinata's ${pinataNetwork || 'public'} IPFS network.` +
          `${probe.attempts > 1 ? ` (took ${probe.attempts} attempts)` : ''}`,
      )
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setVerifying(false)
    }

    function fail(url, message) {
      setPendingUri(url)
      setUriVerified(false)
      setVerifyMsg(message)
      setMetadataUri('')
    }
  }

  // ---- review + send ---------------------------------------------------------
  const [reviewOpen, setReviewOpen] = useState(false)
  const [plan, setPlan] = useState(null)
  const [txs, setTxs] = useState([])
  const [success, setSuccess] = useState(null)

  const ready = formOk && Boolean(metadataUri?.trim()) && wallet.isConnected

  async function openReview() {
    if (!metadataUri?.trim()) {
      alert('Please complete the metadata step first by clicking "Upload metadata JSON to Pinata" or pasting a valid metadata URI.')
      return
    }
    setPlanning(true)
    try {
      const p = await buildTokenCreation(connection, { payer: wallet.publicKey, form, metadataUri })
      setPlan(p)
      setTxs(packInstructions(p.instructions, { payer: wallet.publicKey }))
      setReviewOpen(true)
    } catch (err) {
      setCostError(err.message)
    } finally {
      setPlanning(false)
    }
  }

  async function onSent(results) {
    const mintAddress = plan.mint.toBase58()
    const signature = results.map((r) => r.signature)[0] || null
    addCreatedToken({
      mint: mintAddress,
      networkId: network.id,
      name: form.name.trim(),
      symbol: form.symbol.trim().toUpperCase(),
      decimals: Number(form.decimals),
      supply: form.supply,
      program: form.tokenProgram,
      uri: metadataUri,
      signatures: results.map((r) => r.signature),
    })
    // Swap TxReview's "done" state for the success popup: it carries the
    // explorer link and every detail of what was just created in one place.
    setReviewOpen(false)
    setSuccess({ mintAddress, signature })
  }

  const choice = tokenProgramById(form.tokenProgram)

  return (
    <div className="page">
      <div className="page__grid page__grid--2col">
        <div className="page__col">
          <Card title="Token details" subtitle="Everything here goes on-chain. There are no defaults you can't see.">
            <div className="form__stack">
              <Field label="Name" required error={fieldErrors.name} hint="Max 32 bytes.">
                <TextInput value={form.name} onChange={set('name')} maxLength={32} placeholder="My Token" />
              </Field>
              <Field label="Symbol" required error={fieldErrors.symbol} hint="Max 10 bytes, stored in uppercase.">
                <TextInput value={form.symbol} onChange={set('symbol')} maxLength={10} placeholder="MYT" />
              </Field>
              <div className="form__row">
                <Field label="Decimals" error={fieldErrors.decimals}>
                  <TextInput type="number" value={form.decimals} onChange={set('decimals')} min={0} max={9} />
                </Field>
                <Field label="Initial supply" error={fieldErrors.supply}>
                  <TextInput value={form.supply} onChange={set('supply')} placeholder="1000000000" />
                </Field>
              </div>
              <Field
                label="Token standard"
                hint={choice.note}
              >
                <Select
                  value={form.tokenProgram}
                  onChange={set('tokenProgram')}
                  options={TOKEN_PROGRAM_CHOICES.map((c) => ({ value: c.id, label: c.label }))}
                />
              </Field>
              <div className="form__toggles">
                <Toggle
                  checked={form.revokeMint}
                  onChange={set('revokeMint')}
                  label="Revoke mint authority"
                  description="Supply can never be increased. Recommended."
                />
                <Toggle
                  checked={form.revokeFreeze}
                  onChange={set('revokeFreeze')}
                  label="No freeze authority"
                  description="No account can ever be frozen. Recommended."
                />
                <Toggle
                  checked={form.metadataImmutable}
                  onChange={set('metadataImmutable')}
                  label="Make metadata immutable"
                  description={
                    form.tokenProgram === 'token2022'
                      ? 'Name, symbol and image can never be changed. Token-2022 has no mutability flag, so this removes the metadata update authority instead.'
                      : 'Name, symbol and image can never be changed. On SPL tokens this sets the Metaplex isMutable flag — free, it is a field in the create instruction.'
                  }
                />
                <Toggle
                  checked={form.renounceMetadataUpdate}
                  onChange={set('renounceMetadataUpdate')}
                  label="Renounce metadata update authority"
                  description={
                    form.tokenProgram === 'token2022'
                      ? 'Same lock as above on Token-2022: the update authority is set to an address nobody owns the key for.'
                      : 'Hands the update authority to an address nobody owns the key for, and sets isMutable = false. Strongest signal on explorers and scanners — recommended alongside the toggle above.'
                  }
                />
              </div>
            </div>
          </Card>

          <Card title="Metadata" subtitle="Your content, your IPFS. This app only talks to api.pinata.cloud with a key you stored yourself.">
            <div className="seg">
              <button className={clsx('seg__btn', metaMode === 'build' && 'seg__btn--on')} onClick={() => setMetaMode('build')}>
                Build it here (Pinata)
              </button>
              <button className={clsx('seg__btn', metaMode === 'uri' && 'seg__btn--on')} onClick={() => setMetaMode('uri')}>
                Paste a metadata URI
              </button>
            </div>

            {metaMode === 'build' ? (
              <div className="form__stack">
                <Field label="Image" hint="JPG/PNG/WebP. Uploaded straight from this browser to your Pinata account.">
                  <div className="filerow">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        setImageFile(e.target.files?.[0] ?? null)
                        setImageUri('')
                      }}
                    />
                    <Button variant="secondary" onClick={handleUpload} loading={uploading && !imageUri}>
                      {imageUri ? 'Re-upload' : 'Upload to Pinata'}
                    </Button>
                  </div>
                  {imageUri && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                      <img src={imageUri} alt="preview" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
                      <span className="muted filerow__uri" style={{ flex: 1, minWidth: 0 }}>{imageUri}</span>
                    </div>
                  )}
                </Field>
                <Field label="Description">
                  <textarea
                    className="input input--area"
                    rows={3}
                    value={meta.description}
                    onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
                    placeholder="What is this token?"
                  />
                </Field>
                <div className="form__row form__row--3">
                  <Field label="Twitter / X URL">
                    <TextInput value={meta.twitter} onChange={(v) => setMeta((m) => ({ ...m, twitter: v }))} placeholder="https://x.com/…" />
                  </Field>
                  <Field label="Telegram URL">
                    <TextInput value={meta.telegram} onChange={(v) => setMeta((m) => ({ ...m, telegram: v }))} placeholder="https://t.me/…" />
                  </Field>
                  <Field label="Website URL">
                    <TextInput value={meta.website} onChange={(v) => setMeta((m) => ({ ...m, website: v }))} placeholder="https://…" />
                  </Field>
                </div>
                <Button variant="secondary" onClick={handleBuildMetadata} loading={uploading}>
                  {metadataUri ? 'Rebuild metadata JSON' : 'Upload metadata JSON to Pinata'}
                </Button>
                {metadataUri && <span className="muted filerow__uri">{metadataUri}</span>}

                {verifying && <Spinner label={verifyMsg || 'Verifying…'} />}

                {!verifying && uriVerified === true && (
                  <Banner tone="good" title="Metadata verified">
                    {verifyMsg}
                  </Banner>
                )}

                {!verifying && uriVerified === false && (
                  <Banner tone="danger" title="Metadata URI could not be verified — launch blocked">
                    <p style={{ margin: '0 0 10px' }}>{verifyMsg}</p>
                    <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
                      Nothing has been written on-chain. If this token is created with the metadata
                      authority renounced, a dead URI can never be corrected — that is why this is
                      blocked rather than warned about.
                    </p>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Button variant="secondary" onClick={handleBuildMetadata}>
                        Upload again
                      </Button>
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={overrideUnverified}
                          onChange={(e) => setOverrideUnverified(e.target.checked)}
                        />
                        I have checked this URI myself — let me continue anyway
                      </label>
                    </div>
                    {overrideUnverified && pendingUri && (
                      <div style={{ marginTop: 10 }}>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setMetadataUri(pendingUri)
                            setUriVerified(null)
                            setOverrideUnverified(false)
                            setVerifyMsg('Proceeding with an unverified URI — at your own risk.')
                          }}
                        >
                          Use {pendingUri.slice(0, 42)}… anyway
                        </Button>
                      </div>
                    )}
                  </Banner>
                )}

                {!verifying && uriVerified === null && verifyMsg && (
                  <Banner tone="warn">{verifyMsg}</Banner>
                )}
              </div>
            ) : (
              <div className="form__stack">
                <Field label="Metadata URI" hint="http(s) or ipfs:// — it is fetched here and checked before you sign.">
                  <TextInput value={pastedUri} onChange={setPastedUri} placeholder="https://…/metadata.json or ipfs://Qm…" />
                </Field>
                {uriCheck?.busy && <Spinner label="Fetching and validating…" />}
                {uriCheck && !uriCheck.busy && (
                  <Banner tone={uriCheck.ok ? 'good' : uriCheck.verified === false ? 'warn' : 'danger'} title={uriCheck.ok ? 'Looks valid' : 'Problems found'}>
                    {uriCheck.message}
                  </Banner>
                )}
              </div>
            )}
            {uploadError && <Banner tone="danger">{uploadError}</Banner>}
          </Card>
        </div>

        <div className="page__col page__col--sticky">
          <Card title="Cost" subtitle="Computed live from this cluster. Nothing is added on.">
            {costError && <Banner tone="danger">{costError}</Banner>}
            {!cost && !costError && <div className="review__busy"><Spinner label="Estimating…" /></div>}
            {cost && (
              <KeyValue
                dense
                items={[
                  { label: `Rent — mint account (recoverable)`, value: <Sol lamports={cost.rentMint} precision={9} />, mono: true },
                  { label: `Rent — your token account (recoverable)`, value: <Sol lamports={cost.rentAta} precision={9} />, mono: true },
                  {
                    label: form.tokenProgram === 'token2022' ? 'Rent — metadata (inside mint, recoverable)' : 'Rent — Metaplex metadata (recoverable)',
                    value: <Sol lamports={cost.rentMetadata} precision={9} />,
                    mono: true,
                  },
                  { label: 'Signature fees', value: <Sol lamports={cost.signatureFee} precision={9} />, mono: true },
                  {
                    label: 'Priority fee',
                    value: cost.priorityFee ? <Sol lamports={cost.priorityFee} precision={9} /> : '0 (you chose none)',
                    mono: true,
                  },
                  { label: 'Platform fee', value: '0 SOL', tone: 'good', mono: true },
                  { label: 'Total (network costs only)', value: <Sol lamports={cost.total} precision={9} />, mono: true, tone: 'strong' },
                ]}
              />
            )}
            {planning && cost && <div className="review__busy"><Spinner label="Re-estimating…" /></div>}
          </Card>

          <Card title="Ready when you are">
            {!wallet.isConnected && (
              <Banner tone="warn" title="Wallet not connected">
                Connect a wallet to estimate and create your token.
              </Banner>
            )}
            {!metadataUri && formOk && (
              <Banner tone="info">
                Finish the metadata step: upload the JSON, or paste and validate a URI.
              </Banner>
            )}
            <Button variant="primary" size="lg" disabled={!ready} loading={planning && !cost} onClick={openReview} className="w-full">
              Review transaction
            </Button>
            <p className="footnote">
              One transaction. {form.revokeMint ? 'Mint authority revoked. ' : ''}
              {form.revokeFreeze ? 'No freeze authority. ' : ''}
              On {network.label}.
            </p>
          </Card>
        </div>
      </div>

      {plan && (
        <TxReview
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          title="Create token"
          summary={`Creates ${form.name.trim()} (${form.symbol.trim().toUpperCase()}) on ${network.label} with ${choice.label}. ${
            form.tokenProgram === 'token2022' ? 'Metadata is stored inside the Token-2022 mint.' : 'Metadata is a Metaplex account.'
          }`}
          transactions={txs}
          partialSigners={txs.map(() => [plan.mintKeypair])}
          priorityFeeMicroLamports={settings.priorityFeeMicroLamports}
          costRows={
            cost
              ? [
                  { label: 'Rent (all recoverable)', lamports: cost.rentMint + cost.rentAta + cost.rentMetadata },
                  { label: 'Platform fee', lamports: 0 },
                ]
              : []
          }
          warnings={[
            ...(form.tokenProgram === 'token2022'
              ? [
                  {
                    title: 'Token-2022 note',
                    body: 'Some older wallets and tools handle Token-2022 poorly. SPL (legacy) is the most compatible choice.',
                  },
                ]
              : []),
          ]}
          notes={plan.notes}
          onSent={onSent}
        />
      )}

      <SuccessModal
        open={Boolean(success)}
        onClose={() => setSuccess(null)}
        title="Token created"
        subtitle={
          success
            ? `${form.name.trim()} (${form.symbol.trim().toUpperCase()}) is live on ${network.label}. Save the mint address below — it is the only unique identifier for this token.`
            : ''
        }
        network={network}
        linkData={
          success
            ? {
                mint: success.mintAddress,
                signature: success.signature,
                address: success.mintAddress,
                addressLabel: 'View token on Solana Explorer',
              }
            : {}
        }
        hidePlatforms
        rows={
          success
            ? [
                { label: 'Name', value: form.name.trim() },
                { label: 'Symbol', value: form.symbol.trim().toUpperCase() },
                { label: 'Decimals', value: String(form.decimals) },
                { label: 'Initial supply', value: String(form.supply) },
                { label: 'Standard', value: choice.label },
                { label: 'Network', value: network.label },
                { label: 'Mint address', value: success.mintAddress, mono: true, copy: true },
              ]
            : []
        }
      />
    </div>
  )
}
