# SolForge

Solana token creator & liquidity manager. Built in the browser, signed by your
wallet, and — the whole point — it only does what it says it does.

This is a rebuild of tokenclub.fun's tooling. Every feature the original
advertised was checked against its actual code; what disagreed was either fixed
correctly or removed. See **What was wrong, and what this does differently**
below.

## Features

**Token Creator**
- Two genuinely different standards, both implemented and both labelled
  honestly:
  - **SPL Token (legacy)** + Metaplex Token Metadata — the standard every
    wallet, explorer and DEX supports.
  - **Token-2022** with a real `MetadataPointer` + native `TokenMetadata`
    extension — metadata stored inside the mint, no Metaplex PDA.
- One transaction: mint, metadata, your token account, full supply minted,
  and (optionally) mint/freeze authority revoked in the same call.
- Your metadata, your IPFS: upload an image + description + socials to
  **your own Pinata account** from this browser (your JWT never leaves
  localStorage), or paste any metadata URI — it is fetched and validated here
  before you can sign.
- Live cost breakdown computed from the cluster: rent (all recoverable),
  signature fees, any priority fee you chose. **Platform fee: 0 SOL**, and a
  transaction-level check enforces that nothing else can change.

**Liquidity (Meteora DAMM v2 / CP-AMM)**
- Create a pool for your token against wrapped SOL, with a transparent config
  picker (each static config's fee schedule is decoded and shown: base-fee
  mode + starting fee, dynamic fee on/off, protocol & referral share,
  activation type).
