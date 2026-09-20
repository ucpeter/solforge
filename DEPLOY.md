# Deploying SolForge

SolForge is a **pure static SPA** (Vite + React). There is no backend, no
database, and no server-side secret: the connected wallet signs in the
browser and the app talks directly to the Solana RPC. Every deployment
target below is just *build the static site and serve it over HTTPS*.

```
npm ci && npm run build     # → dist/   (this is everything a host needs)
```

## 1. Render (cloud hosting)

### Option A — Blueprint (one click, recommended)

This repo contains a `render.yaml` (a Render Blueprint):

1. Push the project to a GitHub repository.
2. render.com → **New → Blueprint** → select the repository → deploy.
3. You get `https://solforge.onrender.com` with automatic HTTPS.

The blueprint configures:

| Setting | Value |
|---|---|
| Type | `static` |
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |

No SPA rewrites are needed: the app uses state-based navigation (no URL
routes), so plain static hosting works.

### Option B — manual Static Site

New → **Static Site** → Build command `npm ci && npm run build` →
Publish directory `dist`.

### Environment (Render → service → Environment tab)

| Variable | Purpose | Default when unset |
|---|---|---|
| `VITE_DEVNET_RPC` | Default RPC for the Devnet cluster | `https://api.devnet.solana.com` |
| `VITE_MAINNET_RPC` | Default RPC for the Mainnet cluster | `https://api.mainnet-beta.solana.com` |

The values are inlined into the client bundle at build time (they are public
infrastructure, not secrets). **For mainnet-facing deployments, set
`VITE_MAINNET_RPC` to a real RPC** (e.g. `https://mainnet.helius-rpc.com/?api-key=...`
— the public mainnet RPC rate-limits browser clients aggressively).
Individual users can still override per browser at runtime in
Settings → RPC (stored in `localStorage`, wins over the build default).

Notes:

- Nothing else to configure: there is no server state. Each user's token
  registry, pool registry, RPC/Pinata/priority-fee settings live in their
  own browser.
- The free static tier is fine for personal/small-scale use.

## 2. Local computer

Requires **Node.js ≥ 20** (project developed and tested on 20.20.2).

### Development (hot reload)

```sh
cd solforge
npm install
npm run dev        # → http://localhost:5173
```

### Production build, served locally

```sh
npm run build
npm run preview    # → http://localhost:4173  (serves dist/)
```

…or any static file server:

```sh
npx serve dist
python3 -m http.server 8080 -d dist
```

### Baking an RPC default into a local build

```sh
VITE_MAINNET_RPC="https://mainnet.helius-rpc.com/?api-key=..." npm run build
# PowerShell:  $env:VITE_MAINNET_RPC="..."; npm run build
```

### Tests

```sh
npm test           # 14 tests
```

- 6 trust-core tests run fully offline.
- 8 app-render tests need a local validator. Launch command (from the
  README):

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

## 3. Android

### How wallet access works (read this first)

SolForge connects to the wallet through the **browser provider the wallet
app injects** (`window.phantom`, `window.solflare`, `window.backpack`,
`window.solana`). Phantom, Solflare and Backpack on Android are wallet
*plus browser* apps: pages opened **inside** them get the injection, so
Connect and signing work there. A plain system WebView (including a
Capacitor APK) receives no injection — that is why the recommended route is
A.

### Route A — wallet browser + home screen (recommended, zero native code)

1. Deploy to Render (or any HTTPS host) — see section 1.
2. On the phone, install **Phantom** from the Play Store (Solflare and
   Backpack also work).
3. Open the app's URL **inside Phantom** — paste it into Phantom's address
   bar, or use *Share → Phantom* from any browser.
4. In Phantom's menu (⋮) choose **Add to Home screen**.
5. The project ships a web app manifest (`public/manifest.webmanifest`)
   with 192/512/maskable icons, so it installs with its own icon and
   launches in standalone mode like a native app.
6. Every redeploy is picked up automatically — the home-screen icon always
   opens the latest build.

### Route B — branded APK (Capacitor)

For a store-style branded app. Requires Android Studio + Android SDK on a
build machine. The project already contains `capacitor.config.json`:

```json
{
  "appId": "app.solforge.web",
  "appName": "SolForge",
  "webDir": "dist",
  "backgroundColor": "#0b1220"
}
```

Build steps:

```sh
cd solforge
npm i @capacitor/core @capacitor/android
npm i -D @capacitor/cli
npm run build
npx cap add android
npx cap sync android
npx cap open android
```

Then in Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**
and install the APK on the device.

**Caveat (deliberate):** signing *inside* the APK would require a
mobile-wallet transport (WalletConnect relay or a wallet deep-link
integration). This build intentionally includes no third-party wallet SDK —
the trust model is "nothing between you and your keys." Use the APK for
branding/launcher convenience and do actual signing on the phone via
Route A. (WalletConnect v2 is end-to-end encrypted, but it does introduce a
relay; if you want it added, it will be documented prominently in the
wallet-connect UI and in the trust notes.)

## Quick reference

| Target | What runs where | Config surface |
|---|---|---|
| Render | Static `dist/` on Render's edge | `render.yaml` + `VITE_DEVNET_RPC` / `VITE_MAINNET_RPC` env |
| Local computer | `vite dev` (5173) or `vite preview` (4173) | `npm` scripts; same `VITE_*` env vars; Settings page |
| Android | Render URL inside Phantom/Solflare/Backpack; optional Capacitor APK | Wallet app browser; `capacitor.config.json` |
