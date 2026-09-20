/**
 * The pre-signature review panel.
 *
 * This is the safety feature the whole rebuild exists for. Before the wallet is
 * ever asked to sign, we:
 *
 *   1. finalise each transaction (fee payer, fresh blockhash, compute budget)
 *   2. decode every instruction into plain English
 *   3. classify every lamport that moves, and hard-fail if any SOL would go to
 *      an address the user does not own (assertNoHiddenSOL)
 *   4. simulate the transaction and show the real compute units it consumed
 *   5. show an exact cost breakdown — network costs only, platform fee zero
 *
 * Only then does the Confirm button become enabled.
 */
import { useEffect, useMemo, useState } from 'react'
import { Banner, Button, Card, KeyValue, Modal, Sol, Spinner } from './ui.jsx'
import {
  assertNoHiddenSOL,
  finalizeTransaction,
  inspectTransaction,
  sendTransactionBatch,
  simulateTransaction,
} from '../lib/txkit.js'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { clsx, lamportsToSol } from '../lib/format.js'

export default function TxReview({
  open,
  onClose,
  title = 'Review this transaction',
  summary,
  transactions = [],
  partialSigners = [],
  costRows = [],
  warnings = [],
  notes = [],
  priorityFeeMicroLamports = 0,
  onSent,
  controls,
  prepDep,
}) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()

  const [phase, setPhase] = useState('preparing') // preparing | ready | blocked | sending | done | failed
  const [prepared, setPrepared] = useState([])
  const [simulations, setSimulations] = useState([])
  const [blocker, setBlocker] = useState(null)
  const [progress, setProgress] = useState(null)
  const [signatures, setSignatures] = useState([])
  const [error, setError] = useState(null)
  const [ackMainnet, setAckMainnet] = useState(false)

  const needsMainnetAck = network.realMoney

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPhase('preparing')
    setBlocker(null)
    setError(null)
    setSignatures([])
    setAckMainnet(false)

    ;(async () => {
      try {
        const finalised = []
        const sims = []
        for (const tx of transactions) {
          const idx = finalised.length
          // inspectTransaction expects KEYPAIRS (it reads s.publicKey itself).
          // Pushing kp.publicKey here double-unwrapped them and crashed the
          // review for any transaction with an extra signer (e.g. the mint keypair).
          const extras = partialSigners[idx] ?? []

          const fin = await finalizeTransaction(connection, tx, {
            payer: wallet.publicKey,
            priorityFeeMicroLamports,
          })
          // Simulate first: the post-transaction states let the inspector
          // recognise deposits into accounts this very transaction creates
          // (a pool vault), instead of flagging them as unknown destinations.
          const sim = await simulateTransaction(connection, fin, { withPostStates: true })
          const inspection = await inspectTransaction(
            connection,
            fin,
            wallet.publicKey,
            extras,
            sim.postStates
          )

          // Hard stop: no SOL may leave for an address the user does not own.
          assertNoHiddenSOL(inspection, wallet.publicKey)

          if (cancelled) return
          finalised.push({ tx: fin, inspection })
          sims.push(sim)
        }
        if (cancelled) return
        setPrepared(finalised)
        setSimulations(sims)
        setPhase('ready')
      } catch (err) {
        if (cancelled) return
        setBlocker(err?.message || String(err))
        setPhase('blocked')
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prepDep])

  const totals = useMemo(() => {
    const signatureFee = prepared.reduce((sum, p) => sum + 5000 * p.tx.signatures.length, 0)
    const priorityFee = prepared.reduce((sum, p, i) => {
      const units = simulations[i]?.unitsConsumed ?? 0
      return sum + Math.ceil((priorityFeeMicroLamports * units) / 1_000_000)
    }, 0)
    const units = simulations.reduce((sum, s) => sum + (s.unitsConsumed ?? 0), 0)
    const solOut = prepared.reduce((sum, p) => sum + p.inspection.unexplainedSolOut, 0)
    return { signatureFee, priorityFee, units, solOut }
  }, [prepared, simulations, priorityFeeMicroLamports])

  const canSend =
    phase === 'ready' && wallet.isConnected && prepared.length > 0 && (!needsMainnetAck || ackMainnet)

  async function send() {
    setPhase('sending')
    setError(null)
    try {
      const results = await sendTransactionBatch({
        connection,
        transactions: prepared.map((p) => p.tx),
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.supportsBatchSigning ? wallet.signAllTransactions : undefined,
        partialSigners,
        onProgress: setProgress,
      })
      setSignatures(results.map((r) => r.signature))
      setPhase('done')
      await onSent?.(results)
    } catch (err) {
      setError(err?.message || String(err))
      setPhase('failed')
    }
  }

  const simFailed = simulations.find((s) => !s.ok)

  return (
    <Modal
      open={open}
      onClose={phase === 'sending' ? undefined : onClose}
      title={title}
      wide
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={phase === 'sending'}>
              Cancel
            </Button>
            <Button variant="primary" onClick={send} disabled={!canSend || Boolean(simFailed)} loading={phase === 'sending'}>
              {progress ? `${progress.phase} ${progress.index + 1}/${progress.total}` : 'Confirm & sign'}
            </Button>
          </>
        )
      }
    >
      {controls}
      {summary && <p className="review__summary">{summary}</p>}

      {needsMainnetAck && phase !== 'done' && (
        <Banner tone="danger" title="This is mainnet — real money">
          Every SOL and token spent here is real and irreversible. Check the instructions below before signing.
          <label className="ack">
            <input type="checkbox" checked={ackMainnet} onChange={(e) => setAckMainnet(e.target.checked)} />
            I understand this transaction is on mainnet and cannot be undone.
          </label>
        </Banner>
      )}

      {phase === 'preparing' && (
        <div className="review__busy">
          <Spinner label="Decoding and simulating…" />
        </div>
      )}

      {phase === 'blocked' && (
        <Banner tone="danger" title="Blocked — nothing was sent">
          <pre className="review__pre">{blocker}</pre>
        </Banner>
      )}

      {phase !== 'preparing' && phase !== 'blocked' && (
        <>
          {warnings.map((w, i) => (
            <Banner key={i} tone="warn" title={w.title}>
              {w.body}
            </Banner>
          ))}

          {simFailed && (
            <Banner tone="danger" title="Simulation failed — this transaction would revert">
              <pre className="review__pre">
                {simFailed.error}
                {simFailed.logs?.length ? `\n\n${simFailed.logs.slice(-12).join('\n')}` : ''}
              </pre>
            </Banner>
          )}

          {prepared.map((p, i) => (
            <Card
              key={i}
              title={prepared.length > 1 ? `Transaction ${i + 1} of ${prepared.length}` : 'Instructions'}
              subtitle={`${p.inspection.instructionCount} instructions · ${p.inspection.sizeBytes ?? '?'} bytes · ${
                simulations[i]?.unitsConsumed ?? '?'
              } compute units`}
              tone={simulations[i]?.ok ? undefined : 'danger'}
            >
              <ol className="ixlist">
                {p.inspection.instructions.map((d, j) => (
                  <li key={j} className={clsx('ix', d.kind === 'unknown' && 'ix--unknown')}>
                    <span className="ix__n">{j + 1}</span>
                    <span className="ix__body">
                      <span className="ix__action">{d.action}</span>
                      <span className="ix__program">{d.programLabel}</span>
                      {d.detail?.length > 0 && (
                        <span className="ix__detail">
                          {d.detail.map((x, k) => (
                            <span key={k}>
                              <b>{x.label}:</b> {String(x.value)}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>

              {p.inspection.solMovements.length > 0 && (
                <div className="solmoves">
                  <h4>SOL movements</h4>
                  <ul>
                    {p.inspection.solMovements.map((m, k) => (
                      <li key={k} className={clsx('solmove', `solmove--${m.classification}`)}>
                        <Sol lamports={m.lamports} />
                        <span className="solmove__to">{m.to.slice(0, 6)}…{m.to.slice(-4)}</span>
                        <span className="solmove__note">{m.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          ))}

          <Card title="What this costs">
            <KeyValue
              items={[
                ...costRows,
                { label: 'Signature fees', value: <Sol lamports={totals.signatureFee} precision={9} />, mono: true },
                priorityFeeMicroLamports
                  ? {
                      label: `Priority fee (${priorityFeeMicroLamports.toLocaleString()} µLamports/CU)`,
                      value: <Sol lamports={totals.priorityFee} precision={9} />,
                      mono: true,
                    }
                  : { label: 'Priority fee', value: 'not set — you chose 0', mono: true },
                { label: 'Platform fee', value: '0 SOL — SolForge takes nothing', tone: 'good', mono: true },
                totals.solOut
                  ? { label: 'SOL to addresses you do not own', value: <Sol lamports={totals.solOut} />, tone: 'bad', mono: true }
                  : null,
                {
                  label: 'Rent (recoverable)',
                  value: 'Accounts you create stay yours; closing them returns the rent.',
                },
              ]}
            />
          </Card>

          {notes.length > 0 && (
            <Card title="Notes">
              <ul className="notes">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Card>
          )}

          {error && (
            <Banner tone="danger" title="Sending failed">
              <pre className="review__pre">{error}</pre>
            </Banner>
          )}

          {phase === 'done' && signatures.length > 0 && (
            <Banner tone="good" title="Confirmed on chain">
              <ul className="siglist">
                {signatures.map((s) => (
                  <li key={s}>
                    <a href={network.explorerTx(s)} target="_blank" rel="noreferrer noopener">
                      {s.slice(0, 20)}…
                    </a>
                  </li>
                ))}
              </ul>
            </Banner>
          )}
        </>
      )}
    </Modal>
  )
}

/** Convenience: total lamports for a cost row list. */
export function sumLamports(rows) {
  return rows.reduce((s, r) => s + Number(r.lamports ?? 0), 0)
}

export function solFromLamports(l) {
  return lamportsToSol(l)
}
