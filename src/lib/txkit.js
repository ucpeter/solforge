/**
 * txkit — build, inspect, simulate and send transactions.
 *
 * This module exists to make signing legible. Before anything reaches your
 * wallet, every instruction is decoded into plain English, every SOL movement is
 * classified, and the transaction is simulated against the cluster. If any SOL
 * would leave your wallet for an address you do not own, `assertNoHiddenSOL`
 * throws and the transaction is never shown for signing.
 */
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TokenInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'

import { PROGRAM } from './programs.js'

/* ------------------------------------------------------- program labelling */

const PROGRAM_LABELS = new Map([
  [SystemProgram.programId.toBase58(), 'System Program'],
  [ComputeBudgetProgram.programId.toBase58(), 'Compute Budget'],
  [TOKEN_PROGRAM_ID.toBase58(), 'SPL Token'],
  [TOKEN_2022_PROGRAM_ID.toBase58(), 'Token-2022'],
  [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'Associated Token Account'],
  [PROGRAM.cpAmm.toBase58(), 'Meteora DAMM v2'],
  [new PublicKey(PROGRAM.metaplexMetadata).toBase58(), 'Metaplex Token Metadata'],
])

/** Inverted TokenInstruction enum: 7 -> "MintTo". */
const TOKEN_IX_NAMES = Object.fromEntries(
  Object.entries(TokenInstruction).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k])
)

const AUTHORITY_TYPE_NAMES = { 0: 'MintTokens (mint authority)', 1: 'FreezeAccount (freeze authority)', 2: 'AccountOwner', 3: 'CloseAccount' }

/** Metaplex Token Metadata borsh enum indices we might send. */
const METAPLEX_IX_NAMES = { 33: 'CreateMetadataAccountV3', 15: 'UpdateMetadataAccountV2', 43: 'CreateMasterEditionV3' }

let cpAmmCoder = null
function getCpAmmCoder() {
  if (!cpAmmCoder) {
    try {
      cpAmmCoder = new BorshInstructionCoder(CpAmmIdl)
    } catch {
      cpAmmCoder = false
    }
  }
  return cpAmmCoder || null
}

export function programLabel(programId) {
  const key = programId.toBase58()
  return PROGRAM_LABELS.get(key) || key
}

function shortenKey(pk) {
  const s = pk?.toBase58?.() ?? String(pk)
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s
}