- Position management with a **withdrawal percentage slider** (like the
  original tool's Remove tab): withdraw any 1–100% of the *unlocked*
  liquidity, keep the position open to keep earning fees, or close it at 100%
  to burn the position NFT and recover its rent. Removed liquidity always
  lands in **your own token accounts**, and SOL comes back **unwrapped** in
  the same transaction. Plus: **permanent lock** (with the Compounding-mode
  `DEAD_LIQUIDITY` subtlety handled exactly as the program requires),
  time-based vesting locks, add liquidity, claim fees.
- Real position list for your wallet on the selected cluster.

**Trust core (every transaction, before your wallet ever sees it)**
1. Instructions are decoded into plain English.
2. Every lamport that moves is listed and classified. Any SOL leaving to an
   address you do not own (or a new account not created for you / a known
   program deposit) **blocks the transaction locally**.
3. The transaction is simulated and the real compute units are shown.
4. Only then can you confirm.

## Honesty policy

- **Zero platform fee.** There is no fee wallet and no transfer to one; the
  review step verifies each transaction against that fact.
- **Devnet by default.** Switching to mainnet requires an explicit
  confirmation, because that is when the SOL becomes real.
- **No analytics, no trackers, no ad pixels.** The only network calls are the
  Solana RPC you chose, `api.pinata.cloud` (with your key, only when you
  upload), and a metadata URI you paste.
- **No volume engine / wash-trading.** Automated trading against your own
  token is market manipulation; it is deliberately not here.
- **No vanity addresses, open-book listings, or fake ratings** — those were
  advertised on the original site and never existed.
- **Local data only, visible and clearable.** Everything the app stores is in
  `localStorage`, listed in Settings with a one-click wipe.

## What was wrong, and what this does differently

| Original claim / behaviour | Reality | Here |
| --- | --- | --- |
| "Token-2022" label | Legacy SPL mint under a Token-2022 label | Real Token-2022 mint with `MetadataPointer` + native metadata, or an honest "SPL (legacy)" label |
| "0.1 SOL" advertised, 0.11 charged | A hidden surcharge on top of the advertised price | Zero fee; exact rent + signature + priority costs shown live |
| "1% swap fee" shown, 1.1% charged | Fee inflation | No swaps at all in this tool; pool fee terms are read from the config and shown before you commit |
| Vanity / OpenBook / Multisender / Snapshots | Not present in the code (or fake) | Removed |
| TrustPilot rating, gas/TPS claims | Fake terminal, fabricated numbers | Removed |
| "Last updated" visitor-date stamping | Marketing fakery | Real, hardcoded doc date |
| Hidden `Ctrl+Shift+C` to clear data | Invisible state | Visible **Clear all local data** in Settings |
| Analytics / ad pixels | Present | Removed |
| Volume Engine (wash trading) | Present | **Refused** — not rebuilt, on principle |

## Deployment

Full guide: **`DEPLOY.md`** (Render cloud hosting, local computer, Android).
Short version: it's a pure static SPA — `npm ci && npm run build` → serve
`dist/` over HTTPS. `render.yaml` is a one-click Render Blueprint;
`VITE_DEVNET_RPC` / `VITE_MAINNET_RPC` build env vars set the default RPCs;
the Android path is wallet-app browser + PWA home screen install
(`public/manifest.webmanifest`), with an optional Capacitor APK
(`capacitor.config.json`).

## Development

```sh
npm install
npm run dev        # Vite dev server (http://localhost:5173)
npm test           # vitest: render smoke tests + trust-core unit tests
npm run build      # production build
```

`npm test`'s app tests expect a **local test validator** at
`http://127.0.0.1:8899` (they point there via a stored custom-RPC setting).
Bring one up with the programs this tool uses cloned from mainnet:

```sh
solana-test-validator --ledger /tmp/test-ledger --reset --rpc-port 8899 \
  --mint 8Neqs9om3Tkn4BxoC137yC2Nk6ZTuw3pQjocSWP5o2Yd \
  --url https://api.mainnet-beta.solana.com \
  --clone cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH \
  --clone metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone PwDiXFxQsGra4sFFTT8r1QWRMd4vfumiWC1jfWNfdYT \
  --clone 6sWazXVC4Wkuz9CqsDEtsznZ4ZV6g5asxb4UsX9KdWJ
```

(The two non-obvious clones are each program's *programdata* account — without
them the program is an empty stub. `6sWaz…` is a real static pool config so
pool-creation paths can be exercised. The ATA program is builtin and needs no
clone.)

### On-chain integration probe

`scripts/devnet-probe.mjs` runs the *actual library code* end-to-end against
any cluster: create legacy token, create Token-2022 token, verify metadata on
chain, list configs, create a pool, permanently lock, claim fees.

```sh
RPC_URL=http://127.0.0.1:8899 node scripts/devnet-probe.mjs
```

`scripts/trust-test.mjs` goes further: it builds a pool-creation transaction
with a SOL wrap, runs it through the exact review pipeline (finalize →
simulate with post-states → inspect → assert-no-hidden-SOL), and sends it.

### Architecture

```
src/
  lib/
    config.js       brand, networks, fee policy, storage keys, limits
    programs.js     every program id, imported from SDKs (no retyping)
    format.js       byte-exact helpers (no float drift), formatting
    registry.js     localStorage: settings, token/pool registries
    network.jsx     cluster + custom RPC provider, live stats
    wallet.jsx      Phantom/Solflare/Backpack/… provider, balance
    tokenCreator.js instruction builders + honest cost model
    liquidity.js    DAMM v2 plan builders + reads (see file-header facts list)
    ipfs.js         Pinata upload (your key), metadata doc, URI validation
    txkit.js        instruction decoder, SOL-movement classifier,
                    simulate/finalize/send — the trust core
  components/
    ui.jsx          presentational primitives
    TxReview.jsx    the pre-signature review panel
  pages/
    Create.jsx      token creation
    Liquidity.jsx   pools + positions
    Settings.jsx    RPC, Pinata key, defaults, local data
    About.jsx       the honest page
```

### Verified facts worth knowing

- Meteora's convention: `tokenA` is the **larger** mint key (verified against
  live pools). The pool PDA is canonical either way; the stored A/B labels
  follow your order and decide which way the price reads. `liquidity.js`
  canonicalises and tells you which side your token ended up on.
- `CpAmm`'s `.transaction()` sets **no fee payer and no blockhash** — the
  review pipeline supplies both.
- SDK `permanentLockPosition({ unlockedLiquidity })`: the value is the amount
  to **lock** (misleading name); for Compounding pools the program requires
  keeping `DEAD_LIQUIDITY` (100·2⁶⁴) withdrawable.
- `getMaxAmountWithSlippage(amount, rate)` takes rate in **percent**.
- web3.js v1 throws the opaque "Invalid arguments" when a legacy `Transaction`
  is simulated with a config object — hence the versioned wrapper in txkit.
- `CreateMetadataAccountArgsV3` is exactly `{data, isMutable,
  collectionDetails}`; the `token_standard` append some launchpads do is
  rejected by the current program (`InvalidInstructionData`).

Documentation status: current as of 2026-09-19.
