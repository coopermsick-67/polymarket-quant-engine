"use client";

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  CircleDollarSign,
  Copy,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { useState } from "react";
import { cents, dollars, formatTime, signedDollars } from "./format";
import { EmptyState, MetricCard } from "./ui";

export type AccountConnection = { walletAddress: string; privateKey: string; signatureType: string; useServerKey: boolean };
type AccountPosition = {
  id: string;
  title: string;
  outcome: string;
  size: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  status: string;
  lastEventAt: number | null;
};
type AccountOrder = { id: string; side: string; price: number | null; size: number | null; matched: number | null; status: string };
type AccountTrade = { id: string; timestamp: number | null; title: string; side: string; price: number | null; shares: number | null; status: string };
export type ConnectedAccount = {
  walletAddress: string;
  authenticated: boolean;
  portfolioValue: number | null;
  cashBalance: number | null;
  openPositions: AccountPosition[];
  openOrders: AccountOrder[];
  recentTrades: AccountTrade[];
  pnl: number | null;
  tradedMarketCount: number | null;
  fetchedAt: number;
  warnings: string[];
};

const quantity = (value: number | null) => (value === null || !Number.isFinite(value) ? "—" : value.toFixed(2));

export function AccountView({
  account,
  loading,
  error,
  onConnect,
  onRefresh,
  onDisconnect,
}: {
  account: ConnectedAccount | null;
  loading: boolean;
  error: string;
  onConnect: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  return (
    <section className="account-view">
      <div className="section-heading">
        <div>
          <div className="eyebrow">ACCOUNT CONSOLE</div>
          <h2>Connected Polymarket account</h2>
          <p className="section-subtitle">
            Public wallet data plus session-authenticated balance and open orders. Live order controls live in the Live Executor tab.
          </p>
        </div>
        <div className="account-heading-actions">
          {account ? (
            <>
              <button className="button-secondary" disabled={loading} onClick={onRefresh} type="button">
                {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}REFRESH
              </button>
              <button className="button-secondary" onClick={onConnect} type="button">
                <Settings2 size={14} />
                EDIT CONNECTION
              </button>
              <button className="button-danger" onClick={onDisconnect} type="button">
                <X size={14} />
                DISCONNECT
              </button>
            </>
          ) : (
            <button className="button-primary" onClick={onConnect} type="button">
              <Wallet size={14} />
              LINK POLYMARKET
            </button>
          )}
        </div>
      </div>
      {error ? (
        <div className="data-alert account-alert">
          <AlertTriangle size={16} />
          <div>
            <strong>Account sync failed</strong>
            <span>{error}</span>
          </div>
          <button onClick={onRefresh} type="button">
            Retry
          </button>
        </div>
      ) : null}
      {!account ? (
        <EmptyState
          title="No Polymarket account linked"
          detail="Link with the server-held key (preferred) or a browser-entered key sealed into a short-lived encrypted session."
          action={
            <button className="button-primary" onClick={onConnect} type="button">
              <Wallet size={14} />
              Connect account
            </button>
          }
        />
      ) : (
        <>
          <div className="account-identity">
            <div>
              <span className="metric-label">WALLET</span>
              <strong>{account.walletAddress}</strong>
            </div>
            <div className="account-badges">
              <span className={`result-badge ${account.authenticated ? "ready" : "waiting"}`}>
                <span className={`status-dot ${account.authenticated ? "status-ready" : "status-warning"}`} />
                {account.authenticated ? "SESSION AUTHENTICATED" : "PUBLIC DATA ONLY"}
              </span>
              <span className="account-fetched">synced {formatTime(account.fetchedAt)}</span>
            </div>
          </div>
          <div className="account-metrics metric-grid">
            <MetricCard
              label="PORTFOLIO VALUE"
              value={dollars(account.portfolioValue)}
              delta="Data API"
              detail="public wallet value"
              icon={<CircleDollarSign size={17} />}
            />
            <MetricCard
              label="CASH BALANCE"
              value={account.authenticated ? dollars(account.cashBalance) : "—"}
              delta={account.authenticated ? "micro-USDC parsed" : "link a session"}
              deltaTone={account.authenticated ? "positive" : "warning"}
              detail="collateral available"
              icon={<Wallet size={17} />}
            />
            <MetricCard
              label="ACCOUNT P&L"
              value={signedDollars(account.pnl)}
              delta="user-pnl"
              detail="latest cumulative point"
              icon={<TrendingUp size={17} />}
            />
            <MetricCard
              label="POSITIONS"
              value={String(account.openPositions.length)}
              delta={`${account.openOrders.length} open orders`}
              detail="public positions"
              icon={<BarChart3 size={17} />}
            />
            <MetricCard
              label="RECENT TRADES"
              value={String(account.recentTrades.length)}
              delta={account.tradedMarketCount === null ? "—" : `${account.tradedMarketCount} markets`}
              detail="wallet activity"
              icon={<Activity size={17} />}
            />
          </div>
          {account.warnings.length ? (
            <div className="account-warnings">
              <AlertTriangle size={15} />
              <div>
                {account.warnings.map((warning) => (
                  <span key={warning}>{warning}</span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="account-grid">
            <article className="panel positions-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">POSITIONS</div>
                  <h3>
                    Open positions <span className="heading-muted">/ {account.openPositions.length}</span>
                  </h3>
                </div>
              </div>
              <div className="positions-table-wrap">
                <table className="positions-table">
                  <thead>
                    <tr>
                      <th>MARKET</th>
                      <th>OUTCOME</th>
                      <th>SIZE</th>
                      <th>MARK</th>
                      <th>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.openPositions.length ? (
                      account.openPositions.map((position) => (
                        <tr key={position.id}>
                          <td>
                            <strong>{position.title}</strong>
                            <small>
                              {position.status} · {formatTime(position.lastEventAt)}
                            </small>
                          </td>
                          <td>{position.outcome}</td>
                          <td>{quantity(position.size)}</td>
                          <td>{cents(position.currentPrice)}</td>
                          <td className={position.unrealizedPnl === null ? "text-muted" : position.unrealizedPnl >= 0 ? "text-positive" : "text-negative"}>
                            {signedDollars(position.unrealizedPnl)}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td className="empty-row" colSpan={5}>
                          No open positions.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="panel positions-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">ACTIVITY</div>
                  <h3>
                    Recent trades <span className="heading-muted">/ {account.recentTrades.length}</span>
                  </h3>
                </div>
              </div>
              <div className="positions-table-wrap">
                <table className="positions-table">
                  <thead>
                    <tr>
                      <th>TIME</th>
                      <th>MARKET</th>
                      <th>SIDE</th>
                      <th>PRICE</th>
                      <th>SIZE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.recentTrades.length ? (
                      account.recentTrades.map((trade) => (
                        <tr key={trade.id}>
                          <td>{formatTime(trade.timestamp)}</td>
                          <td>
                            <strong>{trade.title}</strong>
                            <small>{trade.status}</small>
                          </td>
                          <td>
                            <span className={`side-chip ${trade.side.toUpperCase() === "BUY" ? "up" : "down"}`}>{trade.side}</span>
                          </td>
                          <td>{cents(trade.price)}</td>
                          <td>{quantity(trade.shares)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td className="empty-row" colSpan={5}>
                          No trade activity.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          </div>
          <article className="panel account-orders-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">AUTHENTICATED CLOB</div>
                <h3>
                  Open orders <span className="heading-muted">/ {account.openOrders.length}</span>
                </h3>
              </div>
            </div>
            {account.authenticated ? (
              account.openOrders.length ? (
                <div className="positions-table-wrap">
                  <table className="positions-table">
                    <thead>
                      <tr>
                        <th>SIDE</th>
                        <th>PRICE</th>
                        <th>SIZE</th>
                        <th>MATCHED</th>
                        <th>STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.openOrders.map((order) => (
                        <tr key={order.id}>
                          <td>{order.side}</td>
                          <td>{cents(order.price)}</td>
                          <td>{quantity(order.size)}</td>
                          <td>{quantity(order.matched)}</td>
                          <td>{order.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="account-empty-line">No open CLOB orders.</div>
              )
            ) : (
              <div className="account-empty-line">Link a live session to read private open orders and collateral.</div>
            )}
          </article>
        </>
      )}
    </section>
  );
}

export function AccountConnectModal({
  connection,
  serverKeyConfigured,
  loading,
  error,
  onChange,
  onSubmit,
  onClose,
}: {
  connection: AccountConnection;
  serverKeyConfigured: boolean;
  loading: boolean;
  error: string;
  onChange: <K extends keyof AccountConnection>(field: K, value: AccountConnection[K]) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const server = serverKeyConfigured && connection.useServerKey;
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        aria-labelledby="account-connect-title"
        aria-modal="true"
        className="modal-card account-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button aria-label="Close account connection" className="modal-close" onClick={onClose} type="button">
          <X size={17} />
        </button>
        <div className="modal-icon account-modal-icon">
          <Wallet size={20} />
        </div>
        <div className="eyebrow">SECURE LIVE CONNECTION</div>
        <h2 id="account-connect-title">Link Polymarket account</h2>
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {serverKeyConfigured ? (
            <label className="live-checkbox">
              <input checked={connection.useServerKey} onChange={(event) => onChange("useServerKey", event.target.checked)} type="checkbox" />
              <span>Use the server-held signer (recommended: the key never enters this browser)</span>
            </label>
          ) : (
            <p>
              No server-held signer is configured. Setting POLYMARKET_PRIVATE_KEY and POLYMARKET_WALLET_ADDRESS on the server is safer than entering a key here.
            </p>
          )}
          {!server ? (
            <>
              <label>
                <span>
                  Wallet address <em>required</em>
                </span>
                <input
                  autoComplete="off"
                  onChange={(event) => onChange("walletAddress", event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  value={connection.walletAddress}
                />
              </label>
              <label>
                <span>Wallet / signer type</span>
                <select onChange={(event) => onChange("signatureType", event.target.value)} value={connection.signatureType}>
                  <option value="3">Polymarket proxy / smart wallet (3)</option>
                  <option value="0">EOA signer (0)</option>
                  <option value="1">Proxy wallet (1)</option>
                  <option value="2">Gnosis Safe (2)</option>
                </select>
              </label>
              <label>
                <span>
                  Signer private key <em>required</em>
                </span>
                <input
                  autoComplete="new-password"
                  onChange={(event) => onChange("privateKey", event.target.value)}
                  placeholder="64 hex characters"
                  spellCheck={false}
                  type="password"
                  value={connection.privateKey}
                />
              </label>
            </>
          ) : null}
          {error ? (
            <div className="account-form-error">
              <AlertTriangle size={14} />
              {error}
            </div>
          ) : null}
          <div className="account-security-note">
            <LockKeyhole size={15} />
            <span>
              A browser-entered key is sent once over HTTPS, sealed with AES-GCM into an HttpOnly, SameSite=Strict, 15-minute cookie, and cleared from page
              state. It is never written to localStorage or logs.
            </span>
          </div>
          <div className="modal-actions">
            <button className="button-secondary" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="button-primary"
              disabled={loading || (!server && (!connection.walletAddress.trim() || !connection.privateKey.trim()))}
              type="submit"
            >
              {loading ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {loading ? "Linking…" : "Connect & secure session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const RUNNER_COMMANDS = ["pnpm install", "pnpm run headless -- --auto --record", "# or, supervised: bash scripts/run_forever.sh headless"];

export function RunnerSetupModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RUNNER_COMMANDS.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        aria-labelledby="runner-setup-title"
        aria-modal="true"
        className="modal-card runner-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button aria-label="Close runner setup" className="modal-close" onClick={onClose} type="button">
          <X size={17} />
        </button>
        <div className="modal-icon runner-modal-icon">
          <Terminal size={20} />
        </div>
        <div className="eyebrow">24/7 HEADLESS RUNNER</div>
        <h2 id="runner-setup-title">Run the engine without a browser tab</h2>
        <p>
          The headless runner uses the same feeds, signal, and paper engine as this page. It persists state to ./data, records replayable snapshots, and can
          send Telegram alerts (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
        </p>
        <div className="runner-checks">
          <div>
            <span className="status-dot status-ready" />
            <span>No browser tab required</span>
            <b className="gate-pass">ON</b>
          </div>
          <div>
            <span className="status-dot status-ready" />
            <span>Atomic state persistence + replay recording</span>
            <b className="gate-pass">ON</b>
          </div>
          <div>
            <span className="status-dot status-locked" />
            <span>Live orders from the runner</span>
            <b className="gate-pending">OFF</b>
          </div>
        </div>
        <div className="runner-command">
          <div className="runner-command-label">
            <span>RUN FROM THE PROJECT ROOT</span>
            <button className="text-button" onClick={() => void copy()} type="button">
              <Copy size={13} />
              {copied ? "COPIED" : "COPY"}
            </button>
          </div>
          <code>{RUNNER_COMMANDS.join("\n")}</code>
        </div>
        <div className="runner-note">
          <ShieldCheck size={15} />
          <span>Use systemd, launchd, or Task Scheduler to start it at boot.</span>
        </div>
        <div className="modal-actions">
          <button className="button-secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