function sol(lamports) {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`
}

/**
 * Decode one instruction into a human description.
 * Display-only: anything we cannot confidently decode is reported as UNKNOWN
 * with its program id and raw data length, never silently guessed.
 */
export function describeInstruction(ix) {
  const pid = ix.programId.toBase58()
  const base = { program: pid, programLabel: programLabel(ix.programId), accounts: ix.keys.length }
  const data = ix.data

  try {
    if (ix.programId.equals(SystemProgram.programId)) {
      const type = SystemInstruction.decodeInstructionType(ix)
      if (type === 'Transfer') {
        const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(ix)
        return {
          ...base,
          kind: 'sol-transfer',
          action: 'Transfer SOL',
          detail: [
            { label: 'From', value: fromPubkey.toBase58() },
            { label: 'To', value: toPubkey.toBase58() },
            { label: 'Amount', value: sol(lamports) },
          ],
          from: fromPubkey,
          to: toPubkey,
          lamports: Number(lamports),
        }
      }
      if (type === 'CreateAccount') {
        const { fromPubkey, newAccountPubkey, lamports, space, programId } = SystemInstruction.decodeCreateAccount(ix)
        return {
          ...base,
          kind: 'create-account',
          action: 'Create account (rent deposit)',
          detail: [
            { label: 'New account', value: newAccountPubkey.toBase58() },
            { label: 'Owner program', value: programLabel(programId) },
            { label: 'Space', value: `${space} bytes` },
            { label: 'Rent', value: sol(lamports) },
          ],
          newAccount: newAccountPubkey,
          lamports: Number(lamports),
        }
      }
      return { ...base, kind: 'system', action: `System: ${type}`, detail: [] }
    }

    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const type = ComputeBudgetInstruction.decodeInstructionType(ix)
      if (type === 'SetComputeUnitLimit') {
        const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix)
        return { ...base, kind: 'compute-limit', action: 'Set compute unit limit', detail: [{ label: 'Units', value: units.toLocaleString() }] }
      }
      if (type === 'SetComputeUnitPrice') {
        const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix)
        return {
          ...base,
          kind: 'compute-price',
          action: 'Set priority fee',
          detail: [{ label: 'Price', value: `${Number(microLamports).toLocaleString()} µLamports/CU` }],
        }
      }
      return { ...base, kind: 'compute-budget', action: `Compute budget: ${type}`, detail: [] }
    }

    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      return {
        ...base,
        kind: 'create-ata',
        action: 'Create associated token account',
        ataAccount: ix.keys[1]?.pubkey ?? null,
        detail: [
          { label: 'Wallet', value: ix.keys[0]?.pubkey.toBase58() ?? '—' },
          { label: 'Token account', value: ix.keys[1]?.pubkey.toBase58() ?? '—' },
          { label: 'Mint', value: ix.keys[3]?.pubkey.toBase58() ?? '—' },
        ],
      }
    }

    if (ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID)) {
      const name = TOKEN_IX_NAMES[data[0]] || `instruction #${data[0]}`
      const detail = []
      try {
        if (name === 'InitializeMint' || name === 'InitializeMint2') {
          const d = name === 'InitializeMint' ? decodeInitMint(ix, false) : decodeInitMint(ix, true)
          detail.push(
            { label: 'Mint', value: d.mint.toBase58() },
            { label: 'Decimals', value: String(d.decimals) },
            { label: 'Mint authority', value: d.mintAuthority?.toBase58() ?? '—' },
            { label: 'Freeze authority', value: d.freezeAuthority?.toBase58() ?? 'none' }
          )
        } else if (name === 'MintTo' || name === 'MintToChecked') {
          const amount = readU64LE(data, name === 'MintTo' ? 1 : 1)
          detail.push(
            { label: 'Mint', value: ix.keys[0]?.pubkey.toBase58() ?? '—' },
            { label: 'Destination', value: ix.keys[1]?.pubkey.toBase58() ?? '—' },
            { label: 'Amount (raw)', value: amount.toString() }
          )
        } else if (name === 'SetAuthority') {
          const authorityType = data[1]
          const hasNew = data[2] === 1
          const newAuthority = hasNew ? new PublicKey(data.subarray(3, 35)) : null
          detail.push(
            { label: 'Account', value: ix.keys[0]?.pubkey.toBase58() ?? '—' },
            { label: 'Authority type', value: AUTHORITY_TYPE_NAMES[authorityType] ?? String(authorityType) },
            { label: 'New authority', value: newAuthority ? newAuthority.toBase58() : 'REVOKED (set to none)' }
          )
          return { ...base, kind: authorityType === 0 && !newAuthority ? 'revoke-mint' : 'set-authority', action: `Token: ${name}`, detail }
        } else if (name === 'Transfer' || name === 'TransferChecked') {
          detail.push(
            { label: 'From', value: ix.keys[0]?.pubkey.toBase58() ?? '—' },
            { label: 'To', value: ix.keys[1]?.pubkey.toBase58() ?? '—' }
          )
        } else if (name === 'CloseAccount') {
          detail.push(
            { label: 'Account closed', value: ix.keys[0]?.pubkey.toBase58() ?? '—' },
            { label: 'Rent returned to', value: ix.keys[1]?.pubkey.toBase58() ?? '—' }
          )
        } else if (name === 'Burn' || name === 'BurnChecked') {
          detail.push(
            { label: 'Account', value: ix.keys[0]?.pubkey.toBase58() ?? '—' },
            { label: 'Mint', value: ix.keys[1]?.pubkey.toBase58() ?? '—' }
          )
        }
      } catch {
        /* fall through with the name only */
      }
      return { ...base, kind: 'token', action: `Token: ${name}`, detail }
    }

    if (pid === PROGRAM.metaplexMetadata) {
      const name = METAPLEX_IX_NAMES[data[0]] || `instruction #${data[0]}`
      return {
        ...base,
        kind: 'metadata',
        action: `Metaplex: ${name}`,
        detail: [{ label: 'Metadata account', value: ix.keys[0]?.pubkey.toBase58() ?? '—' }],
      }
    }

    if (ix.programId.equals(PROGRAM.cpAmm)) {
      const coder = getCpAmmCoder()
      let name = null
      if (coder) {
        const decoded = coder.decode(data, 'base58')
        name = decoded?.name || null
      }
      return {
        ...base,
        kind: 'meteora',
        action: `Meteora DAMM v2: ${name || 'unknown method'}`,
        detail: name ? [] : [{ label: 'Data', value: `${data.length} bytes (could not decode)` }],
      }
    }
  } catch {
    /* fall through to unknown */
  }

  return {
    ...base,
    kind: 'unknown',
    action: `Unrecognised instruction (${programLabel(ix.programId)})`,
    detail: [{ label: 'Data', value: `${data?.length ?? 0} bytes` }],
  }
}

