/**
 * Program addresses — re-exported from the official SDKs rather than typed by
 * hand, so there is no chance of a transposed character.
 */
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token'
import { SystemProgram, ComputeBudgetProgram } from '@solana/web3.js'
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'

/** Metaplex Token Metadata (used for SPL-Token mints). */
export const METAPLEX_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

/**
 * The account that receives metadata-update authority when it is renounced.
 * The 1111…1 system program address is off-curve, so nobody can ever sign for it.
 */
export const RENOUNCED_UPDATE_AUTHORITY = '11111111111111111111111111111111'

export const PROGRAM = {
  splToken: TOKEN_PROGRAM_ID,
  token2022: TOKEN_2022_PROGRAM_ID,
  associatedToken: ASSOCIATED_TOKEN_PROGRAM_ID,
  system: SystemProgram.programId,
  computeBudget: ComputeBudgetProgram.programId,
  wsolMint: NATIVE_MINT,
  cpAmm: CP_AMM_PROGRAM_ID,
  metaplexMetadata: METAPLEX_METADATA_PROGRAM_ID,
}

export const TOKEN_PROGRAM_CHOICES = [
  {
    id: 'spl',
    programId: TOKEN_PROGRAM_ID,
    label: 'SPL Token (legacy)',
    note: 'The standard every wallet, explorer and DEX supports unconditionally. Metadata via Metaplex.',
  },
  {
    id: 'token2022',
    programId: TOKEN_2022_PROGRAM_ID,
    label: 'Token-2022',
    note: 'Supports extensions (transfer fees, metadata pointer, hooks). Some older tools still handle it poorly.',
  },
]

export function tokenProgramById(id) {
  return TOKEN_PROGRAM_CHOICES.find((c) => c.id === id) ?? TOKEN_PROGRAM_CHOICES[0]
}
