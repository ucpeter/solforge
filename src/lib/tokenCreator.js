/**
 * Token creation.
 *
 * Builds real instructions for two genuinely different standards, and reports
 * exactly what each one costs. Nothing here transfers SOL to anyone but the
 * user and the accounts the user is creating.
 *
 *   • SPL Token (legacy) + Metaplex Token Metadata  → 1 transaction
 *   • Token-2022 + native MetadataPointer extension → 1–2 transactions
 */
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getMintLen,
  LENGTH_SIZE,
  TYPE_SIZE,
} from '@solana/spl-token'
import { createInitializeInstruction as createToken2022MetadataInit } from '@solana/spl-token-metadata'
import { createCreateMetadataAccountV3Instruction, createUpdateMetadataAccountV2Instruction } from '@metaplex-foundation/mpl-token-metadata'
import BN from 'bn.js'

import { PROGRAM, RENOUNCED_UPDATE_AUTHORITY } from './programs.js'
import { byteLength, toRawAmount, U64_MAX } from './format.js'
import { LIMITS } from './config.js'

/** Rent is (128 + dataLen) * 6960 lamports on Solana. */
const LAMPORTS_PER_BYTE_YEAR_FACTOR = 6960
export function rentExemptLamports(dataLength) {
  return (128 + dataLength) * LAMPORTS_PER_BYTE_YEAR_FACTOR
}

/**
 * Metaplex allocates the metadata account at creation time. The size depends on
 * name/symbol/uri, so we model it: fixed struct overhead + the three strings.
 * Calibrated against a real devnet mint (see README "Verified on devnet").
 */
const METAPLEX_FIXED_OVERHEAD_BYTES = 121
export function estimateMetaplexMetadataBytes({ name, symbol, uri }) {
  return METAPLEX_FIXED_OVERHEAD_BYTES + byteLength(name) + byteLength(symbol) + byteLength(uri)
}

/** Token-2022 stores metadata inside the mint account, appended after init. */
const TOKEN2022_METADATA_OVERHEAD_BYTES = 68
export function estimateToken2022MetadataBytes({ name, symbol, uri }) {
  return TOKEN2022_METADATA_OVERHEAD_BYTES + byteLength(name) + byteLength(symbol) + byteLength(uri)
}

/* -------------------------------------------------------------- validation */

export function validateTokenForm(form) {
  const errors = {}
  if (!form.name?.trim()) errors.name = 'Token name is required.'
  else if (byteLength(form.name) > LIMITS.tokenNameBytes)
    errors.name = `Name is ${byteLength(form.name)} bytes; on-chain limit is ${LIMITS.tokenNameBytes}.`

  if (!form.symbol?.trim()) errors.symbol = 'Symbol is required.'
  else if (byteLength(form.symbol) > LIMITS.tokenSymbolBytes)
    errors.symbol = `Symbol is ${byteLength(form.symbol)} bytes; on-chain limit is ${LIMITS.tokenSymbolBytes}.`

  const decimals = Number(form.decimals)
  if (!Number.isInteger(decimals) || decimals < LIMITS.decimalsMin || decimals > LIMITS.decimalsMax)
    errors.decimals = `Decimals must be an integer between ${LIMITS.decimalsMin} and ${LIMITS.decimalsMax}.`

  // Supply is validated as an exact integer string, then range-checked against
  // the on-chain u64 maximum — NOT Number.MAX_SAFE_INTEGER, which would wrongly
  // reject the standard 1,000,000,000 supply at 9 decimals (1e18 raw units).
  const supplyStr = String(form.supply ?? '').trim().replace(/,/g, '')
  if (!/^\d*\.?\d+$/.test(supplyStr)) {
    errors.supply = 'Supply must be a positive number.'
  } else if (decimals >= 0) {
    const raw = BigInt(toRawAmount(supplyStr, decimals))
    if (raw === 0n) errors.supply = 'Supply must be greater than zero.'
    else if (raw > U64_MAX)
      errors.supply = `Supply × 10^${decimals} exceeds the on-chain maximum (u64). Lower the supply or the decimals.`
  }

  if (form.metadataUri && byteLength(form.metadataUri) > LIMITS.metadataUriBytes)
    errors.metadataUri = `URI is ${byteLength(form.metadataUri)} bytes; on-chain limit is ${LIMITS.metadataUriBytes}.`

  return { ok: Object.keys(errors).length === 0, errors }
}

