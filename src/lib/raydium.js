/**
 * Raydium CP-MM (Constant Product Market Maker) on-chain client.
 * Supports:
 * - Pool initialization
 * - Reading pool state and LP token balances
 * - Liquidity withdrawal / position closing
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
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

// Anchor instruction discriminators
// sha256("global:initialize")[0..8]
export const INITIALIZE_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237])
// sha256("global:withdraw")[0..8]
export const WITHDRAW_DISCRIMINATOR = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34])

export function sortMints(mintA, mintB) {
  const bufA = mintA.toBuffer()
  const bufB = mintB.toBuffer()
  const cmp = Buffer.compare(bufA, bufB)
  if (cmp === 0) throw new Error('Token mints must be different')
  return cmp < 0 ? { token0: mintA, token1: mintB, inverted: false } : { token0: mintB, token1: mintA, inverted: true }
}

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
 * Build Raydium CP-MM Pool creation transaction
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

  const creatorToken0Ata = getAssociatedTokenAddressSync(token0, creator, false, token0Program)
  const creatorToken1Ata = getAssociatedTokenAddressSync(token1, creator, false, token1Program)
  const creatorLpAta = getAssociatedTokenAddressSync(pdas.lpMint, creator, false, TOKEN_PROGRAM_ID)
  const creatorWsolAta = inverted ? creatorToken0Ata : creatorToken1Ata

  const tx = new Transaction()

  // Wrap SOL into WSOL ATA
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

  // Instruction data
  const data = Buffer.alloc(8 + 8 + 8 + 8)
  INITIALIZE_DISCRIMINATOR.copy(data, 0)
  data.writeBigUInt64LE(amount0, 8)
  data.writeBigUInt64LE(amount1, 16)
  data.writeBigUInt64LE(0n, 24)

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

  tx.add(new TransactionInstruction({ programId, keys, data }))

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

/**
 * Decode Raydium CP-MM Pool State Account on-chain
 */
export function decodeRaydiumPoolState(data) {
  if (!data || data.length < 236) return null
  const buf = Buffer.from(data)
  return {
    ammConfig: new PublicKey(buf.subarray(8, 40)),
    poolCreator: new PublicKey(buf.subarray(40, 72)),
    token0Vault: new PublicKey(buf.subarray(72, 104)),
    token1Vault: new PublicKey(buf.subarray(104, 136)),
    lpMint: new PublicKey(buf.subarray(136, 168)),
    token0Mint: new PublicKey(buf.subarray(168, 200)),
    token1Mint: new PublicKey(buf.subarray(200, 232)),
    token0Program: new PublicKey(buf.subarray(232, 264)),
    token1Program: new PublicKey(buf.subarray(264, 296)),
    observationKey: new PublicKey(buf.subarray(296, 328)),
    authBump: buf[328],
    status: buf[329],
    lpMintDecimals: buf[330],
    mint0Decimals: buf[331],
    mint1Decimals: buf[332],
    lpSupply: buf.readBigUInt64LE(333),
  }
}

/**
 * Read Raydium pool details & vault balances
 */
export async function readRaydiumPoolDetails(connection, poolAddress, walletPublicKey = null) {
  const poolKey = new PublicKey(poolAddress)
  const acc = await connection.getAccountInfo(poolKey)
  if (!acc) return null

  const decoded = decodeRaydiumPoolState(acc.data)
  if (!decoded) return null

  // Fetch token vault balances
  const [b0, b1] = await Promise.all([
    connection.getTokenAccountBalance(decoded.token0Vault).catch(() => null),
    connection.getTokenAccountBalance(decoded.token1Vault).catch(() => null),
  ])

  let userLpBalance = 0n
  let userLpUi = 0
  if (walletPublicKey) {
    try {
      const ata = getAssociatedTokenAddressSync(decoded.lpMint, walletPublicKey, false, TOKEN_PROGRAM_ID)
      const res = await connection.getTokenAccountBalance(ata)
      userLpBalance = BigInt(res.value.amount || '0')
      userLpUi = res.value.uiAmount || 0
    } catch {
      // User has no ATA or 0 balance
    }
  }

  return {
    poolAddress,
    decoded,
    vault0Amount: b0 ? BigInt(b0.value.amount) : 0n,
    vault1Amount: b1 ? BigInt(b1.value.amount) : 0n,
    vault0Ui: b0 ? b0.value.uiAmount : 0,
    vault1Ui: b1 ? b1.value.uiAmount : 0,
    userLpBalance,
    userLpUi,
  }
}

/**
 * Build Raydium CP-MM Liquidity Withdrawal Transaction
 */
export async function buildWithdrawRaydiumTx({
  connection,
  owner,
  poolAddress,
  lpAmount,
  network = 'devnet',
}) {
  const isMainnet = network === 'mainnet'
  const programId = isMainnet ? RAYDIUM_CPMM_PROGRAM_ID.mainnet : RAYDIUM_CPMM_PROGRAM_ID.devnet

  const poolKey = new PublicKey(poolAddress)
  const acc = await connection.getAccountInfo(poolKey)
  if (!acc) throw new Error('Pool account not found')

  const state = decodeRaydiumPoolState(acc.data)
  if (!state) throw new Error('Invalid Raydium pool data')

  const [authority] = PublicKey.findProgramAddressSync([Buffer.from(AUTH_SEED)], programId)

  const ownerLpToken = getAssociatedTokenAddressSync(state.lpMint, owner, false, TOKEN_PROGRAM_ID)
  const token0Account = getAssociatedTokenAddressSync(state.token0Mint, owner, false, state.token0Program)
  const token1Account = getAssociatedTokenAddressSync(state.token1Mint, owner, false, state.token1Program)

  const tx = new Transaction()

  // Ensure recipient token accounts exist
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      token0Account,
      owner,
      state.token0Mint,
      state.token0Program
    )
  )
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      token1Account,
      owner,
      state.token1Mint,
      state.token1Program
    )
  )

  // Instruction data: discriminator (8B) + lp_token_amount (8B) + min_0 (8B) + min_1 (8B)
  const data = Buffer.alloc(8 + 8 + 8 + 8)
  WITHDRAW_DISCRIMINATOR.copy(data, 0)
  data.writeBigUInt64LE(BigInt(lpAmount), 8)
  data.writeBigUInt64LE(0n, 16) // 0 min = 100% accepted
  data.writeBigUInt64LE(0n, 24)

  const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: poolKey, isSigner: false, isWritable: true },
    { pubkey: ownerLpToken, isSigner: false, isWritable: true },
    { pubkey: token0Account, isSigner: false, isWritable: true },
    { pubkey: token1Account, isSigner: false, isWritable: true },
    { pubkey: state.token0Vault, isSigner: false, isWritable: true },
    { pubkey: state.token1Vault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: state.token0Mint, isSigner: false, isWritable: false },
    { pubkey: state.token1Mint, isSigner: false, isWritable: false },
    { pubkey: state.lpMint, isSigner: false, isWritable: true },
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
  ]

  tx.add(new TransactionInstruction({ programId, keys, data }))

  // If one of the tokens is WSOL, unwrap it into native SOL automatically
  const is0Wsol = state.token0Mint.equals(NATIVE_MINT)
  const is1Wsol = state.token1Mint.equals(NATIVE_MINT)
  if (is0Wsol) {
    tx.add(createCloseAccountInstruction(token0Account, owner, owner, [], TOKEN_PROGRAM_ID))
  } else if (is1Wsol) {
    tx.add(createCloseAccountInstruction(token1Account, owner, owner, [], TOKEN_PROGRAM_ID))
  }

  tx.feePayer = owner
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash

  return { tx }
}
