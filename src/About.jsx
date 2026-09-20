/**
 * About — the honest page. What this is, what it costs, what it does not do.
 */
import { BRAND, DOCS_DATE, FEE_POLICY, NETWORKS } from '../lib/config.js'
import { Card, KeyValue } from '../components/ui.jsx'
import { CP_AMM_PROGRAM_ID } from '../lib/liquidity.js'
import { PROGRAM } from '../lib/programs.js'
import { Address } from '../components/ui.jsx'

export default function About() {
  return (
    <div className="page page--narrow">
      <Card title={BRAND.name} subtitle={BRAND.tagline}>
        <p>
          {BRAND.name} creates Solana tokens and manages liquidity on Meteora's concentrated-liquidity AMM
          (DAMM v2). It is a wallet-side tool: every instruction is built in your browser, decoded into plain
          language, simulated, and only then offered to your wallet for a signature.
        </p>
        <p>
          The project is a rebuild of a tool whose marketing and its code disagreed. The version in front of you
          only does what it says it does.
        </p>
      </Card>

      <Card title="What it does not do">
        <ul className="bullets">
          <li><b>No platform fee.</b> {FEE_POLICY.statement}</li>
          <li><b>No analytics, no trackers, no ad pixels.</b> The only network calls are to the Solana RPC you chose, api.pinata.cloud (with your own key, only when you upload), and the metadata URI you paste.</li>
          <li><b>No hidden SOL transfers.</b> Before you sign, every lamport that moves is listed and classified. If any SOL would leave for an address you do not own, the transaction is blocked locally — nothing is sent.</li>
          <li><b>No wash-trading, bot, or "volume engine".</b> Automated trading against your own token is market manipulation; it is deliberately not here.</li>
          <li><b>No vanity addresses, no open-book listings, no fake ratings.</b> Those features were advertised on the original site and never existed (or were fake).</li>
        </ul>
      </Card>

      <Card title="Programs" subtitle="Everything that can run in the transactions this app builds.">
        <KeyValue
          dense
          items={[
            { label: 'SPL Token (legacy)', value: <Address value={PROGRAM.splToken.toBase58()} />, mono: true },
            { label: 'SPL Token 2022', value: <Address value={PROGRAM.token2022.toBase58()} />, mono: true },
            { label: 'Associated Token Program', value: <Address value={PROGRAM.associatedToken.toBase58()} />, mono: true },
            { label: 'Metaplex Token Metadata', value: <Address value={PROGRAM.metaplexMetadata} />, mono: true },
            { label: 'Meteora DAMM v2 (CP-AMM)', value: <Address value={CP_AMM_PROGRAM_ID.toBase58()} />, mono: true },
          ]}
        />
      </Card>

      <Card title="Networks">
        <p>
          The default is <b>Devnet</b>. Switching to mainnet asks for an explicit confirmation, because that is
          when the SOL becomes real. {NETWORKS['devnet'].label} and {NETWORKS['mainnet-beta'].label} are the only
          two options, plus a custom RPC endpoint in Settings.
        </p>
      </Card>

      <Card title="Honesty notes">
        <ul className="bullets">
          <li>
            <b>Token-2022 is real here.</b> It is actually created on the Token-2022 program with a
            MetadataPointer + native TokenMetadata extension — not a legacy mint with a Token-2022 label, which
            is what the original site did.
          </li>
          <li>
            <b>Costs are computed, not advertised.</b> Rent, signature fees and any priority fee you choose are
            read from the cluster at the moment you are about to sign. There is no "flat 0.1 SOL" line item.
          </li>
          <li>
            <b>Meteora fees are the pool's, not ours.</b> Each static pool config declares its own fee schedule
            (base fee, dynamic fee, protocol and referral share). The app shows those numbers before you commit
            and never receives any of them.
          </li>
          <li>
            <b>Pinning is yours.</b> Metadata is uploaded to IPFS through your own Pinata account from this
            browser. No intermediary storage, no account on our side.
          </li>
          <li>
            <b>Local data only.</b> Preferences and the token/pool registry live in your browser's localStorage
            and can be wiped from Settings in one click.
          </li>
        </ul>
      </Card>

      <p className="footnote">Documentation status: current as of {DOCS_DATE}.</p>
    </div>
  )
}
