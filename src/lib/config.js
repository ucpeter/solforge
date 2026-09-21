/**
 * Central configuration.
 *
 * Everything the app charges, talks to, or persists is declared here on purpose:
 * one file to audit, no secrets scattered through the bundle.
 */

export const BRAND = {
  name: 'SolForge',
  tagline: 'Solana token creator & liquidity manager',
}

/**
 * PLATFORM FEE POLICY — this is the whole point of the rebuild.
 *
 * There is no fee wallet, no skim, no percentage. The app never constructs a
 * transfer to anyone but the user themselves. `assertNoPlatformFee()` in
 * txkit.js re-verifies this against the built transaction before signing, so a
 * future edit that quietly reintroduces a recipient will fail loudly.
 */
export const FEE_POLICY = Object.freeze({
  platformFeeLamports: 0,
  platformFeeBps: 0,
  feeRecipient: null,
  statement:
    'SolForge takes no platform fee. You pay only Solana network costs: rent for the accounts you create, the base signature fee, and any priority fee you choose yourself.',
})

/**
 * Build-time RPC overrides (optional).
 *
 * At deploy time (e.g. Render → Environment) you can set:
 *   VITE_DEVNET_RPC   — default RPC for the Devnet cluster
 *   VITE_MAINNET_RPC  — default RPC for the Mainnet cluster
 *
 * Unset/empty = the public Solana RPCs below. Any user can still override
 * per-browser at runtime in Settings → RPC (that choice wins; stored in
 * localStorage). These values are inlined into the client bundle at build
 * time — an RPC endpoint is public infrastructure, there is no secret here.
 */
const BUILD_ENV = import.meta.env ?? {}

export const NETWORKS = {
  devnet: {
    id: 'devnet',
    label: 'Devnet',
    shortLabel: 'Devnet',
    cluster: 'devnet',
    defaultRpc: BUILD_ENV.VITE_DEVNET_RPC || 'https://api.devnet.solana.com',
    explorerTx: (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    explorerAddress: (addr) => `https://explorer.solana.com/address/${addr}?cluster=devnet`,
    faucet: 'https://faucet.solana.com/?cluster=devnet',
    realMoney: false,
  },
  'mainnet-beta': {
    id: 'mainnet-beta',
    label: 'Mainnet',
    shortLabel: 'Mainnet',
    cluster: 'mainnet-beta',
    defaultRpc: BUILD_ENV.VITE_MAINNET_RPC || 'https://api.mainnet-beta.solana.com',
    explorerTx: (sig) => `https://explorer.solana.com/tx/${sig}`,
    explorerAddress: (addr) => `https://explorer.solana.com/address/${addr}`,
    faucet: null,
    realMoney: true,
  },
}

/** Deliberate, safe-by-default: first launch is devnet, mainnet needs a confirm. */
export const DEFAULT_NETWORK = 'devnet'

/** Well-known Solana program addresses. Imported as constants, never retyped. */
export const PROGRAMS = {
  // Populated in lib/programs.js from @solana/spl-token to avoid transcription risk.
}

export const STORAGE_KEYS = {
  network: 'solforge.network',
  settings: 'solforge.settings',
  tokens: 'solforge.tokens',
  pools: 'solforge.pools',
  acknowledgedMainnet: 'solforge.mainnet-ack',
  rpcFallback: 'solforge.rpc-fallback',
}

/** Every key the app may write, surfaced verbatim in Settings → Local data. */
export const STORAGE_DESCRIPTIONS = {
  [STORAGE_KEYS.network]: 'Which cluster you last selected.',
  [STORAGE_KEYS.settings]:
    'Your RPC endpoint, Pinata API key, priority-fee preference and metadata defaults. Never leaves this browser.',
  [STORAGE_KEYS.tokens]: 'Registry of tokens you created here (mint, symbol, decimals, program).',
  [STORAGE_KEYS.pools]: 'Registry of pools you created here (pool, position, pair).',
  [STORAGE_KEYS.acknowledgedMainnet]: 'Whether you dismissed the mainnet risk notice.',
  [STORAGE_KEYS.rpcFallback]:
    'Which public fallback RPC the app auto-selected per cluster (only used when no custom RPC is set).',
}

export const DEFAULT_SETTINGS = Object.freeze({
  /** Empty = use the cluster's public RPC. Bring your own (e.g. Helius) for better rate limits. */
  customRpc: '',
  /** Pinata JWT, used only from this browser, directly to api.pinata.cloud. */
  pinataJwt: '',
  /** microlamports per compute unit. 0 = no priority fee instruction at all. */
  priorityFeeMicroLamports: 0,
  /** Default token standard for new tokens. */
  tokenProgram: 'spl',
  defaultDecimals: 9,
  defaultSupply: '1000000000',
  /** Slippage tolerance for liquidity math, in basis points. */
  slippageBps: 50,
})

export const LIMITS = Object.freeze({
  tokenNameBytes: 32,
  tokenSymbolBytes: 10,
  metadataUriBytes: 200,
  decimalsMin: 0,
  decimalsMax: 9,
  maxComputeUnits: 1_400_000,
})

export const DOCS_DATE = '2026-09-19'
