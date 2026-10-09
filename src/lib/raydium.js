/**
 * Raydium CP-MM (Constant Product Market Maker) on-chain pool creation client.
 * Supports both Mainnet and Devnet with 100% native on-chain transaction generation.
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Buffer } from 'buffer'

// Raydium CP-MM Program IDs
export const RAYDIUM_CPMM_PROGRAM_ID = {
  mainnet: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  devnet: new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'),
}

// Raydium Protocol Pool Creation Fee Receivers (0.15 SOL mandatory fee)
export const RAYDIUM_POOL_FEE_RECEIVER = {
  mainnet: new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'),
  devnet: new PublicKey('3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy'),
}

// Default standard AMM configs (0.25% fee tier)
export const RAYDIUM_DEFAULT_CONFIG = {
  mainnet: {
    id: new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2'),
    label: '0.25% (Standard)',
    tradeFeeRate: 2500,
  },
  devnet: {
    id: new PublicKey('5Gt9qrPJ6FVe9VHtwF2W2JrFR6p9jmx4DxBkgfPdaApk'),
    label: '0.25% (Standard Devnet)',
    tradeFeeRate: 2500,
  },
}

// Additional Fee Configurations for Mainnet
export const RAYDIUM_MAINNET_CONFIGS = [
  { id: new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2'), label: '0.25% Fee (Standard Memecoins)' },
  { id: new PublicKey('BhH6HphjBKXu2PkUc2aw3xEMdUvK14NXxE5LbNWZNZAA'), label: '0.50% Fee' },
  { id: new PublicKey('G95xxie3XbkCqtE39GgQ9Ggc7xBC8Uceve7HFDEFApkc'), label: '1.00% Fee' },
]

export const AUTH_SEED = 'vault_and_lp_mint_auth_seed'
export const POOL_SEED = 'pool'
export const POOL_LP_MINT_SEED = 'pool_lp_mint'
export const POOL_VAULT_SEED = 'pool_vault'
export const OBSERVATION_SEED = 'observation'

// Anchor instruction discriminator for "global:initialize"
// sha256("global:initialize")[0..8] = [175, 175, 109, 31, 13, 152, 155, 237]
export const INITIALIZE_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237])

/**
 * Determine token0 and token1 ordering (token0 must have smaller bytes than token1)
 */
export function sortMints(mintA, mintB) {
  const bufA = mintA.toBuffer()
  const bufB = mintB.toBuffer()
  const cmp = Buffer.compare(bufA, bufB)
  if (cmp === 0) throw new Error('Token mints must be different')
  return cmp < 0 ? { token0: mintA, token1: mintB, inverted: false } : { token0: mintB, token1: mintA, inverted: true }
}

/**
 * Derive all Raydium CPMM PDAs
 */
export function getCpmmPdaAddresses(programId, ammConfig, token0Mint, token1Mint) {
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from(AUTH_SEED)], programId)

  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from(POOL_SEED), ammConfig.toBuffer(), token0Mint.toBuffer(), token1Mint.toBuffer()],
    programId
  )

  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(POOL_LP_MINT_SEED), poolState.toBuffer()],
    programId
  )

  const [token0Vault] = PublicKey.findProgramAddressSync(
    [Buffer.from(POOL_VAULT_SEED), poolState.toBuffer(), token0Mint.toBuffer()],
    programId
  )

  const [token1Vault] = PublicKey.findProgramAddressSync(
    [Buffer.from(POOL_VAULT_SEED), poolState.toBuffer(), token1Mint.toBuffer()],
    programId
  )

  const [observationState] = PublicKey.findProgramAddressSync(
    [Buffer.from(OBSERVATION_SEED), poolState.toBuffer()],
    programId
  )

  return {
    authority,
    poolState,
    lpMint,
    token0Vault,
    token1Vault,
    observationState,
  }
}

/**
 * Build the complete Raydium CP-MM Pool creation transaction
 */
