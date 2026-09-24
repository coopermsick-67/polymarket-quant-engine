#!/usr/bin/env node

const statusUrl = process.env.PQE_STATUS_URL || "http://127.0.0.1:8788/status";
const refreshMs = boundedInteger(process.env.PQE_DASHBOARD_REFRESH_MS, 1000, 1000, 30000);
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const color = (code, value) => useColor ? `\u001b[${code}m${value}\u001b[0m` : String(value);

function boundedInteger(raw, fallback, min, max) {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function money(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function signedMoney(value) {
  if (!Number.isFinite(value)) return "—";
  const formatted = `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
  return color(value >= 0 ? "32" : "31", formatted);
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function clock(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : "—";
}

function age(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function countdown(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function liveSignalCountdown(seconds, updatedAt) {
  if (!Number.isFinite(seconds)) return "—";
  const elapsed = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 1000 : 0;
  return countdown(Math.max(0, seconds - elapsed));
}

function positionCountdown(position) {
  if (Number.isFinite(position?.endTime)) return countdown(Math.max(0, (position.endTime - Date.now()) / 1000));
  return countdown(position?.secondsRemaining);
}

function stateLabel(action) {
  if (action === "UP") return color("32", action);
  if (action === "DOWN") return color("33", action);
  return color("90", action || "PASS");
}

function equitySparkline(history) {
  const points = Array.isArray(history) ? history.map((point) => point?.equity).filter(Number.isFinite).slice(-36) : [];
  if (points.length < 2) return "(collecting history)";
  const chars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...points);
  const max = Math.max(...points);
  if (max === min) return chars[0].repeat(points.length);
  return points.map((point) => chars[Math.min(chars.length - 1, Math.floor(((point - min) / (max - min)) * chars.length))]).join("");
}

function clipLine(value, width) {
  const plain = value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  if (plain.length <= width) return value;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

let currentPage = 0;

function render(data, connectionError) {
  const width = Math.max(40, (process.stdout.columns || 100) - 1);
  const paper = data?.paper ?? {};
  const bankroll = data?.bankroll ?? {};
  const positions = Array.isArray(paper.positions) ? paper.positions : [];
  const fills = Array.isArray(paper.recentFills) ? paper.recentFills : [];
  const closedTrades = Array.isArray(paper.recentClosedTrades) ? paper.recentClosedTrades : [];
  const signals = Array.isArray(data?.topSignals) ? data.topSignals : [];
  const controls = data?.controls ?? {};
  const streams = data?.streams ?? {};
  const booksState = !streams.clobRequired ? "idle" : streams.clobConnected ? "LIVE" : "down";
  const tradingState = data?.tradingState || data?.readiness || "CONNECTING";
  const usableMarkets = data?.dataQuality?.usableMarkets ?? data?.usableMarkets ?? 0;
  const stateColor = tradingState === "PAPER_RUNNING" ? "32" : ["WAITING_FOR_DATA", "PAUSED"].includes(tradingState) ? "33" : "31";
  const lines = [
    color("1;36", "POLYMARKET QUANT ENGINE  ·  PAPER"),
    `Page ${currentPage + 1}/2  |  n/p page  r refresh  q quit  |  ${new Date().toLocaleTimeString()}`,
    `SERVICE ${data?.process || "unavailable"}  ${data?.mode || "unknown"}  ${color(stateColor, tradingState)}`,
    `DATA ${usableMarkets}/${data?.marketsTracked ?? 0} usable  readiness ${data?.readiness || "?"}  fresh ${age(data?.lastHealthyDataAgeMs)}  cycle ${clock(data?.lastCycleAt)}`,
    `STREAM oracle ${streams.polymarketPriceConnected ? "LIVE" : "down"} ${age(streams.officialPriceAgeMs)}  research ${streams.coinbaseConnected ? "LIVE" : "down"}  books ${booksState} ${age(streams.clobUpdateAgeMs)}`,
    `HALTS pause ${controls.paused ? "ON" : "off"}  kill ${controls.killed ? "ON" : "off"}  stale ${controls.staleDataHalt ? "ON" : "off"}  risk ${controls.riskHalt ? "ON" : "off"}  recon ${data?.reconciliation || "?"}`,
  ];

  if (connectionError) lines.push(color("31", `ENDPOINT ${connectionError}`));
  if (data?.lastError) lines.push(color("31", `CYCLE ERROR ${data.lastError}`));

  if (currentPage === 0) {
    lines.push("", color("1", "PAPER ACCOUNT"));
    lines.push(`Cash ${money(paper.cash)}  |  Equity ${money(paper.equity)}`);
    lines.push(`P&L realized ${signedMoney(paper.realizedPnl)}  |  open ${signedMoney(paper.unrealizedPnl)}  |  total ${signedMoney(paper.totalPnl)}`);
    lines.push(`Start ${money(paper.startingCash)}  |  deployed ${money(paper.deployed)}  |  fees ${money(paper.fees)}  |  win ${pct(paper.winRate)}`);
    lines.push(`PROFILE ${bankroll.tier || "—"}  ${bankroll.riskState || "—"}  ${bankroll.smallAccountProtectionActive ? "small-account protection ON" : ""}`);
    lines.push(`Liquidation ${money(bankroll.liquidationEquity)}  reserve ${money(bankroll.reserveUsd)}  max trade ${money(bankroll.maximumStakeUsd)}`);
    lines.push(`Exposure ${money(bankroll.deployedUsd)} / ${money(bankroll.maximumExposureUsd)}  correlated ${money(bankroll.correlatedExposureUsd)} / ${money(bankroll.maximumCorrelatedExposureUsd)}`);
    lines.push(`Loss room ${money(bankroll.dailyLossRemainingUsd)}  streak ${bankroll.consecutiveLossesToday ?? "—"}  ${bankroll.riskReason || ""}`);
    lines.push(`Equity ${equitySparkline(paper.equityHistory)}`);
    lines.push("", color("1", `OPEN POSITIONS (${positions.length})`));
    if (positions.length === 0) lines.push(color("90", "  none"));
    for (const position of positions.slice(0, 2)) {
      const label = `${position.marketLabel || position.asset || "Market"} ${position.side || ""}`.trim();
      lines.push(`  ${label}  ${Number(position.shares || 0).toFixed(2)} sh  closes ${positionCountdown(position)}`);
      lines.push(`  entry ${money(position.avgEntry)}  mark ${money(position.mark)}  value ${money(position.markValue)}  uPnL ${signedMoney(position.unrealizedPnl)}`);
    }
    if (positions.length > 2) lines.push(color("90", `  ${positions.length - 2} more; /status has all positions`));
    lines.push("", color("1", "RECENT CLOSED TRADES"));
    if (closedTrades.length === 0) lines.push(color("90", "  none"));
    for (const trade of closedTrades.slice(0, 3)) {
      const label = `${trade.marketLabel || trade.asset || "Market"} ${trade.side || ""}`.trim();
      lines.push(`  ${clock(trade.timestamp)}  ${label}  ${money(trade.entry)}>${money(trade.exit)}  ${signedMoney(trade.pnl)}`);
    }
  } else {
    lines.push("", color("1", `CURRENT SIGNALS (${signals.length})`));
    const sizing = data?.betSizing;
    if (sizing) lines.push(`PROFILE ${bankroll.tier || "—"}  max trade ${pct(sizing.maximumBetPct)}  min ${money(sizing.minimumBetUsd)}  exposure cap ${pct(sizing.maximumExposurePct)}`);
    if (signals.length === 0) lines.push(color("90", "  waiting for complete fresh data"));
    for (const signal of signals.slice(0, 8)) {
      const edge = Number.isFinite(signal.edge) ? `${(signal.edge * 100).toFixed(1)}%` : "—";
      const confidence = Number.isFinite(signal.confidence) ? pct(signal.confidence) : "—";
      lines.push(`  ${stateLabel(signal.action)}  ${signal.marketLabel}  edge ${edge}  score ${Number(signal.opportunityScore || 0).toFixed(1)}  bet ${money(signal.targetBetUsd)}  EV ${money(signal.expectedNetProfitUsd)}  ${liveSignalCountdown(signal.remainingSeconds, data?.signalsUpdatedAt)}`);
      lines.push(`    ${signal.entryAllowed ? "ENTRY" : "PASS"}  P(up) ${pct(signal.fairProbability)} (raw model ${pct(signal.rawModelProbability)})  market ${pct(signal.marketProbability)}  spread ${pct(signal.spread)}  depth ${money(signal.availableDepthUsd)}  ${confidence} direction`);
      if (signal.reason) lines.push(`    ${signal.reason}`);
    }
    lines.push("", color("1", `RECENT FILLS (${paper.totalFills ?? fills.length})`));
    if (fills.length === 0) lines.push(color("90", "  none"));
    for (const fill of fills.slice(0, 5)) {
      const label = `${fill.marketLabel || fill.asset || "Market"} ${fill.side || ""}`.trim();
      const action = fill.action === "BUY" ? color("32", "BUY") : color("33", "SELL");
      lines.push(`  ${clock(fill.timestamp)} ${action} ${label} ${Number(fill.shares || 0).toFixed(2)}sh @${money(fill.price)} fee ${money(fill.fee)}`);
    }
  }

  lines.push("", color("90", "Simulation only; this display never places orders."));
  process.stdout.write(`\u001b[2J\u001b[H${lines.map((line) => clipLine(line, width)).join("\n")}\n`);
}

if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
  process.stderr.write("Run the dashboard in an interactive terminal (PowerShell, Windows Terminal, or a regular Linux/macOS terminal).\n");
  process.exit(2);
}

let latestData = null;
let connectionError = null;
let inFlight = false;
let stopped = false;
let timer;
let displayTimer;

function endpointError(error) {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  const detail = error instanceof Error ? error.message : "connection failed";
  if (detail.toLowerCase().includes("fetch failed") || detail.toLowerCase().includes("econnrefused")) {
    return `daemon not reachable at ${statusUrl}; run pnpm run daemon in a second terminal${cause}`;
  }
  return `${detail}${cause}`;
}

async function refresh() {
  if (inFlight || stopped) return;
  inFlight = true;
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    latestData = await response.json();
    connectionError = null;
  } catch (error) {
    connectionError = endpointError(error);
  } finally {
    inFlight = false;
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  clearInterval(displayTimer);
  process.stdin.off("data", onInput);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\u001b[?25h\nDashboard closed; the daemon continues running.\n");
}

function onInput(buffer) {
  const key = buffer.toString("utf8").toLowerCase();
  if (key === "q" || key === "\u0003") shutdown();
  else if (key === "r") void refresh().then(() => render(latestData, connectionError));
  else if (key === "n") { currentPage = 1; render(latestData, connectionError); }
  else if (key === "p") { currentPage = 0; render(latestData, connectionError); }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", onInput);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.stdout.write("\u001b[?25l");
render(latestData, connectionError);
void refresh();
timer = setInterval(() => void refresh(), refreshMs);
displayTimer = setInterval(() => render(latestData, connectionError), 1000);
