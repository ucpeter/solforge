/**
 * links.js — every external link SolForge opens, in one auditable place.
 *
 * Nothing here is an affiliate, referral or tracking link. These are the plain
 * public URLs of each platform, built from the mint / pool / signature.
 *
 * ---------------------------------------------------------------------------
 * HONEST CLUSTER NOTE (this matters, and it is not a bug)
 * ---------------------------------------------------------------------------
 * Solana Explorer and Solscan understand `?cluster=devnet`, so transaction and
 * address links work on BOTH clusters and are the only links that always work.
 *
 * Photon, DexScreener, Birdeye, GeckoTerminal, DEXTools, Jupiter and RugCheck
 * index MAINNET ONLY. A devnet token simply does not exist in their databases,
 * so those pages will open but come back empty. We still render the buttons on
 * devnet — the user asked for them and they are one click away once the token
 * goes live on mainnet — but we flag them, because a blank page is baffling
 * when you don't know why it is blank.
 */

/** Shown under the platform buttons whenever the wallet is not on mainnet. */
export const MAINNET_ONLY_NOTE =
  'Charting, tracking and trading platforms index mainnet only. On devnet these pages open, but your token will not be listed there yet.'

/** True when the active cluster is mainnet-beta. */
export function isMainnetCluster(network) {
  return network?.id === 'mainnet-beta'
}

/**
 * Cluster-aware explorer links. These are the "view the transaction" buttons —
 * they work on devnet and mainnet alike.
 */
export function explorerLinks(network, { signature, address, addressLabel } = {}) {
  const out = []

  if (signature) {
    out.push({
      id: 'explorer-tx',
      label: 'View transaction on Solana Explorer',
      url: network.explorerTx(signature),
      primary: true,
      mainnetOnly: false,
    })
    out.push({
      id: 'solscan-tx',
      label: 'View transaction on Solscan',
      url: solscanTxUrl(network, signature),
      primary: false,
      mainnetOnly: false,
    })
  }

  if (address) {
    out.push({
      id: 'explorer-address',
      label: addressLabel || 'View address on Solana Explorer',
      url: network.explorerAddress(address),
      primary: false,
      mainnetOnly: false,
    })
    out.push({
      id: 'solscan-address',
      label: addressLabel ? addressLabel.replace('Solana Explorer', 'Solscan') : 'View address on Solscan',
      url: solscanAddressUrl(network, address),
      primary: false,
      mainnetOnly: false,
    })
  }

  return out
}

/** Solscan handles devnet with the same `?cluster=` query param as Explorer. */
export function solscanTxUrl(network, signature) {
  const base = `https://solscan.io/tx/${signature}`
  return network?.id === 'mainnet-beta' ? base : `${base}?cluster=devnet`
}

export function solscanAddressUrl(network, address) {
  const base = `https://solscan.io/account/${address}`
  return network?.id === 'mainnet-beta' ? base : `${base}?cluster=devnet`
}

/**
 * Third-party platform buttons for a token / pool.
 *
 * `protocol` is 'meteora' or 'raydium' — it decides which DEX page we link to,
 * since a Meteora pool has no Raydium page and vice versa.
 *
 * Every entry is flagged `mainnetOnly: true`; the UI uses that to show the
 * devnet warning rather than to hide the button.
 */
export function platformLinks({ network, mint, pool, protocol } = {}) {
  if (!mint) return []

  const links = []

  // 1. The DEX the pool actually lives on — mirrors the button row in the
  //    Meteora pool UI (Photon / Meteora / DexScreener).
  if (protocol === 'raydium') {
    links.push({
      id: 'raydium',
      label: 'Raydium',
      url: `https://raydium.io/swap/?inputMint=sol&outputMint=${mint}`,
    })
  } else if (pool) {
    links.push({
      id: 'meteora',
      label: 'Meteora',
      url: `https://app.meteora.ag/dammv2/${pool}`,
    })
  }

  // 2. Trading terminal.
  links.push({
    id: 'photon',
    label: 'Photon',
    url: `https://photon-sol.tinyastro.io/solana/${mint}`,
  })

  // 3. Charting / tracking.
  links.push({
    id: 'dexscreener',
    label: 'DexScreener',
    url: `https://dexscreener.com/solana/${mint}`,
  })
  links.push({
    id: 'birdeye',
    label: 'Birdeye',
    url: `https://birdeye.so/token/${mint}?chain=solana`,
  })

  if (pool) {
    links.push({
      id: 'geckoterminal',
      label: 'GeckoTerminal',
      url: `https://www.geckoterminal.com/solana/pools/${pool}`,
    })
    links.push({
      id: 'dextools',
      label: 'DEXTools',
      url: `https://www.dextools.io/app/en/solana/pair-explorer/${pool}`,
    })
  }

  // 4. Swap + safety.
  links.push({
    id: 'jupiter',
    label: 'Jupiter',
    url: `https://jup.ag/swap/SOL-${mint}`,
  })
  links.push({
    id: 'rugcheck',
    label: 'RugCheck',
    url: `https://rugcheck.xyz/tokens/${mint}`,
  })

  return links.map((l) => ({ ...l, mainnetOnly: true }))
}

/**
 * Convenience for the success popups: one call, everything the modal needs.
 *
 * Returns { explorer, platforms, showMainnetNote }.
 */
export function buildLinks({ network, mint, pool, protocol, signature, address, addressLabel }) {
  return {
    explorer: explorerLinks(network, { signature, address, addressLabel }),
    platforms: platformLinks({ network, mint, pool, protocol }),
    showMainnetNote: !isMainnetCluster(network),
  }
}
