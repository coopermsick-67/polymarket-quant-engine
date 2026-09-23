"use client";

import { AlertTriangle, BarChart3, Check, Download, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { LedgerMetrics, MarketDecisionRow } from "../lib/decision-ledger";
import { accountEquity, type PaperAccount } from "../lib/engines";
import type { PaperConfig } from "../lib/paper-engine";
import type { SignalParams } from "../lib/signal";
import type { LiveMarket } from "../lib/polymarket-data";
import { cents, dollars, percentage, points, signedDollars, timeLeft } from "./format";

export type TelegramViewState = {
  connected: boolean;
  botUsername: string;
  botName: string;
  chatId: string;
  chatTitle: string;
  expiresAt: number | null;
  alerts: boolean;
  lastStatus: string;
  lastError: string;
};

export type PaperConfigPatch = Omit<Partial<PaperConfig>, "signal"> & { signal?: Partial<SignalParams> };

type Props = {
  account: PaperAccount;
  markets: Map<string, LiveMarket>;
  config: PaperConfig;
  halt: { reason: string; at: number } | null;
  pending: number;
  clock: number;
  ledgerRows: MarketDecisionRow[];
  metrics: LedgerMetrics;
  telegram: TelegramViewState;
  onConfigChange: (patch: PaperConfigPatch) => void;
  onResetAccount: (startingCash: number) => void;
  onClearHalt: () => void;
  onExportLedger: () => void;
  onClearLedger: () => void;
  onTelegramConnect: (botToken: string, chatId: string) => Promise<boolean>;
  onTelegramDisconnect: () => void;
  onTelegramTest: () => void;
  onTelegramAlerts: (enabled: boolean) => void;
};

const Range = ({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) => (
  <label className="range-control">
    <span>
      <b>{label}</b>
      <em>{display}</em>
    </span>
    <input max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="range" value={value} />
  </label>
);

export default function PaperLabPanel(props: Props) {
  const { account, markets, config, halt, pending, clock, ledgerRows, metrics, telegram } = props;
  const [filter, setFilter] = useState<"ALL" | "ENTERED" | "PASS">("ALL");
  const [startingCash, setStartingCash] = useState(String(account.startingCash));
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [telegramLoading, setTelegramLoading] = useState(false);
  const equity = accountEquity(account, markets);
  const rows = useMemo(
    () =>
      [...ledgerRows]
        .sort((left, right) => right.endTime - left.endTime)
        .filter((row) => filter === "ALL" || (filter === "ENTERED" ? row.entry : !row.entry))
        .slice(0, 150),
    [filter, ledgerRows],
  );
  const connectTelegram = async () => {
    setTelegramLoading(true);
    const connected = await props.onTelegramConnect(botToken.trim(), chatId.trim());
    setTelegramLoading(false);
    if (connected) setBotToken("");
  };

  return (
    <section className="paper-lab">
      <div className="section-heading">
        <div>
          <div className="eyebrow">PAPER / SHADOW ENGINE</div>
          <h2>Latency-aware paper trading</h2>
          <p className="section-subtitle">
            Orders are decided on the current snapshot and filled {config.latencyMs}ms later at the decision&apos;s limit price, against whatever the book is
            then. Positions settle only on official Polymarket resolutions. The headless runner uses this exact engine without a browser tab.
          </p>
        </div>
        <span className="research-badge">
          <BarChart3 size={14} />
          {metrics.tracked.toLocaleString()} MARKETS TRACKED
        </span>
      </div>
      {halt ? (
        <div className="critical-banner">
          <AlertTriangle size={17} />
          <span>
            <strong>RISK HALT</strong> — {halt.reason}
          </span>
          <button onClick={props.onClearHalt} type="button">
            Acknowledge and resume
          </button>
        </div>
      ) : null}
      <div className="paper-test-grid">
        <article className="panel live-risk-card">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">ENGINE SETTINGS</div>
              <h3>Edge, sizing, and limits</h3>
            </div>
            <SlidersHorizontal size={17} className="heading-icon" />
          </div>
          <div className="risk-controls">
            <Range
              label="Edge floor after fees"
              value={config.signal.minEdge}
              display={points(config.signal.minEdge)}
              min={0.005}
              max={0.15}
              step={0.005}
              onChange={(minEdge) => props.onConfigChange({ signal: { minEdge } })}
            />
            <Range
              label="Model weight vs book"
              value={config.signal.modelWeight}
              display={percentage(config.signal.modelWeight, 0)}
              min={0}
              max={1}
              step={0.05}
              onChange={(modelWeight) => props.onConfigChange({ signal: { modelWeight } })}
            />
            <Range
              label="Vol uncertainty band"
              value={config.signal.volUncertainty}
              display={`±${percentage(config.signal.volUncertainty, 0)}`}
              min={0}
              max={0.8}
              step={0.05}
              onChange={(volUncertainty) => props.onConfigChange({ signal: { volUncertainty } })}
            />
            <Range
              label="Stake per trade"
              value={config.stakeUsd}
              display={dollars(config.stakeUsd, 0)}
              min={5}
              max={250}
              step={5}
              onChange={(stakeUsd) => props.onConfigChange({ stakeUsd })}
            />
            <Range
              label="Simulated latency"
              value={config.latencyMs}
              display={`${config.latencyMs}ms`}
              min={0}
              max={3000}
              step={50}
              onChange={(latencyMs) => props.onConfigChange({ latencyMs })}
            />
            <Range
              label="Daily loss halt"
              value={config.dailyLossPct}
              display={percentage(config.dailyLossPct)}
              min={0.01}
              max={0.25}
              step={0.01}
              onChange={(dailyLossPct) => props.onConfigChange({ dailyLossPct })}
            />
            <Range
              label="Max drawdown halt"
              value={config.maxDrawdownPct}
              display={percentage(config.maxDrawdownPct)}
              min={0.02}
              max={0.5}
              step={0.01}
              onChange={(maxDrawdownPct) => props.onConfigChange({ maxDrawdownPct })}
            />
            <Range
              label="Max open exposure"
              value={config.maxOpenExposurePct}
              display={percentage(config.maxOpenExposurePct)}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(maxOpenExposurePct) => props.onConfigChange({ maxOpenExposurePct })}
            />
            <Range
              label="Min entry price (no tails)"
              value={config.signal.minEntryPrice}
              display={cents(config.signal.minEntryPrice)}
              min={0.01}
              max={0.3}
              step={0.01}
              onChange={(minEntryPrice) => props.onConfigChange({ signal: { minEntryPrice } })}
            />
          </div>
          <div className="paper-test-form">
            <label>
              <span>Reset with starting cash</span>
              <input min="1" onChange={(event) => setStartingCash(event.target.value)} type="number" value={startingCash} />
            </label>
            <button className="button-secondary" onClick={() => props.onResetAccount(Number(startingCash))} type="button">
              <RefreshCw size={14} />
              RESET PAPER ACCOUNT
            </button>
          </div>
        </article>
        <article className="panel paper-metrics-card">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">DECISION QUALITY</div>
              <h3>Graded on first entry + official outcomes</h3>
            </div>
            <span className="panel-footnote">
              <ShieldCheck size={13} /> {metrics.settled} settled
            </span>
          </div>
          <div className="paper-metric-grid">
            <div>
              <span>REALIZED EDGE</span>
              <strong className={metrics.realizedEdge === null ? "" : metrics.realizedEdge >= 0 ? "text-positive" : "text-negative"}>
                {points(metrics.realizedEdge)}
              </strong>
              <small>predicted {points(metrics.predictedEdge)}</small>
            </div>
            <div>
              <span>WIN RATE</span>
              <strong>{percentage(metrics.winRate)}</strong>
              <small>
                {metrics.winRateCi ? `95% CI ${percentage(metrics.winRateCi[0])}–${percentage(metrics.winRateCi[1])}` : `${metrics.entries} entries`}
              </small>
            </div>
            <div>
              <span>BRIER MODEL</span>
              <strong>{metrics.brierModel?.toFixed(4) ?? "—"}</strong>
              <small>posterior {metrics.brierPosterior?.toFixed(4) ?? "—"}</small>
            </div>
            <div>
              <span>BRIER BOOK</span>
              <strong>{metrics.brierMarket?.toFixed(4) ?? "—"}</strong>
              <small>{metrics.calibrated} checkpoints @120s</small>
            </div>
            <div>
              <span>EQUITY</span>
              <strong>{dollars(equity)}</strong>
              <small>{signedDollars(equity - account.startingCash)} total</small>
            </div>
            <div>
              <span>DAY P&amp;L</span>
              <strong>{signedDollars(equity - account.dayStartEquity)}</strong>
              <small>{pending} order(s) in flight</small>
            </div>
          </div>
          <div className="risk-note">
            <AlertTriangle size={15} />
            <span>
              Win rate is not the goal. The model has an edge only if realized edge stays positive and its Brier score beats the book&apos;s over hundreds of
              markets.
            </span>
          </div>
        </article>
      </div>
      <article className="panel unified-positions-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">POSITION BOOK</div>
            <h3>
              Paper positions{" "}
              <span className="heading-muted">
                / {account.positions.length} open · {account.closedTrades.length} closed
              </span>
            </h3>
          </div>
        </div>
        <div className="positions-table-wrap">
          <table className="positions-table">
            <thead>
              <tr>
                <th>MARKET</th>
                <th>SIDE</th>
                <th>SHARES</th>
                <th>ALL-IN COST</th>
                <th>MARK / EXIT</th>
                <th>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {account.positions.map((position) => {
                const market = markets.get(position.marketId);
                const mark = market ? (position.side === "UP" ? market.upBid : market.downBid) : position.mark;
                const pnl = mark === null ? null : mark * position.shares - position.totalCost;
                return (
                  <tr key={position.id}>
                    <td>
                      <strong>{position.marketLabel}</strong>
                      <small>{position.endTime > clock ? `${timeLeft((position.endTime - clock) / 1000)} left` : "awaiting official resolution"}</small>
                    </td>
                    <td>
                      <span className={`side-chip ${position.side === "UP" ? "up" : "down"}`}>{position.side}</span>
                    </td>
                    <td>{position.shares.toFixed(2)}</td>
                    <td>{cents(position.avgEntry)}</td>
                    <td>{cents(mark)}</td>
                    <td className={pnl === null ? "text-muted" : pnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(pnl)}</td>
                  </tr>
                );
              })}
              {account.closedTrades.slice(0, 60).map((trade) => (
                <tr key={trade.id} className="closed-row">
                  <td>
                    <strong>{trade.marketLabel}</strong>
                    <small>{trade.reason}</small>
                  </td>
                  <td>
                    <span className={`side-chip ${trade.side === "UP" ? "up" : "down"}`}>{trade.side}</span>
                  </td>
                  <td>{trade.shares.toFixed(2)}</td>
                  <td>{cents(trade.entry)}</td>
                  <td>{cents(trade.exit)}</td>
                  <td className={trade.pnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(trade.pnl)}</td>
                </tr>
              ))}
              {!account.positions.length && !account.closedTrades.length ? (
                <tr>
                  <td className="empty-row" colSpan={6}>
                    No paper positions yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </article>
      <article className="panel ledger-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">EVERY MARKET</div>
            <h3>
              Decision ledger <span className="heading-muted">/ {ledgerRows.length.toLocaleString()} rows</span>
            </h3>
          </div>
          <div className="ledger-actions">
            <div className="ledger-filters" role="tablist" aria-label="Decision filter">
              {(["ALL", "ENTERED", "PASS"] as const).map((item) => (
                <button
                  aria-selected={filter === item}
                  className={filter === item ? "filter-tab active" : "filter-tab"}
                  key={item}
                  onClick={() => setFilter(item)}
                  role="tab"
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
            <button className="text-button" onClick={props.onExportLedger} type="button">
              <Download size={13} />
              CSV
            </button>
            <button className="text-button" onClick={props.onClearLedger} type="button">
              <Trash2 size={13} />
              Clear
            </button>
          </div>
        </div>
        <div className="positions-table-wrap">
          <table className="positions-table">
            <thead>
              <tr>
                <th>MARKET</th>
                <th>FIRST ENTRY</th>
                <th>@120s MODEL / BOOK</th>
                <th>LAST</th>
                <th>OUTCOME</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>
                        {row.asset} {row.duration}
                      </strong>
                      <small>{new Date(row.endTime).toLocaleTimeString("en-US", { hour12: false })} close</small>
                    </td>
                    <td>{row.entry ? `${row.entry.side} ${cents(row.entry.costPerShare)} · ${points(row.entry.edge)}` : "—"}</td>
                    <td>{row.checkpoint ? `${percentage(row.checkpoint.model)} / ${percentage(row.checkpoint.market)}` : "—"}</td>
                    <td title={row.reason}>{row.decision === "PASS" ? `PASS · ${row.gate}` : row.decision}</td>
                    <td className={row.result === "WIN" ? "text-positive" : row.result === "LOSS" ? "text-negative" : "text-muted"}>
                      {row.outcome ? `${row.outcome} · ${row.result}` : row.result}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-row" colSpan={5}>
                    The ledger fills as markets are observed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
      <article className="panel telegram-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">ALERTS + WEEKLY REPORTS</div>
            <h3>Telegram</h3>
          </div>
          <Send size={17} className="heading-icon" />
        </div>
        {!telegram.connected ? (
          <>
            <p className="panel-copy">
              Link a bot for real-time alerts on halts, fills and settlements, plus the Sunday 9 PM ET summary. For alerts without an open tab, run the headless
              runner with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
            </p>
            <div className="telegram-form">
              <label>
                <span>Bot token</span>
                <input
                  autoComplete="new-password"
                  onChange={(event) => setBotToken(event.target.value)}
                  placeholder="123456:AA…"
                  spellCheck={false}
                  type="password"
                  value={botToken}
                />
              </label>
              <label>
                <span>Chat ID or @channel</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setChatId(event.target.value)}
                  placeholder="123456789 or @channel"
                  spellCheck={false}
                  value={chatId}
                />
              </label>
            </div>
            <div className="telegram-actions">
              <button
                className="button-primary"
                disabled={telegramLoading || !botToken.trim() || !chatId.trim()}
                onClick={() => void connectTelegram()}
                type="button"
              >
                {telegramLoading ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}LINK &amp; VERIFY
              </button>
              <span className="panel-footnote">
                <ShieldCheck size={13} /> Token is sealed server-side, never in localStorage
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="telegram-connected">
              <div>
                <span className="metric-label">BOT</span>
                <strong>@{telegram.botUsername || telegram.botName}</strong>
                <small>
                  {telegram.chatTitle} · {telegram.chatId}
                </small>
              </div>
              <span className="result-badge ready">
                <span className="status-dot status-ready" />
                LINKED
              </span>
            </div>
            <label className="live-checkbox">
              <input checked={telegram.alerts} onChange={(event) => props.onTelegramAlerts(event.target.checked)} type="checkbox" />
              <span>Real-time alerts for halts, fills, settlements, and live runner stops</span>
            </label>
            <div className="telegram-actions">
              <button className="button-secondary" onClick={props.onTelegramTest} type="button">
                <Send size={14} />
                SEND TEST REPORT
              </button>
              <button className="button-danger" onClick={props.onTelegramDisconnect} type="button">
                <X size={14} />
                UNLINK
              </button>
            </div>
          </>
        )}
        {telegram.lastError ? (
          <div className="data-alert">
            <AlertTriangle size={15} />
            <div>
              <strong>Telegram</strong>
              <span>{telegram.lastError}</span>
            </div>
          </div>
        ) : telegram.lastStatus ? (
          <div className="account-empty-line">
            <span className="status-dot status-ready" />
            {telegram.lastStatus}
          </div>
        ) : null}
      </article>
    </section>
  );
}