export async function buildCreateRaydiumPoolTx({
  connection,
  creator,
  tokenMint,
  tokenProgram = TOKEN_PROGRAM_ID,
  tokenAmountRaw,
  solAmountLamports,
  network = 'devnet',
  configId = null,
}) {
  const isMainnet = network === 'mainnet'
  const programId = isMainnet ? RAYDIUM_CPMM_PROGRAM_ID.mainnet : RAYDIUM_CPMM_PROGRAM_ID.devnet
  const feeReceiver = isMainnet ? RAYDIUM_POOL_FEE_RECEIVER.mainnet : RAYDIUM_POOL_FEE_RECEIVER.devnet
  const ammConfig = configId || (isMainnet ? RAYDIUM_DEFAULT_CONFIG.mainnet.id : RAYDIUM_DEFAULT_CONFIG.devnet.id)

  const wsolMint = NATIVE_MINT
  const { token0, token1, inverted } = sortMints(tokenMint, wsolMint)

  const amount0 = inverted ? BigInt(solAmountLamports) : BigInt(tokenAmountRaw)
  const amount1 = inverted ? BigInt(tokenAmountRaw) : BigInt(solAmountLamports)
  const token0Program = inverted ? TOKEN_PROGRAM_ID : tokenProgram
  const token1Program = inverted ? tokenProgram : TOKEN_PROGRAM_ID

  const pdas = getCpmmPdaAddresses(programId, ammConfig, token0, token1)

  // ATAs
  const creatorToken0Ata = getAssociatedTokenAddressSync(token0, creator, false, token0Program)
  const creatorToken1Ata = getAssociatedTokenAddressSync(token1, creator, false, token1Program)
  const creatorLpAta = getAssociatedTokenAddressSync(pdas.lpMint, creator, false, TOKEN_PROGRAM_ID)
  const creatorWsolAta = inverted ? creatorToken0Ata : creatorToken1Ata

  const tx = new Transaction()

  // 1. Wrap SOL into WSOL ATA for creator
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      creator,
      creatorWsolAta,
      creator,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    )
  )
  tx.add(
    SystemProgram.transfer({
      fromPubkey: creator,
      toPubkey: creatorWsolAta,
      lamports: BigInt(solAmountLamports),
    })
  )
  tx.add(createSyncNativeInstruction(creatorWsolAta, TOKEN_PROGRAM_ID))

  // 2. Encode instruction data: discriminator (8B) + init_amount_0 (8B) + init_amount_1 (8B) + open_time (8B)
  const data = Buffer.alloc(8 + 8 + 8 + 8)
  INITIALIZE_DISCRIMINATOR.copy(data, 0)
  data.writeBigUInt64LE(amount0, 8)
  data.writeBigUInt64LE(amount1, 16)
  data.writeBigUInt64LE(0n, 24) // 0 open_time = immediate open

  // 3. Accounts for Raydium CP-MM initialize
  const keys = [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: ammConfig, isSigner: false, isWritable: false },
    { pubkey: pdas.authority, isSigner: false, isWritable: false },
    { pubkey: pdas.poolState, isSigner: false, isWritable: true },
    { pubkey: token0, isSigner: false, isWritable: false },
    { pubkey: token1, isSigner: false, isWritable: false },
    { pubkey: pdas.lpMint, isSigner: false, isWritable: true },
    { pubkey: creatorToken0Ata, isSigner: false, isWritable: true },
    { pubkey: creatorToken1Ata, isSigner: false, isWritable: true },
    { pubkey: creatorLpAta, isSigner: false, isWritable: true },
    { pubkey: pdas.token0Vault, isSigner: false, isWritable: true },
    { pubkey: pdas.token1Vault, isSigner: false, isWritable: true },
    { pubkey: feeReceiver, isSigner: false, isWritable: true },
    { pubkey: pdas.observationState, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: token0Program, isSigner: false, isWritable: false },
    { pubkey: token1Program, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
  ]

  tx.add(
    new TransactionInstruction({
      programId,
      keys,
      data,
    })
  )

  tx.feePayer = creator
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash

  return {
    tx,
    poolState: pdas.poolState.toBase58(),
    lpMint: pdas.lpMint.toBase58(),
    token0: token0.toBase58(),
    token1: token1.toBase58(),
  }
}
