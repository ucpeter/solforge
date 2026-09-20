/**
 * Trust-core unit tests — deterministic, no cluster needed.
 *
 * The whole point of SolForge is that `assertNoHiddenSOL` never blocks a
 * legitimate transaction and never lets a hidden fee through. These tests pin
 * both directions with real instruction builders and stubbed account lookups.
 */
import { describe, it, expect } from 'vitest'
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  assertNoHiddenSOL,
  inspectTransaction,
  messageAccountKeys,
} from '../src/lib/txkit.js'

const SYSTEM = '11111111111111111111111111111111'

/** Stub connection: only knows the accounts you tell it about. */
function stubConnection(accounts = {}) {
  return {
    getAccountInfo: async (addr) => accounts[addr.toBase58?.() ?? addr] ?? null,
  }
}

function buildWrapTx(wallet) {
  const tx = new Transaction()
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey)
  tx.add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: 1_000_000_000 }),
    createSyncNativeInstruction(wsolAta)
  )
  tx.feePayer = wallet.publicKey
  return { tx, wsolAta }
}

describe('assertNoHiddenSOL', () => {
  it('allows the SOL wrap: transfer into a WSOL ATA created in the same tx', async () => {
    const wallet = Keypair.generate()
    const { tx, wsolAta } = buildWrapTx(wallet)
    const conn = stubConnection({}) // ATA does not exist on-chain
    const insp = await inspectTransaction(conn, tx, wallet.publicKey, [])
    const move = insp.solMovements.find((m) => m.to === wsolAta.toBase58())
    expect(move).toBeTruthy()
    expect(move.classification).toBe('own-new-account')
    expect(insp.unexplainedSolOut).toBe(0)
    assertNoHiddenSOL(insp, wallet.publicKey) // must not throw
  })

  it('allows transfer into an existing token account you own', async () => {
    const wallet = Keypair.generate()
    const otherAta = Keypair.generate().publicKey // pretend existing token account
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: otherAta, lamports: 123_456 })
    )
    tx.feePayer = wallet.publicKey
    const conn = stubConnection({
      [otherAta.toBase58()]: {
        owner: TOKEN_PROGRAM_ID,
        data: Buffer.concat([Buffer.alloc(32), wallet.publicKey.toBuffer(), Buffer.alloc(32)]),
        lamports: 2039280,
      },
    })
    const insp = await inspectTransaction(conn, tx, wallet.publicKey, [])
    expect(insp.solMovements[0].classification).toBe('own-token-account')
    assertNoHiddenSOL(insp, wallet.publicKey)
  })

  it('BLOCKS a transfer to an EOA you do not own (the hidden-fee case)', async () => {
    const wallet = Keypair.generate()
    const thief = Keypair.generate().publicKey
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: thief, lamports: 100_000_000 })
    )
    tx.feePayer = wallet.publicKey
    const conn = stubConnection({
      [thief.toBase58()]: { owner: new PublicKey(SYSTEM), data: Buffer.alloc(0), lamports: 1 },
    })
    const insp = await inspectTransaction(conn, tx, wallet.publicKey, [])
    expect(insp.solMovements[0].classification).toBe('external')
    expect(insp.unexplainedSolOut).toBe(100_000_000)
    expect(() => assertNoHiddenSOL(insp, wallet.publicKey)).toThrow(/Blocked/)
  })

  it('BLOCKS a transfer to a token account owned by somebody else', async () => {
    const wallet = Keypair.generate()
    const stranger = Keypair.generate().publicKey
    const theirAta = Keypair.generate().publicKey
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: theirAta, lamports: 50_000_000 })
    )
    tx.feePayer = wallet.publicKey
    const conn = stubConnection({
      [theirAta.toBase58()]: {
        owner: TOKEN_PROGRAM_ID,
        data: Buffer.concat([Buffer.alloc(32), stranger.toBuffer(), Buffer.alloc(32)]),
        lamports: 2039280,
      },
    })
    const insp = await inspectTransaction(conn, tx, wallet.publicKey, [])
    expect(insp.solMovements[0].classification).toBe('external')
    expect(() => assertNoHiddenSOL(insp, wallet.publicKey)).toThrow(/Blocked/)
  })

  it('classifies program-created vault deposits via post-states (pool deposit shape)', async () => {
    const wallet = Keypair.generate()
    const tempVault = Keypair.generate().publicKey // program will create this mid-tx
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: tempVault, lamports: 1_000_000_000 })
    )
    tx.feePayer = wallet.publicKey
    const conn = stubConnection({}) // nothing exists pre-tx

    const programOwner = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
    const postStates = new Map([
      [
        tempVault.toBase58(),
        {
          lamports: 1_000_000_000,
          owner: TOKEN_PROGRAM_ID.toBase58(),
          data: Buffer.concat([Buffer.alloc(32), programOwner.toBuffer(), Buffer.alloc(32)]),
        },
      ],
    ])

    const insp = await inspectTransaction(conn, tx, wallet.publicKey, [], postStates)
    expect(insp.solMovements[0].classification).toBe('program-deposit')
    expect(insp.solMovements[0].note).toContain('pool')
    assertNoHiddenSOL(insp, wallet.publicKey) // visible deposit → allowed
  })

  it('messageAccountKeys includes fee payer and every instruction account', () => {
    const wallet = Keypair.generate()
    const { tx, wsolAta } = buildWrapTx(wallet)
    const keys = messageAccountKeys(tx)
    expect(keys).toContain(wallet.publicKey.toBase58())
    expect(keys).toContain(wsolAta.toBase58())
    expect(keys).toContain(NATIVE_MINT.toBase58())
  })
})