/* ------------------------------------------------------------------- build */

/**
 * Assemble the instructions that create the token.
 *
 * @returns {{instructions, mintKeypair, mint, ata, metadataAccount, rent, tokenProgram, notes}}
 */
export async function buildTokenCreation(connection, { payer, form, metadataUri }) {
  const validation = validateTokenForm({ ...form, metadataUri })
  if (!validation.ok) {
    throw new Error(`Invalid token details:\n${Object.values(validation.errors).join('\n')}`)
  }

  const is2022 = form.tokenProgram === 'token2022'
  const tokenProgram = is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const mintKeypair = Keypair.generate()
  const mint = mintKeypair.publicKey
  const decimals = Number(form.decimals)
  const rawSupply = toRawAmount(form.supply, decimals)

  const instructions = []
  const notes = []

  // 1. Allocate the mint account.
  const extensions = is2022 ? [ExtensionType.MetadataPointer] : []
  const mintLen = is2022 ? getMintLen(extensions) : getMintLen([])

  const nameBytes = byteLength(form.name.trim())
  const symbolBytes = byteLength(form.symbol.trim().toUpperCase())
  const uriBytes = byteLength(metadataUri || '')

  // Token-2022 keeps its metadata *inside* the mint account: InitializeTokenMetadata
  // reallocs the account, so the createAccount lamports must already cover the final
  // size — otherwise the transaction fails with InsufficientFundsForRent (verified on
  // a live validator). Layout: TLV type(4) + length(4) + updateAuthority(36) +
  // mint(32) + name/symbol/uri (4-byte length prefix each) + additionalMetadata vec(4).
  const token2022MetadataBytes = is2022
    ? TYPE_SIZE + LENGTH_SIZE + 36 + 32 + (4 + nameBytes) + (4 + symbolBytes) + (4 + uriBytes) + 4
    : 0

  const mintRentBase = await connection.getMinimumBalanceForRentExemption(mintLen)
  const mintRent = await connection.getMinimumBalanceForRentExemption(mintLen + token2022MetadataBytes)

  // The freeze authority is set to null up-front when the user revokes it at
  // creation time — that is cheaper and cleaner than create-then-revoke.
  const freezeAuthority = form.revokeFreeze ? null : payer

  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: mintLen,
      lamports: mintRent,
      programId: tokenProgram,
    })
  )

  let metadataAccount = null
  let metadataRent = 0

  if (is2022) {
    // 2a. MetadataPointer must be initialised BEFORE the mint itself.
    instructions.push(
      createInitializeMetadataPointerInstruction(mint, payer, mint, TOKEN_2022_PROGRAM_ID)
    )
    // 3a. Token-2022 requires initializeMint2 (no separate rent sysvar account).
    instructions.push(createInitializeMint2Instruction(mint, decimals, payer, freezeAuthority, TOKEN_2022_PROGRAM_ID))
    // 4a. Native TokenMetadata TLV entry lives inside the mint account.
    instructions.push(
      createToken2022MetadataInit({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: payer,
        mint,
        mintAuthority: payer,
        name: form.name.trim(),
        symbol: form.symbol.trim().toUpperCase(),
        uri: metadataUri || '',
      })
    )
    metadataAccount = mint
    // Already paid for above as part of the mint account's rent.
    metadataRent = mintRent - mintRentBase
    notes.push('Token-2022 metadata is stored inside the mint account (MetadataPointer + TokenMetadata extensions).')
  } else {
    // 2b. Legacy SPL token mint.
    instructions.push(createInitializeMintInstruction(mint, decimals, payer, freezeAuthority, TOKEN_PROGRAM_ID))
    // 3b. Metaplex metadata PDA.
    const metaplex = new PublicKey(PROGRAM.metaplexMetadata)
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), metaplex.toBuffer(), mint.toBuffer()],
      metaplex
    )
    metadataAccount = pda

    const ix = createCreateMetadataAccountV3Instruction(
      { metadata: pda, mint, mintAuthority: payer, payer, updateAuthority: payer },
      {
        createMetadataAccountArgsV3: {
          data: {
            name: form.name.trim(),
            symbol: form.symbol.trim().toUpperCase(),
            uri: metadataUri || '',
            sellerFeeBasisPoints: 0,
            creators: null,
            collection: null,
            uses: null,
          },
          isMutable: !form.metadataImmutable,
          collectionDetails: null,
        },
      }
    )
    // VERIFIED against a live validator running the current mainnet Metaplex
    // program: CreateMetadataAccountArgsV3 is exactly {data, isMutable,
    // collectionDetails}. Appending a token_standard tag (a trick some launchpads
    // use) fails with InvalidInstructionData, so we do not do it. Legacy SPL
    // tokens therefore carry token_standard = None, which is normal and is what
    // explorers and DEXes expect for this creation path.
    instructions.push(ix)

    metadataRent = rentExemptLamports(estimateMetaplexMetadataBytes({ name: form.name, symbol: form.symbol, uri: metadataUri || '' }))
    notes.push('Legacy SPL token with a Metaplex Token Metadata account (what every explorer and DEX expects).')
  }

  // 4. Associated token account for the creator, then mint the full supply to it.
  const ata = getAssociatedTokenAddressSync(mint, payer, false, tokenProgram)
  instructions.push(createAssociatedTokenAccountInstruction(payer, ata, payer, mint, tokenProgram))
  instructions.push(
    createMintToInstruction(mint, ata, payer, BigInt(rawSupply), [], tokenProgram)
  )

  // 5. Optional authority changes, in the same transaction.
  if (form.revokeMint) {
    instructions.push(createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null, [], tokenProgram))
    notes.push('Mint authority revoked: the supply can never be increased.')
  }
  if (form.revokeFreeze) {
    // Only needed when we set a freeze authority above.
    notes.push('No freeze authority was ever set: no account can be frozen.')
  } else if (form.revokeFreezeLater) {
    instructions.push(createSetAuthorityInstruction(mint, payer, AuthorityType.FreezeAccount, null, [], tokenProgram))
  }
  if (form.renounceMetadataUpdate && !is2022) {
    instructions.push(
      createUpdateMetadataAccountV2Instruction(
        { metadata: metadataAccount, updateAuthority: payer },
        { updateMetadataAccountV2Args: { updateAuthority: new PublicKey(RENOUNCED_UPDATE_AUTHORITY), data: null, primarySaleHappened: null, isMutable: false } }
      )
    )
    notes.push('Metadata update authority renounced: name, symbol and image can never be changed again.')
  }

  const ataRent = await connection.getMinimumBalanceForRentExemption(getAccountLen([]))

  return {
    instructions,
    mintKeypair,
    mint,
    ata,
    metadataAccount,
    tokenProgram,
    is2022,
    notes,
    rent: {
      mint: mintRent,
      ata: ataRent,
      metadata: metadataRent,
      totalRent: mintRent + ataRent + metadataRent,
    },
    decimals,
    rawSupply,
  }
}