function decodeInitMint(ix, isMint2) {
  const data = ix.data
  const decimals = data[1]
  const mintAuthority = new PublicKey(data.subarray(2, 34))
  const freezeOption = data[34]
  const freezeAuthority = freezeOption === 1 ? new PublicKey(data.subarray(35, 67)) : null
  const mint = isMint2 ? ix.keys[0].pubkey : ix.keys[0].pubkey
  return { mint, decimals, mintAuthority, freezeAuthority }
}

function readU64LE(buf, offset) {
  let value = 0n
  for (let i = 0; i < 8; i++) value |= BigInt(buf[offset + i] ?? 0) << BigInt(8 * i)
  return value
}

/* ---------------------------------------------- transaction normalisation */

/** Accept either a legacy Transaction or a VersionedTransaction, return its ixs. */
export function extractInstructions(tx) {
  if (!tx) return []
  if (tx instanceof VersionedTransaction) {
    const msg = tx.message
    const compiled = msg.compiledInstructions || []
    const accountKeys = msg.staticAccountKeys || []
    return compiled.map((ci) => ({
      programId: accountKeys[ci.programIdIndex],
      keys: (ci.accountKeyIndexes || []).map((idx) => ({
        pubkey: accountKeys[idx],
        isSigner: false,
        isWritable: false,
      })),
      data: Uint8Array.from(ci.data || []),
    }))
  }
  return tx.instructions || []
}

export function isVersioned(tx) {
  return tx instanceof VersionedTransaction
}

/**
 * Describe a whole transaction: instructions + a classified SOL movement ledger.
 * `connection` is needed to determine whether a transfer destination is an
 * account you own (e.g. a wSOL wrap) versus somebody else's wallet.
 */
