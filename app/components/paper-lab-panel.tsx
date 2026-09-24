"use client";

import { AlertTriangle, BarChart3, Check, Download, Pause, Play, RefreshCw, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { accountDeployed, accountEquity, type PaperAccount } from "../lib/engines";
import { ACTIVE_MODEL_VERSION, type LedgerMetrics, type MarketDecisionRow } from "../lib/decision-ledger";
import type { LiveMarket } from "../lib/polymarket-data";

export type PaperTestViewState = {
  status: "IDLE" | "RUNNING" | "PAUSED" | "PENDING_RESOLUTION" | "COMPLETE";
  startingBalance: number;
  days: number;
  startedAt: number | null;
  endsAt: number | null;
  balance: number;
  trades: number;
  openPositions: number;
  realizedPnl: number;
  winRate: number | null;
};

export type TelegramViewState = {
  connected: boolean;
  botUsername: string;
  botName: string;
  chatId: string;
  chatTitle: string;
  expiresAt: number | null;
  lastStatus: string;
  lastError: string;
};

type PositionView = {
  id: string;
  status: "OPEN" | "CLOSED";
  timestamp: number;
  marketLabel: string;
  asset: string;
  duration: string;
  side: "UP" | "DOWN";
  shares: number;
  entry: number;
  mark: number | null;
  pnl: number | null;
  detail: string;
};

type Props = {
  paperTest: PaperTestViewState;
  paperAccount: PaperAccount;
  paperMarkets: Map<string, LiveMarket>;
  clock: number;
  engineRunning: boolean;
  paused: boolean;
  startingBalanceInput: string;
  durationDaysInput: string;
  ledgerRows: MarketDecisionRow[];
  metrics: LedgerMetrics;
  telegram: TelegramViewState;
  onStartingBalanceChange: (value: string) => void;
  onDurationDaysChange: (value: string) => void;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onReset: () => void;
  onExport: () => void;
  onClearLedger: () => void;
  onTelegramConnect: (botToken: string, chatId: string) => Promise<boolean>;
  onTelegramDisconnect: () => void;
  onTelegramTest: () => void;
  onTelegramRefresh: () => void;
};

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const signedMoney = (value: number) => (value >= 0 ? "+" : "−") + money(Math.abs(value));
const percent = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : (value * 100).toFixed(1) + "%";
const cents = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : (value * 100).toFixed(1) + "¢";
const dateTime = (value: number) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const timeLeft = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, "0")}:${(Math.max(0, seconds) % 60).toString().padStart(2, "0")}`;

const currentMarkFor = (position: { side: "UP" | "DOWN"; marketId: string; mark: number | null }, markets: Map<string, LiveMarket>) => {
  const market = markets.get(position.marketId);
  return market ? position.side === "UP" ? market.upBid : market.downBid : position.mark;
};

export default function PaperLabPanel({ paperTest, paperAccount, paperMarkets, clock, engineRunning, paused, startingBalanceInput, durationDaysInput, ledgerRows, metrics, telegram, onStartingBalanceChange, onDurationDaysChange, onStart, onPause, onStop, onReset, onExport, onClearLedger, onTelegramConnect, onTelegramDisconnect, onTelegramTest, onTelegramRefresh }: Props) {
  const [filter, setFilter] = useState<"ALL" | "UP" | "DOWN" | "PASS">("ALL");
  const [positionFilter, setPositionFilter] = useState<"ALL" | "OPEN" | "CLOSED">("ALL");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [telegramLoading, setTelegramLoading] = useState(false);
  const visibleRows = useMemo(() => ledgerRows.slice().reverse().filter((row) => filter === "ALL" || row.decision === filter).slice(0, 120), [filter, ledgerRows]);
  const positionRows = useMemo<PositionView[]>(() => {
    const open = paperAccount.positions.map((position) => {
      const mark = currentMarkFor(position, paperMarkets);
      const pnl = mark === null ? null : (mark - position.avgEntry) * position.shares;
      return { id: `open-${position.id}`, status: "OPEN" as const, timestamp: position.openedAt, marketLabel: position.marketLabel, asset: position.asset, duration: position.duration, side: position.side, shares: position.shares, entry: position.avgEntry, mark, pnl, detail: `${timeLeft(Math.round((position.endTime - clock) / 1000))} left` };
    });
    const closed = paperAccount.closedTrades.map((trade) => ({ id: `closed-${trade.id}`, status: "CLOSED" as const, timestamp: trade.timestamp, marketLabel: trade.marketLabel, asset: trade.asset, duration: trade.duration, side: trade.side, shares: trade.shares, entry: trade.entry, mark: trade.exit, pnl: trade.pnl, detail: trade.reason }));
    return [...open, ...closed].filter((row) => positionFilter === "ALL" || row.status === positionFilter).sort((left, right) => right.timestamp - left.timestamp).slice(0, 250);
  }, [clock, paperAccount.closedTrades, paperAccount.positions, paperMarkets, positionFilter]);
  const equity = accountEquity(paperAccount, paperMarkets);
  const testPnl = paperTest.balance - paperTest.startingBalance;
  const isRunning = paperTest.status === "RUNNING";
  const isPaused = paperTest.status === "PAUSED";
  const canStart = !isRunning && !isPaused && paperTest.status !== "PENDING_RESOLUTION" && Number(startingBalanceInput) > 0 && Number(durationDaysInput) > 0;

  const connectTelegram = async () => {
    setTelegramLoading(true);
    const connected = await onTelegramConnect(botToken.trim(), chatId.trim());
    setTelegramLoading(false);
    if (connected) setBotToken("");
  };

  return <section className="paper-lab">
    <div className="section-heading"><div><div className="eyebrow">PAPER RESEARCH LAB</div><h2>Unified paper engine + timeframe tests</h2><p className="section-subtitle">The Paper Trader and Paper Lab now use one shared account, one balance, one position book, and one decision ledger. Manual entries, automatic entries, and timeframe tests cannot drift into separate balances.</p></div><span className="research-badge"><BarChart3 size={14} />{metrics.tracked.toLocaleString()} MARKETS TRACKED</span></div>
    <div className="paper-test-grid"><article className="panel paper-test-config"><div className="panel-heading"><div><div className="eyebrow">SHARED FORWARD TEST</div><h3>{isRunning ? "Paper test running" : isPaused ? "Paper test paused" : paperTest.status === "COMPLETE" ? "Paper test complete" : paperTest.status === "PENDING_RESOLUTION" ? "Waiting for market results" : "Configure a paper test"}</h3></div><span className={"result-badge " + (isRunning ? "ready" : isPaused ? "waiting" : "ready")}><span className={"status-dot " + (isRunning ? "status-ready" : isPaused ? "status-warning" : "status-sim")} />{paperTest.status}</span></div><div className="paper-test-form"><label><span>Starting shared paper balance</span><input min="1" onChange={(event) => onStartingBalanceChange(event.target.value)} step="10" type="number" value={startingBalanceInput} /></label><label><span>Trading duration (days)</span><input min="1" max="90" onChange={(event) => onDurationDaysChange(event.target.value)} step="1" type="number" value={durationDaysInput} /></label></div><div className="paper-test-actions"><button className="button-primary" disabled={!canStart} onClick={onStart} type="button"><Play fill="currentColor" size={14} />START SHARED TEST</button><button className="button-secondary" disabled={!isRunning} onClick={onPause} type="button"><Pause size={14} />PAUSE</button><button className="button-secondary" disabled={!isPaused} onClick={onPause} type="button"><Play size={14} />RESUME</button><button className="button-danger" disabled={!isRunning && !isPaused} onClick={onStop} type="button"><X size={14} />STOP</button><button className="button-secondary" onClick={onReset} type="button"><RefreshCw size={14} />RESET SHARED ACCOUNT</button></div><div className="paper-test-stats"><span><b>{money(paperTest.balance)}</b> current shared equity</span><span className={testPnl >= 0 ? "text-positive" : "text-negative"}><b>{signedMoney(testPnl)}</b> test P&amp;L</span><span><b>{paperTest.trades}</b> entries taken</span><span><b>{paperTest.openPositions}</b> open positions</span></div><div className="risk-note"><ShieldCheck size={15} /><span>{paperTest.status === "PENDING_RESOLUTION" ? "Test duration ended. New entries are stopped; open positions remain until Gamma confirms their final outcomes." : engineRunning ? paused ? "The shared engine is paused. Existing positions remain visible and settle after Gamma confirms their final outcomes." : "The shared engine is running. Every manual, automatic, and test fill appears in the same account below." : "Starting a test resets the shared paper account to the selected balance. This browser paper session runs while the page is active; the headless Linux daemon is the 24/7 service."}</span></div></article>
      <article className="panel paper-metrics-card"><div className="panel-heading"><div><div className="eyebrow">DECISION OUTCOMES</div><h3>UP / DOWN / combined</h3></div><span className="panel-footnote"><ShieldCheck size={13} /> Settled rows only</span></div><div className="paper-metric-grid"><div><span>UP WIN RATE</span><strong>{percent(metrics.upWinRate)}</strong><small>{metrics.upWins}W / {metrics.upSettled} settled</small></div><div><span>DOWN WIN RATE</span><strong>{percent(metrics.downWinRate)}</strong><small>{metrics.downWins}W / {metrics.downSettled} settled</small></div><div><span>COMBINED</span><strong>{percent(metrics.combinedWinRate)}</strong><small>{metrics.wins}W / {metrics.settled} settled</small></div><div><span>PASS</span><strong>{metrics.pass.toLocaleString()}</strong><small>{metrics.pending} directional pending</small></div></div><div className="panel-footnote">MODEL CHECK · {metrics.validationPredictions} first actionable {metrics.validationPredictions === 1 ? "prediction" : "predictions"} · {metrics.settled} Gamma-settled · Brier {metrics.brierScore === null ? "collecting" : metrics.brierScore.toFixed(4)} · average edge {metrics.averageEdge === null ? "—" : percent(metrics.averageEdge)}. Only {ACTIVE_MODEL_VERSION} predictions are included.</div><div className="panel-footnote edge-check">EDGE CHECK · {metrics.edgeSamples ? <>claimed {percent(metrics.claimedEdge)} vs realized <b className={metrics.realizedEdge !== null && metrics.realizedEdge >= 0 ? "text-positive" : "text-negative"}>{percent(metrics.realizedEdge)}</b> per share · predicted win {percent(metrics.predictedWinRate)} vs actual {percent(metrics.realizedWinRate)} on {metrics.edgeSamples} settled. {metrics.edgeSamples < 100 ? "Under 100 samples, a single loss or win moves these numbers a lot." : "Trust the claimed edge only while realized keeps pace."}</> : "collecting settled predictions. A claimed edge means nothing until realized edge on settled markets keeps pace with it."}</div><div className="paper-test-times"><span>{paperAccount.positions.length} open · {paperAccount.closedTrades.length} closed · {paperAccount.fills.filter((fill) => fill.action === "BUY").length} entries</span><span>{money(equity)} shared equity · {money(accountDeployed(paperAccount))} deployed</span>{paperTest.startedAt ? <span>Started {dateTime(paperTest.startedAt)}</span> : <span>No timeframe test started</span>}{paperTest.endsAt ? <span>Ends {dateTime(paperTest.endsAt)}</span> : null}</div></article></div>
    <article className="panel unified-positions-panel"><div className="panel-heading"><div><div className="eyebrow">ONE SHARED POSITION BOOK</div><h3>All paper positions <span className="heading-muted">/ {paperAccount.positions.length} open · {paperAccount.closedTrades.length} closed</span></h3></div><div className="ledger-actions"><div className="ledger-filters" role="tablist" aria-label="Position filter">{(["ALL", "OPEN", "CLOSED"] as const).map((item) => <button aria-selected={positionFilter === item} className={positionFilter === item ? "filter-tab active" : "filter-tab"} key={item} onClick={() => setPositionFilter(item)} role="tab" type="button">{item}</button>)}</div></div></div>{positionRows.length ? <div className="positions-table-wrap unified-position-table-wrap"><table className="positions-table unified-position-table"><thead><tr><th>STATUS</th><th>TIME</th><th>MARKET</th><th>SIDE</th><th>UNITS</th><th>ENTRY</th><th>MARK / EXIT</th><th>P&amp;L</th><th>DETAIL</th></tr></thead><tbody>{positionRows.map((row) => <tr key={row.id}><td><span className={row.status === "OPEN" ? "position-state open" : "position-state closed"}>{row.status}</span></td><td>{dateTime(row.timestamp)}</td><td><strong>{row.marketLabel}</strong><small>{row.asset} · {row.duration}</small></td><td><span className={"side-chip " + (row.side === "UP" ? "up" : "down")}>{row.side}</span></td><td>{row.shares.toFixed(2)}</td><td>{cents(row.entry)}</td><td>{cents(row.mark)}</td><td className={row.pnl === null ? "text-muted" : row.pnl >= 0 ? "text-positive" : "text-negative"}>{row.pnl === null ? "—" : signedMoney(row.pnl)}</td><td><span title={row.detail}>{row.detail}</span></td></tr>)}</tbody></table></div> : <div className="account-empty-line">No positions match this filter. New manual, automatic, and timeframe-test entries will appear here.</div>}<div className="panel-footnote unified-position-note"><span><span className="status-dot status-ready" />Open positions are marked from current public bids</span><span><span className="status-dot status-sim" />Closed positions are resolved or manually exited</span><span className="footnote-spacer" /><span>Live wallet positions remain in the Account Console.</span></div></article>
    <article className="panel ledger-panel"><div className="panel-heading"><div><div className="eyebrow">ALL ACTIVE SHORT MARKETS</div><h3>Decision ledger <span className="heading-muted">/ {ledgerRows.length.toLocaleString()} rows</span></h3></div><div className="ledger-actions"><div className="ledger-filters" role="tablist" aria-label="Decision filter">{(["ALL", "UP", "DOWN", "PASS"] as const).map((item) => <button aria-selected={filter === item} className={filter === item ? "filter-tab active" : "filter-tab"} key={item} onClick={() => setFilter(item)} role="tab" type="button">{item}</button>)}</div><button className="button-secondary" disabled={!ledgerRows.length} onClick={onExport} type="button"><Download size={14} />DOWNLOAD CSV</button><button className="button-danger" disabled={!ledgerRows.length} onClick={onClearLedger} type="button"><Trash2 size={14} />CLEAR LEDGER</button></div></div>{visibleRows.length ? <div className="positions-table-wrap ledger-table-wrap"><table className="positions-table ledger-table"><thead><tr><th>TIME</th><th>MARKET</th><th>DECISION</th><th>EDGE</th><th>ASK</th><th>RESULT</th><th>DETAIL</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.id}><td>{dateTime(row.observedAt)}</td><td><strong>{row.asset} {row.duration}</strong><small>{row.question}</small></td><td><span className={"side-chip " + (row.decision === "UP" ? "up" : row.decision === "DOWN" ? "down" : "pass")}>{row.decision}</span><small>{row.tier} · {row.changeCount ? row.changeCount + " changes" : "first read"}</small></td><td>{percent(row.edge)}</td><td>{row.entryPrice === null ? "—" : (row.entryPrice * 100).toFixed(1) + "¢"}</td><td className={row.result === "WIN" ? "text-positive" : row.result === "LOSS" ? "text-negative" : row.result === "PENDING" ? "text-warning" : "text-muted"}>{row.result}{row.outcome ? " · " + row.outcome : ""}</td><td><span title={row.reason}>{row.reason}</span></td></tr>)}</tbody></table></div> : <div className="account-empty-line">No ledger rows yet. The terminal will record all discovered markets as the public feed refreshes.</div>}<div className="panel-footnote"><span><span className="status-dot status-ready" />{metrics.up} UP</span><span><span className="status-dot status-warning" />{metrics.down} DOWN</span><span><span className="status-dot status-locked" />{metrics.pass} PASS</span><span className="footnote-spacer" /><span>CSV includes IDs, UTC timestamps, crypto, duration, prices, outcomes, simulated sizing, PASS status, and UP/DOWN/combined win rates.</span></div></article>
    <article className="panel telegram-panel"><div className="panel-heading"><div><div className="eyebrow">WEEKLY REPORTS</div><h3>Telegram updates</h3></div><Send size={17} className="heading-icon" /></div>{!telegram.connected ? <><p className="panel-copy">Link a Telegram bot and chat to receive the shared paper-account summary, UP/DOWN win rates, PASS count, tracked markets, and recent ledger activity every Sunday at 9:00 PM Eastern while this terminal is open.</p><div className="telegram-form"><label><span>Bot token</span><input autoComplete="new-password" onChange={(event) => setBotToken(event.target.value)} placeholder="123456:AA…" spellCheck={false} type="password" value={botToken} /></label><label><span>Chat ID or @channel</span><input autoComplete="off" onChange={(event) => setChatId(event.target.value)} placeholder="123456789 or @channel" spellCheck={false} value={chatId} /></label></div><div className="telegram-actions"><button className="button-primary" disabled={telegramLoading || !botToken.trim() || !chatId.trim()} onClick={() => void connectTelegram()} type="button">{telegramLoading ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}LINK &amp; VERIFY TELEGRAM</button><span className="panel-footnote"><ShieldCheck size={13} /> Token is never stored in localStorage</span></div></> : <><div className="telegram-connected"><div><span className="metric-label">BOT</span><strong>@{telegram.botUsername || telegram.botName}</strong><small>{telegram.botName} · {telegram.chatTitle} · {telegram.chatId}</small></div><span className="result-badge ready"><span className="status-dot status-ready" />LINKED</span></div><div className="telegram-actions"><button className="button-secondary" onClick={onTelegramTest} type="button"><Send size={14} />SEND TEST REPORT</button><button className="button-secondary" onClick={onTelegramRefresh} type="button"><RefreshCw size={14} />REFRESH</button><button className="button-danger" onClick={onTelegramDisconnect} type="button"><X size={14} />UNLINK</button></div><div className="risk-note"><AlertTriangle size={15} /><span>Automatic weekly delivery is browser-assisted because this Site has no persistent scheduler binding. Keep the terminal open around Sunday 9:00 PM Eastern for delivery.</span></div></>}{telegram.lastError ? <div className="data-alert"><AlertTriangle size={15} /><div><strong>Telegram status</strong><span>{telegram.lastError}</span></div></div> : telegram.lastStatus ? <div className="account-empty-line"><span className="status-dot status-ready" />{telegram.lastStatus}</div> : null}</article>
  </section>;
}
