# Deploying VoltSnipe

This covers everything needed to take this from a local checkout to a live,
publicly reachable instance — database, environment variables, and the
platform-specific steps for both Vercel and Render.

## 1. Requirements

- Node.js 20+ (built and tested against Node 22)
- A Postgres database (any provider — Neon, Supabase, Render Postgres, or
  your own)
- A Solana RPC endpoint (optional but strongly recommended — see below)

## 2. Environment variables

| Variable | Required? | What it does |
|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection string. The app throws on startup without it. |
| `SOLANA_RPC_URL` | No | Your RPC provider's URL (Helius, QuickNode, Alchemy, etc.). Falls back to the public `https://api.mainnet-beta.solana.com`, which is heavily rate-limited — fine for a quick look, not for live trading. |
| `SOLANA_RPC_URL_FALLBACK` | No | A second RPC URL, tried automatically if the primary times out or errors. Every read (balances, blockhash, confirmations) and the default send channel go through this chain: primary → this fallback (if set) → the public RPC as a last resort. |
| `HELIUS_SENDER_ENABLED` | No | Set to `true` to route buy/sell submissions through Helius's Sender endpoint (adds a ~0.001 SOL Jito tip per transaction). No API key needed for Sender itself. |
| `QUICKNODE_FASTLANE_URL` | No | Your QuickNode endpoint URL, once you've installed the Transaction Fastlane add-on on it. Only takes effect if set. |
| `QUICKNODE_FASTLANE_TIP_ADDRESS` | Only if the above is set | The tip address QuickNode's dashboard shows you after installing Fastlane. This isn't something to guess — pull it from your own dashboard. |

Leaving every optional variable unset gives you a fully working app on the
public RPC with no fast-lane submission — a safe default for first testing.

`HELIUS_SENDER_ENABLED` and `QUICKNODE_FASTLANE_URL` can both be set at once;
each enabled channel is tried in parallel and whichever lands first wins,
but each also adds its own ~0.001 SOL tip to every transaction regardless of
which one actually lands — see the note in `src/lib/fastSend.ts` before
turning both on.

## 3. Database setup

Works the same regardless of where you host the app.

1. Provision a Postgres database and copy its connection string.
2. Push the schema (creates all four tables — `bot_configs`, `positions`,
   `trades`, `blacklisted_devs`):

   ```bash
   npx drizzle-kit push --dialect=postgresql --schema=./src/db/schema.ts --url="<your DATABASE_URL>"
   ```

Run this once against any new database, and again any time `src/db/schema.ts`
changes.

## 4. Deploy to Vercel

1. Push this repo to GitHub.
2. Import it as a new Vercel project.
3. In Project Settings → Environment Variables, add the variables from
   section 2.
4. Deploy. Vercel picks the build/start commands up automatically from
   `package.json`.
5. New environment variables only apply to the *next* deploy — redeploy
   after adding any.

## 5. Deploy to Render

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Web Service** (not Static Site — this
   app has server-side API routes and needs the Node runtime).
3. Connect the repo, then set:
   - **Language:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
4. In the service's Environment tab, add the variables from section 2, plus
   `NODE_VERSION=22` (this project doesn't pin a Node version itself).
5. Create the service — Render builds and deploys automatically, giving you
   a `*.onrender.com` URL.

**Free-tier note:** Render's free web services spin down after a period of
inactivity and wake on the next request. That's fine for most apps, but a
bot that needs to stay connected to a live token feed and react instantly
will miss snipes while asleep — use a paid tier for anything beyond testing.

## 6. Local development

```bash
npm install
# create .env.local with at least DATABASE_URL
npx drizzle-kit push --dialect=postgresql --schema=./src/db/schema.ts --url="<your DATABASE_URL>"
npm run dev
```

Then open `http://localhost:3000/terminal`.

## 7. Multi-wallet trading

No extra deployment steps are needed for running multiple wallets
concurrently — configuration is already stored per wallet address in
`bot_configs`, so unlocking additional wallets in the UI is all that's
required. Each one loads and saves its own settings independently.