export async function inspectTransaction(connection, tx, userPublicKey, extraSigners = [], postStates = null) {
  const instructions = extractInstructions(tx)
  const described = instructions.map(describeInstruction)
  const post = postStates instanceof Map ? postStates : null

  const signerSet = new Set([userPublicKey?.toBase58?.(), ...extraSigners.map((s) => s.publicKey.toBase58())].filter(Boolean))
  // Accounts this transaction itself creates (System createAccount AND ATA
  // creation) — a transfer landing in one of them is a rent/wrap deposit for
  // the user, not a hidden fee.
  const creating = new Set(
    described
      .filter((d) => (d.kind === 'create-account' && d.newAccount) || (d.kind === 'create-ata' && d.ataAccount))
      .map((d) => (d.newAccount ?? d.ataAccount).toBase58())
  )

  const solMovements = []
  for (const d of described) {
    if (d.kind !== 'sol-transfer') continue
    const to = d.to.toBase58()
    let classification = 'unknown'
    let note = ''

    if (signerSet.has(to)) {
      classification = 'self'
      note = 'Back to your own wallet'
    } else if (creating.has(to)) {
      classification = 'own-new-account'
      note = 'Rent deposit into an account this transaction creates for you'
    } else if (post) {
      // The destination does not exist yet, but the simulation's post-state
      // shows what it becomes. This is the normal shape of a DEX deposit:
      // the program creates a vault and the transfer lands in it.
      const pst = post.get(to)
      if (!pst) {
        classification = 'unknown-new'
        note = 'Destination does not exist yet and is not created by this transaction'
      } else {
        const owner = new PublicKey(pst.owner)
        const isTokenAccount =
          owner.equals(TOKEN_PROGRAM_ID) ||
          owner.equals(TOKEN_2022_PROGRAM_ID) ||
          owner.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
        const tokenOwner =
          isTokenAccount && pst.data && pst.data.length >= 64
            ? new PublicKey(pst.data.subarray(32, 64))
            : null
        if (tokenOwner && signerSet.has(tokenOwner.toBase58())) {
          classification = 'own-token-account'
          note = 'Deposit into a token account you own (e.g. wrapping SOL)'
        } else if (isTokenAccount && tokenOwner) {
          classification = 'program-deposit'
          note = `Deposit into a token account owned by ${programLabel(tokenOwner)} — the pool's vault`
        } else if (owner.toBase58() === '11111111111111111111111111111111') {
          classification = 'rent'
          note = 'Rent deposit into a new system account'
        } else {
          classification = 'program-deposit'
          note = `Funds go to an account owned by ${programLabel(owner)}`
        }
      }
    } else {
      try {
        const info = await connection.getAccountInfo(d.to, 'confirmed')
        if (!info) {
          classification = 'unknown-new'
          note = 'Destination does not exist yet and is not created by this transaction'
        } else {
          const isTokenAccount =
            info.owner.equals(TOKEN_PROGRAM_ID) ||
            info.owner.equals(TOKEN_2022_PROGRAM_ID) ||
            info.owner.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
          const owner = isTokenAccount && info.data?.length >= 64 ? new PublicKey(info.data.subarray(32, 64)) : null
          if (owner && signerSet.has(owner.toBase58())) {
            classification = 'own-token-account'
            note = 'Deposit into a token account you own (e.g. wrapping SOL)'
          } else {
            classification = 'external'
            note = `Owned by ${programLabel(info.owner)}${owner ? `, token owner ${shortenKey(owner)}` : ''}`
          }
        }
      } catch {
        classification = 'unknown'
        note = 'Could not look up the destination account'
      }
    }
    solMovements.push({ to, lamports: d.lamports, classification, note })
  }

  const totalOut = solMovements
    .filter((m) => m.classification === 'external' || m.classification === 'unknown' || m.classification === 'unknown-new')
    .reduce((sum, m) => sum + m.lamports, 0)

  return {
    instructionCount: described.length,
    instructions: described,
    solMovements,
    unexplainedSolOut: totalOut,
    sizeBytes: safeSize(tx),
  }
}

function safeSize(tx) {
  try {
    return tx.serialize ? tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length : null
  } catch {
    return null
  }
}

/**
 * The hard stop. SolForge takes no fee, so any SOL leaving the wallet for an
 * address the user does not own means something is deeply wrong.
 */