/* ------------------------------------------------- transaction size packing */

/** Rough serialised size of one instruction. */
function instructionSize(ix) {
  return ix.keys.length * 33 + 32 + (ix.data?.length ?? 0) + 4
}

/**
 * Greedily pack instructions into as few 1232-byte transactions as possible.
 * Two signatures are budgeted for (you + the generated mint keypair).
 */
export function packInstructions(instructions, { maxBytes = 1232, overhead = 32 + 3 + 128 + 8 } = {}) {
  const groups = []
  let current = []
  let size = overhead
  for (const ix of instructions) {
    const s = instructionSize(ix)
    if (current.length && size + s > maxBytes) {
      groups.push(current)
      current = []
      size = overhead
    }
    current.push(ix)
    size += s
  }
  if (current.length) groups.push(current)
  return groups.map((group) => {
    const tx = new Transaction()
    for (const ix of group) tx.add(ix)
    return tx
  })
}

/* ------------------------------------------------------------------- cost */

/**
 * Full, honest cost breakdown. `platformFee` is always zero — that is the
 * point. Numbers come from the cluster, not from a marketing table.
 */
export async function estimateCreationCost(connection, plan, { priorityFeeMicroLamports = 0, transactionCount = 1, signatureCount = 2 }) {
  const signatureFee = 5000 * signatureCount * transactionCount
  const cuLimit = Math.min(LIMITS.maxComputeUnits, 400_000)
  const priorityFee = Math.ceil((priorityFeeMicroLamports * cuLimit) / 1_000_000)
  return {
    rentMint: plan.rent.mint,
    rentAta: plan.rent.ata,
    rentMetadata: plan.rent.metadata,
    signatureFee,
    priorityFee,
    platformFee: 0,
    total: plan.rent.totalRent + signatureFee + priorityFee,
    transactionCount,
  }
}
