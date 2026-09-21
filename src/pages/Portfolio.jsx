/**
 * Portfolio — what the connected wallet actually owns on the current cluster.
 *
 * Everything here is read straight from the chain:
 *   - SOL balance: live from the RPC
 *   - Token holdings: every token account the wallet owns, on BOTH the SPL
 *     Token and Token-2022 programs, showing decimals + raw amounts
 *   - Tokens created: the local registry of tokens created through this app
 *     (this device), each with a Manage button that hands the mint to the
 *     Liquidity tab. This is local data, so it shows even without a wallet.
 *
 * No prices, no USD valuations, no analytics — nothing this app does not
 * actually have a source for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { useNetwork } from '../lib/network.jsx'
import { useWallet } from '../lib/wallet.jsx'
import { listCreatedTokens } from '../lib/registry.js'
import { Card, Button, Banner, Empty, Spinner, Sol, Address } from '../components/ui.jsx'

const TOKEN_PROGRAMS = [
  [TOKEN_PROGRAM_ID, 'SPL Token'],
  [TOKEN_2022_PROGRAM_ID, 'Token-2022'],
]

export default function Portfolio({ onManage }) {
  const { connection, network } = useNetwork()
  const wallet = useWallet()

  const [holdings, setHoldings] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [created] = useState(() => listCreatedTokens())

  // Mint → registry entry, so we can show a real symbol/name where we have one.
  const known = useMemo(() => {
    const map = new Map()
    for (const t of created) map.set(t.mint, t)
    return map
  }, [created])

  const load = useCallback(async () => {
    if (!wallet.isConnected || !wallet.publicKey) return
    setLoading(true)
    setError(null)
    try {
      const batches = await Promise.all(
        TOKEN_PROGRAMS.map(([programId]) =>
          connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, 'confirmed')
        )
      )
      const rows = []
      batches.forEach((res, i) => {
        for (const { pubkey, account } of res.value) {
          const info = account?.data?.parsed?.info
          if (!info) continue
          const amount = BigInt(info.tokenAmount?.amount ?? '0')
          if (amount === 0n) continue
          rows.push({
            account: pubkey.toBase58(),
            mint: info.mint,
            decimals: info.tokenAmount.decimals,
            uiAmount: info.tokenAmount.uiAmountString ?? amount.toString(),
            amount,
            programLabel: TOKEN_PROGRAMS[i][1],
          })
        }
      })
      rows.sort((a, b) => (a.amount === b.amount ? 0 : a.amount < b.amount ? 1 : -1))
      setHoldings(rows)
      wallet.refreshBalance(connection, wallet.publicKey)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [connection, wallet])

  useEffect(() => {
    setHoldings(null)
    setError(null)
    load()
  }, [load])

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Portfolio</h1>
          <p className="page__sub">
            Read live from the cluster: real SOL balance, real token accounts, and the tokens you
            created through this app on this device. No prices or valuations we cannot source.
          </p>
        </div>
        {wallet.isConnected && (
          <Button onClick={load} loading={loading}>
            Refresh
          </Button>
        )}
      </div>

      <div className="stats3">
        <div className="statcard">
          <span className="statcard__label">SOL balance</span>
          <span className="statcard__value">
            {wallet.balance !== null ? <Sol lamports={wallet.balance} precision={4} /> : '—'}
          </span>
          <span className="statcard__hint">
            {wallet.isConnected ? network.label : 'connect to see'}
          </span>
        </div>
        <div className="statcard">
          <span className="statcard__label">Token holdings</span>
          <span className="statcard__value">{holdings === null ? '…' : holdings.length}</span>
          <span className="statcard__hint">token accounts with a balance</span>
        </div>
        <div className="statcard">
          <span className="statcard__label">Tokens created</span>
          <span className="statcard__value">{created.length}</span>
          <span className="statcard__hint">through this app, on this device</span>
        </div>
      </div>

      {!wallet.isConnected && (
        <Card>
          <Empty title="Wallet Not Connected">
            <p>Connect your wallet to view your portfolio.</p>
          </Empty>
        </Card>
      )}

      {error && (
        <Banner tone="danger" title="Could not read token accounts">
          {error}
        </Banner>
      )}

      <div className="page__grid">
        {wallet.isConnected && (
          <Card
            title="Token holdings"
            subtitle="Every token account this wallet owns on this cluster (SPL Token and Token-2022)"
          >
            {loading && holdings === null ? (
              <Spinner label="Reading token accounts…" />
            ) : holdings && holdings.length === 0 ? (
              <Empty title="No Tokens Found">
                <p>You don't have any tokens in this wallet on {network.label}.</p>
              </Empty>
            ) : (
              (holdings ?? []).map((h) => {
                const t = known.get(h.mint)
                return (
                  <div className="hold" key={h.account}>
                    <div className="hold__id">
                      <span className="hold__name">
                        {t ? `${t.name} (${t.symbol})` : `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`}
                      </span>
                      <span className="hold__tag">{h.programLabel}</span>
                    </div>
                    <div className="hold__amt">
                      <strong>{h.uiAmount}</strong>
                      <span className="muted"> · {h.amount} raw · {h.decimals} decimals</span>
                    </div>
                    <div className="hold__foot">
                      <Address value={h.mint} explorer={network.explorerAddress} label="mint" />
                    </div>
                  </div>
                )
              })
            )}
          </Card>
        )}

        <Card
          title="Tokens created"
          subtitle="Saved locally when you create a token here. Manage opens the Liquidity tab with the mint filled in."
        >
          {created.length === 0 ? (
            <Empty title="Nothing created yet">
              <p>Tokens you create in this app will be listed here with a Manage button.</p>
            </Empty>
          ) : (
            created.map((t) => (
              <div className="hold" key={t.mint}>
                <div className="hold__id">
                  <span className="hold__name">
                    {t.name} ({t.symbol})
                  </span>
                  <span className="hold__tag">
                    {t.program === 'token2022' ? 'Token-2022' : 'SPL Token'}
                  </span>
                </div>
                <div className="hold__amt">
                  <strong>{Number(t.decimals)} decimals</strong>
                  <span className="muted"> · created {new Date(t.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="hold__foot">
                  <Address value={t.mint} explorer={network.explorerAddress} label="mint" />
                  <Button size="sm" onClick={() => onManage(t.mint)}>
                    Manage
                  </Button>
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  )
}