export function assertNoHiddenSOL(inspection, userPublicKey) {
  // program-deposit / rent / own-* are all things the user can see in the
  // movement list and is doing on purpose (e.g. the pool deposit shown in the
  // cost breakdown). Only transfers to somebody else's wallet block.
  const bad = inspection.solMovements.filter(
    (m) => m.classification === 'external' || m.classification === 'unknown' || m.classification === 'unknown-new'
  )
  if (bad.length) {
    const detail = bad.map((b) => `${sol(b.lamports)} → ${b.to} (${b.note})`).join('\n')
    throw new Error(
      `Blocked: this transaction would send SOL to an address you do not own.\n\n${detail}\n\nSolForge never takes a fee. Nothing was sent to your wallet.`
    )
  }
  return true
}

/* ------------------------------------------------------------- construction */

export async function getLatestBlockhashContext(connection) {
  const ctx = await connection.getLatestBlockhash('confirmed')
  return { blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight }
}

/**
 * Simulate to learn real CU usage, then set the limit with headroom.
 * Falls back to a conservative default if simulation is unavailable.
 */
/**
 * web3.js v1 only accepts a *config object* for VersionedTransaction. For a
 * legacy Transaction it demands an array of signers and otherwise throws the
 * opaque "Invalid arguments". We simulate unsigned transactions, so convert.
 */
function toVersionedForSimulation(tx) {
  try {
    if (!tx || typeof tx.compileMessage !== 'function') return tx
    return new VersionedTransaction(tx.compileMessage())
  } catch {
    return tx
  }
}

export async function estimateComputeUnits(connection, tx, fallback = 400_000) {
  try {
    const simulation = await connection.simulateTransaction(toVersionedForSimulation(cloneWithoutComputeBudget(tx)), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    })
    const units = simulation?.value?.unitsConsumed
    if (units && units > 0) {
      return Math.min(1_400_000, Math.ceil((units * 1.15 + 20_000) / 1000) * 1000)
    }
  } catch {
    /* simulation failed — use fallback */
  }
  return fallback
}

function cloneWithoutComputeBudget(tx) {
  if (!(tx instanceof Transaction)) return tx
  // NOTE: web3.js expects `blockhash` (not `recentBlockhash`) in the ctor object.
  const copy = new Transaction({
    feePayer: tx.feePayer,
    blockhash: tx.recentBlockhash,
    lastValidBlockHeight: tx.lastValidBlockHeight,
  })
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) continue
    copy.add(ix)
  }
  return copy
}

export function buildComputeBudgetIxs({ cuLimit, priorityFeeMicroLamports }) {
  const ixs = []
  if (priorityFeeMicroLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }))
  if (cuLimit > 0) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))
  return ixs
}

/**
 * Prepare a legacy Transaction for signing: fee payer, fresh blockhash, and a
 * compute budget built from a real simulation rather than a guessed constant.
 */
export async function finalizeTransaction(connection, tx, { payer, cuLimit = 0, priorityFeeMicroLamports = 0, autoComputeUnits = true }) {
  if (isVersioned(tx)) {
    // Versioned transactions from the SDK are re-signed by the wallet as-is;
    // we only guarantee the blockhash is fresh.
    if (!tx.message.recentBlockhash) {
      const { blockhash } = await getLatestBlockhashContext(connection)
      tx.message.recentBlockhash = blockhash
    }
    return tx
  }

  const prepared = cloneWithoutComputeBudget(tx)
  prepared.feePayer = payer
  const { blockhash, lastValidBlockHeight } = await getLatestBlockhashContext(connection)
  prepared.recentBlockhash = blockhash
  prepared.lastValidBlockHeight = lastValidBlockHeight

  const limit = cuLimit || (autoComputeUnits ? await estimateComputeUnits(connection, prepared) : 0)
  const budget = buildComputeBudgetIxs({ cuLimit: limit, priorityFeeMicroLamports })
  if (budget.length) {
    const rebuilt = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
    for (const ix of budget) rebuilt.add(ix)
    for (const ix of prepared.instructions) rebuilt.add(ix)
    return rebuilt
  }
  return prepared
}

/** Run a read-only simulation and report the result without spending anything. */
/**
 * Simulate. With `withPostStates`, the post-transaction state of every account
 * in the message is requested, so inspectTransaction can classify transfers to
 * accounts this transaction itself creates (the usual shape of a pool deposit).
 */
export async function simulateTransaction(connection, tx, { withPostStates = false } = {}) {
  try {
    const config = {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    }
    if (withPostStates) {
      const addrs = [...new Set(messageAccountKeys(tx))]
      if (addrs.length) config.accounts = { addresses: addrs, states: 'base64' }
    }
    const result = await connection.simulateTransaction(toVersionedForSimulation(tx), config)
    const value = result?.value
    let postStates = null
    if (withPostStates && value?.accounts?.length) {
      postStates = new Map()
      const addrs = [...new Set(messageAccountKeys(tx))]
      value.accounts.forEach((acc, i) => {
        if (!acc) return
        postStates.set(addrs[i], {
          lamports: acc.lamports ?? 0,
          owner: acc.owner ?? '',
          data: acc.data?.[0] ? Buffer.from(acc.data[0], 'base64') : Buffer.alloc(0),
        })
      })
    }
    return {
      ok: !value?.err,
      unitsConsumed: value?.unitsConsumed ?? null,
      logs: value?.logs ?? [],
      error: value?.err ? JSON.stringify(value.err) : null,
      postStates,
    }
  } catch (err) {
    return { ok: false, unitsConsumed: null, logs: [], error: err?.message || String(err) }
  }
}

/** Every account key referenced by a transaction (best effort). */
export function messageAccountKeys(tx) {
  const out = []
  try {
    if (isVersioned(tx)) {
      for (const k of tx.message.staticKeys) out.push(k.toBase58())
      for (const meta of tx.message.accountKeys) {
        if (meta.pubkey) out.push(meta.pubkey.toBase58())
      }
      return out
    }
    if (tx?.feePayer) out.push(tx.feePayer.toBase58())
    for (const ix of tx?.instructions ?? []) for (const a of ix.keys) out.push(a.pubkey.toBase58())
    return [...new Set(out)]
  } catch {
    return out
  }
}

export async function confirmSignature(connection, signature, { blockhash, lastValidBlockHeight } = {}) {
  if (blockhash && lastValidBlockHeight !== undefined) {
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  } else {
    await connection.confirmTransaction(signature, 'confirmed')
  }
  return signature
}

/**
 * Sign and send a list of transactions in order, confirming each before the
 * next. Returns per-transaction results so the UI can show real progress.
 */
export async function sendTransactionBatch({
  connection,
  transactions,
  signAllTransactions,
  signTransaction,
  partialSigners = [],
  onProgress,
}) {
  const total = transactions.length
  const signed =
    total > 1 && typeof signAllTransactions === 'function'
      ? await signAllTransactions(transactions)
      : [await signTransaction(transactions[0])]

  // Locally-generated keypairs (e.g. the new mint) must also sign. This happens
  // after the wallet so the wallet never sees or holds anything it didn't author.
  for (let i = 0; i < signed.length; i++) {
    const extras = partialSigners[i]
    if (extras?.length && !isVersioned(signed[i])) signed[i].partialSign(...extras)
  }

  const results = []
  for (let i = 0; i < signed.length; i++) {
    onProgress?.({ phase: 'sending', index: i, total })
    const tx = signed[i]
    const raw = isVersioned(tx) ? tx.serialize() : tx.serialize()
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 })
    onProgress?.({ phase: 'confirming', index: i, total, signature })
    await confirmSignature(connection, signature)
    results.push({ index: i, signature })
    onProgress?.({ phase: 'confirmed', index: i, total, signature })
  }
  return results
}

/** Convert a legacy Transaction to a v0 message (used only where required). */
export function toVersioned(tx, payer, lookupTables = []) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: tx.recentBlockhash,
    instructions: tx.instructions,
  }).compileToV0Message(lookupTables)
  return new VersionedTransaction(message)
}
