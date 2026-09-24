"use client";

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Check, LockKeyhole, Pause, Play, RefreshCw, ShieldCheck, SlidersHorizontal, Wallet, X, Zap } from "lucide-react";
import { useState } from "react";
import type { Horizon, LiveMarket } from "../lib/polymarket-data";
import { analyzeMarketSignal, estimateSidePrice, marketDataFreshnessIssue, type PaperSide } from "../lib/engines";
import { computeKellySizing, enforceLiveExecutionRisk, liveUnitUsd, type LiveRiskConfig } from "../lib/live-risk";

export type LiveSessionState = {
  connected: boolean;
  walletAddress: string;
  signerAddress: string;
  signatureType: number;
  balance: number | null;
  openOrders: number;
  expiresAt: number | null;
};

export type LiveExecutionStatus = {
  lastAction: string;
  lastDetail: string;
  lastError: string;
  lastLatencyMs: number | null;
};

export type LivePositionBrief = { id: string; tokenID: string | null; conditionId: string | null; title: string; outcome: string; size: number | null; averagePrice: number | null };

export type ManualLivePosition = LivePositionBrief & {
  market: LiveMarket;
  side: PaperSide;
  bid: number | null;
};

type Props = {
  session: LiveSessionState | null;
  running: boolean;
  paused: boolean;
  consent: boolean;
  killSwitch: boolean;
  risk: LiveRiskConfig;
  marketCount: number;
  candidateCount: number;
  status: LiveExecutionStatus;
  clock: number;
  markets: LiveMarket[];
  manualPositions: ManualLivePosition[];
  manualBusy: boolean;
  onManualEntry: (marketId: string, side: PaperSide, stakeUsd: number) => void;
  onManualExit: (position: LivePositionBrief, marketId: string, side: PaperSide, amount: number, bid: number | null) => void;
  onLink: () => void;
  onStart: () => void;
  onPause: () => void;
  onKill: () => void;
  onRefresh: () => void;
  onConsentChange: (checked: boolean) => void;
  onRiskChange: (patch: Partial<LiveRiskConfig>) => void;
};

const money = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? "—"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const percent = (value: number) => (value * 100).toFixed(value < 0.01 ? 2 : 1) + "%";
const cents = (value: number) => `${(value * 100).toFixed(1)}¢`;

const sessionTime = (expiresAt: number | null) => {
  if (!expiresAt) return "—";
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
};

export default function LiveExecutionPanel({ session, running, paused, consent, killSwitch, risk, marketCount, candidateCount, status, clock, markets, manualPositions, manualBusy, onManualEntry, onManualExit, onLink, onStart, onPause, onKill, onRefresh, onConsentChange, onRiskChange }: Props) {
  const [selectedMarketId, setSelectedMarketId] = useState("");
  const [selectedSide, setSelectedSide] = useState<PaperSide>("UP");
  const [stakeInput, setStakeInput] = useState("1.00");
  const [exitAmounts, setExitAmounts] = useState<Record<string, string>>({});
  const baseUnit = session?.balance === null || session?.balance === undefined ? null : session.balance * risk.unitBalancePct;
  const exposureCap = session?.balance === null || session?.balance === undefined ? null : session.balance * risk.maxExposurePct;
  const maxStake = Math.min(risk.maxTradeUsd, exposureCap ?? risk.maxTradeUsd);
  const canStart = Boolean(session?.connected && consent && !running && !killSwitch);
  const liveRisk = enforceLiveExecutionRisk(risk);
  const selectedMarket = markets.find((market) => market.id === selectedMarketId) ?? markets[0] ?? null;
  const stakeUsd = Number(stakeInput);
  const manualSignal = selectedMarket && Number.isFinite(stakeUsd) && stakeUsd > 0
    ? analyzeMarketSignal(selectedMarket, { feeRate: liveRisk.feeRate, slippageBps: liveRisk.slippageBps }, stakeUsd, liveRisk.minEdge, clock)
    : null;
  const marketFreshnessIssue = selectedMarket ? marketDataFreshnessIssue(selectedMarket, clock) : "No active market is available.";
  const upQuote = selectedMarket && manualSignal
    ? estimateSidePrice(selectedMarket, "UP", { feeRate: liveRisk.feeRate, slippageBps: liveRisk.slippageBps }, stakeUsd, manualSignal.fairUp)
    : null;
  const downQuote = selectedMarket && manualSignal
    ? estimateSidePrice(selectedMarket, "DOWN", { feeRate: liveRisk.feeRate, slippageBps: liveRisk.slippageBps }, stakeUsd, manualSignal.fairUp)
    : null;
  const selectedQuote = selectedSide === "UP" ? upQuote : downQuote;
  const selectedProbability = manualSignal?.fairUp === null || !manualSignal
    ? null
    : selectedSide === "UP" ? manualSignal.fairUp : 1 - manualSignal.fairUp;
  const sizing = selectedProbability !== null && selectedQuote !== null && selectedQuote.costPerShare !== null && session?.balance !== null && session?.balance !== undefined
    ? computeKellySizing(selectedProbability, selectedQuote.costPerShare, session.balance, liveRisk)
    : null;
  const maxManualStake = session?.balance === null || session?.balance === undefined ? 0 : liveUnitUsd(session.balance, liveRisk);
  const selectedPosition = selectedMarket ? manualPositions.find((position) => position.market.id === selectedMarket.id) : undefined;
  const canManualEnter = Boolean(session?.connected && selectedMarket && !running && !paused && !manualBusy && !killSwitch
    && session.openOrders === 0 && !selectedPosition && !marketFreshnessIssue && manualSignal?.fairUp !== null
    && selectedQuote?.fill && selectedQuote.netEdge !== null && selectedQuote.netEdge >= liveRisk.minEdge
    && selectedProbability !== null && sizing?.approved && stakeUsd >= 1 && stakeUsd <= maxManualStake + 1e-8
    && sizing && stakeUsd <= sizing.stakeUsd + 1e-8);
  const manualHoldReason = !session?.connected ? "Link the wallet and read its current collateral balance to enable manual orders."
    : running || paused ? "Stop the live runner before placing manual orders."
      : killSwitch ? "The kill switch is active; reset the paper risk halt first."
        : session.openOrders > 0 ? "Cancel or reconcile the open CLOB order before manual entry."
          : selectedPosition ? "A position already exists in this market; use the position panel to manage it."
            : marketFreshnessIssue ?? (manualSignal?.fairUp === null || !manualSignal ? "The model probability is unavailable for this market." : null)
              ?? (!selectedQuote?.fill ? "The visible ask ladder cannot fill this stake." : null)
              ?? (selectedQuote?.netEdge === null || selectedQuote?.netEdge === undefined ? "The all-in quote is incomplete." : selectedQuote.netEdge < liveRisk.minEdge ? `Net edge is below the ${percent(liveRisk.minEdge)} live minimum.` : null)
              ?? (!sizing?.approved ? sizing?.reason ?? "The bankroll cap blocks this stake." : stakeUsd < 1 ? "Live orders require at least $1." : stakeUsd > maxManualStake + 1e-8 ? `The current account unit is capped at ${money(maxManualStake)}.` : stakeUsd > (sizing?.stakeUsd ?? 0) + 1e-8 ? `Model sizing allows ${money(sizing?.stakeUsd ?? 0)} at most.` : null);
  const toggleDuration = (duration: Horizon) => {
    const enabled = risk.allowedDurations.includes(duration);
    const next = enabled ? risk.allowedDurations.filter((item) => item !== duration) : [...risk.allowedDurations, duration];
    onRiskChange({ allowedDurations: next.length ? next : [duration] });
  };

  return (
    <section className="live-executor">
      <div className="section-heading">
        <div>
          <div className="eyebrow">LIVE EXECUTOR</div>
          <h2>Balance-aware order runner</h2>
          <p className="section-subtitle">Optional real-money execution for active Polymarket crypto 5m and 15m markets. Every order is revalidated on the server immediately before submission.</p>
        </div>
        <span className={"result-badge " + (session?.connected ? "ready" : "waiting")}>
          <span className={"status-dot " + (session?.connected ? "status-ready" : "status-locked")} />
          {session?.connected ? "LIVE SESSION" : "LOCKED"}
        </span>
      </div>

      {!session?.connected ? (
        <article className="panel live-lock-panel">
          <div className="live-lock-icon"><LockKeyhole size={23} /></div>
          <div>
            <h3>Link a wallet to arm live execution</h3>
            <p>Linking uses your private key once to derive Polymarket CLOB credentials. The browser clears the raw key after the encrypted short-lived session is established; live actions are restricted to the signed-in owner account.</p>
            <div className="gate-list">
              <div><Check size={15} /><span>Fresh Gamma market + CLOB book validation</span><b className="gate-pass">ON</b></div>
              <div><Check size={15} /><span>Balance, units, fractional Kelly, and exposure caps</span><b className="gate-pass">ON</b></div>
              <div><X size={15} /><span>Guaranteed fills or profit</span><b className="gate-pending">NEVER</b></div>
            </div>
            <button className="button-primary" onClick={onLink} type="button"><Wallet size={14} />LINK POLYMARKET WALLET</button>
          </div>
        </article>
      ) : (
        <>
          <div className="live-stat-grid">
            <article className="live-stat-card"><span>AVAILABLE USDC</span><strong>{money(session.balance)}</strong><small>fresh CLOB collateral</small></article>
            <article className="live-stat-card"><span>BASE UNIT</span><strong>{money(baseUnit)}</strong><small>{percent(risk.unitBalancePct)} of balance</small></article>
            <article className="live-stat-card"><span>MAX STAKE</span><strong>{money(maxStake)}</strong><small>Kelly + exposure capped</small></article>
            <article className="live-stat-card"><span>SESSION TTL</span><strong>{sessionTime(session.expiresAt)}</strong><small>{session.openOrders} open CLOB orders</small></article>
          </div>

          <div className="live-grid">
            <article className="panel live-control-card">
              <div className="panel-heading">
                <div><div className="eyebrow">EXECUTION CONTROL</div><h3>{running ? paused ? "Live runner paused" : "Live runner active" : "Live runner standby"}</h3></div>
                <span className={"feed-live " + (running && !paused ? "live-active" : "")}><span className={"status-dot " + (running && !paused ? "status-ready" : paused ? "status-warning" : "status-locked")} />{running ? paused ? "PAUSED" : "ARMED" : "STANDBY"}</span>
              </div>
              <div className="live-control-summary"><span><b>{marketCount}</b> validated markets</span><span><b>{candidateCount}</b> current candidates</span><span><b>{risk.allowedDurations.join(" + ")}</b> duration filter</span></div>
              <label className="live-consent"><input checked={consent} onChange={(event) => onConsentChange(event.target.checked)} type="checkbox" /><span>I understand this can place real orders using the linked wallet and that market orders can fill at variable prices.</span></label>
              <div className="live-actions">
                <button className="button-primary" disabled={!canStart} onClick={onStart} type="button"><Play fill="currentColor" size={14} />{running ? "RUNNING" : "START LIVE"}</button>
                <button className="button-secondary" disabled={!running} onClick={onPause} type="button"><Pause size={14} />{paused ? "RESUME" : "PAUSE"}</button>
                <button className="button-secondary" disabled={running} onClick={onRefresh} type="button"><RefreshCw size={14} />REFRESH BALANCE</button>
                <button className="button-danger" onClick={onKill} type="button"><Zap size={14} />KILL + CANCEL ALL</button>
              </div>
              <div className="live-session-line"><ShieldCheck size={14} /><span>{session.walletAddress.slice(0, 6)}…{session.walletAddress.slice(-4)} · signer {session.signerAddress.slice(0, 6)}…{session.signerAddress.slice(-4)} · signature type {session.signatureType}</span></div>
              <div className="risk-note"><AlertTriangle size={15} /><span>A linked session does not enable orders. The server must pass its separate live-order gate, and it enforces the final $5 per-order and 10% exposure caps.</span></div>
            </article>

            <article className="panel live-risk-card">
              <div className="panel-heading"><div><div className="eyebrow">LIVE RISK POLICY</div><h3>Units + fractional Kelly</h3></div><SlidersHorizontal size={17} className="heading-icon" /></div>
              <div className="duration-toggles"><span>MARKET DURATIONS</span>{(["5m", "15m"] as Horizon[]).map((duration) => <button className={risk.allowedDurations.includes(duration) ? "duration-toggle active" : "duration-toggle"} key={duration} onClick={() => toggleDuration(duration)} type="button">{duration}</button>)}</div>
              <div className="risk-controls live-risk-controls">
                <label className="range-control"><span><b>Units per trade</b><em>{risk.unitsPerTrade.toFixed(2)}u</em></span><input max="1" min="0.25" onChange={(event) => onRiskChange({ unitsPerTrade: Number(event.target.value) })} step="0.25" type="range" value={risk.unitsPerTrade} /></label>
                <label className="range-control"><span><b>Kelly fraction</b><em>{percent(risk.kellyFraction)}</em></span><input max="0.25" min="0.05" onChange={(event) => onRiskChange({ kellyFraction: Number(event.target.value) })} step="0.05" type="range" value={risk.kellyFraction} /></label>
                <label className="range-control"><span><b>Unit / balance</b><em>{percent(risk.unitBalancePct)}</em></span><input max="0.01" min="0.0025" onChange={(event) => onRiskChange({ unitBalancePct: Number(event.target.value) })} step="0.0025" type="range" value={risk.unitBalancePct} /></label>
                <label className="range-control"><span><b>Max trade USD</b><em>{money(risk.maxTradeUsd)}</em></span><input max="5" min="1" onChange={(event) => onRiskChange({ maxTradeUsd: Number(event.target.value) })} step="1" type="range" value={risk.maxTradeUsd} /></label>
                <label className="range-control"><span><b>Max exposure / balance</b><em>{percent(risk.maxExposurePct)}</em></span><input max="0.1" min="0.01" onChange={(event) => onRiskChange({ maxExposurePct: Number(event.target.value) })} step="0.01" type="range" value={risk.maxExposurePct} /></label>
                <label className="range-control"><span><b>Minimum net edge</b><em>{percent(risk.minEdge)}</em></span><input max="0.25" min="0.04" onChange={(event) => onRiskChange({ minEdge: Number(event.target.value) })} step="0.01" type="range" value={risk.minEdge} /></label>
              </div>
              <label className="live-checkbox"><input checked={risk.requireLock} disabled type="checkbox" /><span>Require LOCK tier before live submission (server enforced)</span></label>
              <div className="risk-note"><ShieldCheck size={15} /><span>Full Kelly is reduced by the selected fraction, then capped by unit size, max trade, exposure, balance, and a $1 minimum.</span></div>
            </article>
          </div>

          <article className="panel manual-trading-panel">
            <div className="panel-heading"><div><div className="eyebrow">MANUAL TRADING</div><h3>Model edge · your entries and exits</h3></div><span className="panel-footnote"><LockKeyhole size={13} /> Server rechecks each order</span></div>
            <p className="manual-trading-intro">Choose UP or DOWN and size the order yourself. The card separates raw candle-model edge from the book-anchored edge used by the runner. Manual FAK orders may partially fill or not fill.</p>
            {running ? <div className="manual-stop-note"><AlertTriangle size={15} />Stop the live runner before placing manual orders.</div> : null}
            <div className="manual-trading-grid">
              <div className="manual-entry-column">
                <div className="manual-entry-controls">
                  <label className="manual-select"><span>MARKET</span><select value={selectedMarket?.id ?? ""} onChange={(event) => setSelectedMarketId(event.target.value)}>{markets.map((market) => <option key={market.id} value={market.id}>{market.asset} {market.duration} · {market.question}</option>)}</select></label>
                  <label className="manual-stake-input"><span>STAKE · MAX {money(maxManualStake)}</span><div><b>$</b><input inputMode="decimal" max={maxManualStake} min="1" onChange={(event) => setStakeInput(event.target.value)} step="0.25" type="number" value={stakeInput} /></div></label>
                </div>
                <div className="manual-reference-row"><span>TIME LEFT <b>{selectedMarket ? `${Math.floor(selectedMarket.remaining / 60).toString().padStart(2, "0")}:${String(selectedMarket.remaining % 60).padStart(2, "0")}` : "—"}</b></span><span>PRICE TO BEAT <b>{selectedMarket?.referenceVerified && selectedMarket.referenceSource === "POLYMARKET" ? money(selectedMarket.reference) : "pending exact tick"}</b></span><span>ORACLE NOW <b>{selectedMarket?.spotSource === "POLYMARKET" && selectedMarket.spotUpdatedAt !== null && clock - selectedMarket.spotUpdatedAt <= 10_000 ? money(selectedMarket.spot) : "stale"}</b></span></div>
                <div className="manual-probability-grid">
                  <div><span>RAW MODEL P(UP)</span><strong>{marketFreshnessIssue ? "—" : percent(selectedMarket?.fairUp ?? NaN)}</strong></div>
                  <div><span>BOOK MID P(UP)</span><strong>{marketFreshnessIssue ? "—" : percent(manualSignal?.marketProbabilityUp ?? NaN)}</strong></div>
                  <div><span>BOOK-ANCHORED P(UP)</span><strong>{marketFreshnessIssue ? "—" : percent(manualSignal?.fairUp ?? NaN)}</strong></div>
                </div>
                <div className="manual-side-tabs" role="tablist" aria-label="Manual position side">
                  {(["UP", "DOWN"] as PaperSide[]).map((side) => {
                    const quote = side === "UP" ? upQuote : downQuote;
                    const active = selectedSide === side;
                    return <button aria-selected={active} className={`${active ? "active " : ""}${side === "UP" ? "manual-up" : "manual-down"}`} key={side} onClick={() => setSelectedSide(side)} role="tab" type="button">{side === "UP" ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{side}<b>{quote?.netEdge == null || marketFreshnessIssue ? "—" : `${(quote.netEdge * 100).toFixed(1)}pp`}</b></button>;
                  })}
                </div>
                <div className="manual-quote-grid">
                  {(["UP", "DOWN"] as PaperSide[]).map((side) => {
                    const quote = side === "UP" ? upQuote : downQuote;
                    const rawModelSide = selectedMarket?.fairUp === null || !selectedMarket ? null : side === "UP" ? selectedMarket.fairUp : 1 - selectedMarket.fairUp;
                    const rawNet = quote?.rawModelNetEdge ?? null;
                    return <div className={side === selectedSide ? "manual-quote-card selected" : "manual-quote-card"} key={side}>
                      <span>{side} · BEST ASK {quote?.bestAsk == null || marketFreshnessIssue ? "—" : cents(quote.bestAsk)}</span>
                      <strong className={rawNet === null || marketFreshnessIssue ? "text-muted" : rawNet >= 0 ? "text-positive" : "text-negative"}>RAW MODEL NET EDGE {rawNet === null || marketFreshnessIssue ? "—" : `${(rawNet * 100).toFixed(1)}pp`}</strong>
                      <small>raw P {rawModelSide === null || marketFreshnessIssue ? "—" : percent(rawModelSide)} − all-in cost/share, at {money(stakeUsd)}</small>
                      <small>average fill {quote?.averagePrice == null || marketFreshnessIssue ? "—" : cents(quote.averagePrice)} · all-in {quote?.costPerShare == null || marketFreshnessIssue ? "—" : cents(quote.costPerShare)} / share</small>
                      <small>ask walk + slippage {quote?.averagePrice == null || quote.bestAsk == null || marketFreshnessIssue ? "—" : cents(Math.max(0, quote.averagePrice - quote.bestAsk))} · fee {quote?.feePerShare == null || marketFreshnessIssue ? "—" : cents(quote.feePerShare)} / share</small>
                      <small className="manual-consensus-edge">BOOK-ANCHORED NET EDGE AT {money(stakeUsd)}: {quote?.netEdge == null || marketFreshnessIssue ? "—" : `${(quote.netEdge * 100).toFixed(1)}pp`}</small>
                    </div>;
                  })}
                </div>
                <div className="manual-entry-footer">
                  <span>{manualHoldReason}</span>
                  <button className="button-primary" disabled={!canManualEnter} onClick={() => selectedMarket && onManualEntry(selectedMarket.id, selectedSide, stakeUsd)} type="button">{manualBusy ? "SUBMITTING…" : `BUY ${selectedSide} · ${money(stakeUsd)}`}</button>
                </div>
                {selectedProbability !== null && sizing ? <div className="manual-sizing-note">Model stake cap {money(sizing.stakeUsd)} · account unit {money(maxManualStake)} · minimum edge {percent(liveRisk.minEdge)}. Server sizing can further reduce the order.</div> : null}
              </div>
              <div className="manual-position-column">
                <div className="eyebrow">OPEN WALLET POSITIONS</div>
                {!manualPositions.length ? <div className="manual-empty-position">No active UP/DOWN positions match current markets.</div> : manualPositions.map((position) => {
                  const amount = Number(exitAmounts[position.tokenID ?? position.id] ?? String(position.size ?? 0));
                  const validAmount = Number.isFinite(amount) && amount > 0 && amount <= (position.size ?? 0) + 1e-8;
                  return <div className="manual-position-card" key={position.id}>
                    <div className="manual-position-heading"><strong>{position.market.asset} {position.market.duration} · {position.side}</strong><span>{money(position.averagePrice)} entry</span></div>
                    <div className="manual-position-market">{position.market.question}</div>
                    <div className="manual-position-values"><span>SHARES <b>{(position.size ?? 0).toFixed(4)}</b></span><span>BEST BID <b>{position.bid === null ? "—" : cents(position.bid)}</b></span></div>
                    <label className="manual-exit-input"><span>SHARES TO SELL</span><input inputMode="decimal" max={position.size ?? undefined} min="0.0001" onChange={(event) => setExitAmounts((current) => ({ ...current, [position.tokenID ?? position.id]: event.target.value }))} step="0.0001" type="number" value={exitAmounts[position.tokenID ?? position.id] ?? String(position.size ?? "")} /></label>
                    <button className="button-secondary manual-sell-button" disabled={!session?.connected || running || paused || manualBusy || killSwitch || !validAmount || position.bid === null} onClick={() => onManualExit(position, position.market.id, position.side, amount, position.bid)} type="button">{manualBusy ? "WORKING…" : `SELL ${validAmount ? amount.toFixed(4) : "—"} SHARES`}</button>
                  </div>;
                })}
                <div className="manual-sizing-note">Manual sells use the current live bid and a slippage floor. Settlement or already-expired positions are handled in Account.</div>
              </div>
            </div>
          </article>

          <article className="panel live-risk-card early-exit-card">
            <div className="panel-heading"><div><div className="eyebrow">MODEL-AWARE CASHOUT</div><h3>Protect profitable positions</h3></div><ShieldCheck size={17} className="heading-icon" /></div>
            <label className="live-checkbox"><input checked={risk.earlyExitEnabled} onChange={(event) => onRiskChange({ earlyExitEnabled: event.target.checked })} type="checkbox" /><span>Enable automatic early exits for live positions</span></label>
            <div className="risk-controls live-risk-controls">
              <label className="range-control"><span><b>Minimum cashout USD</b><em>{money(risk.earlyExitMinProfitUsd)}</em></span><input disabled={!risk.earlyExitEnabled} max="50" min="2" onChange={(event) => onRiskChange({ earlyExitMinProfitUsd: Number(event.target.value) })} step="1" type="range" value={risk.earlyExitMinProfitUsd} /></label>
              <label className="range-control"><span><b>Minimum profit</b><em>{percent(risk.earlyExitMinProfitPct)}</em></span><input disabled={!risk.earlyExitEnabled} max="1" min="0.1" onChange={(event) => onRiskChange({ earlyExitMinProfitPct: Number(event.target.value) })} step="0.05" type="range" value={risk.earlyExitMinProfitPct} /></label>
              <label className="range-control"><span><b>Bid above model by</b><em>{percent(risk.earlyExitModelGap)}</em></span><input disabled={!risk.earlyExitEnabled} max="0.15" min="0.03" onChange={(event) => onRiskChange({ earlyExitModelGap: Number(event.target.value) })} step="0.01" type="range" value={risk.earlyExitModelGap} /></label>
              <label className="range-control"><span><b>Confirmations</b><em>{risk.earlyExitConfirmations} ticks</em></span><input disabled={!risk.earlyExitEnabled} max="4" min="2" onChange={(event) => onRiskChange({ earlyExitConfirmations: Number(event.target.value) })} step="1" type="range" value={risk.earlyExitConfirmations} /></label>
              <label className="range-control"><span><b>Minimum time left</b><em>{risk.earlyExitMinRemainingSeconds}s</em></span><input disabled={!risk.earlyExitEnabled} max="300" min="30" onChange={(event) => onRiskChange({ earlyExitMinRemainingSeconds: Number(event.target.value) })} step="15" type="range" value={risk.earlyExitMinRemainingSeconds} /></label>
            </div>
            <div className="risk-note"><ShieldCheck size={15} /><span>It sells only after the current executable bid is above the model fair value by the configured gap and the position clears both profit thresholds on repeated ticks. The server rechecks everything before selling.</span></div>
          </article>

          <article className="panel live-status-card">
            <div className="panel-heading"><div><div className="eyebrow">ORDER STATUS</div><h3>Execution audit</h3></div><span className="panel-footnote"><LockKeyhole size={13} /> Server validated</span></div>
            {status.lastError ? <div className="data-alert"><AlertTriangle size={15} /><div><strong>Runner stopped safely</strong><span>{status.lastError}</span></div></div> : <div className="live-status-row"><span className="status-dot status-ready" /><strong>{status.lastAction || "No live order attempted"}</strong><span>{status.lastDetail || "Start remains opt-in and locked until you confirm the risk notice."}</span><b>{status.lastLatencyMs === null ? "—" : String(status.lastLatencyMs) + " ms"}</b></div>}
            <div className="risk-note"><AlertTriangle size={15} /><span>Keep this tab open while the browser loop is active. A closed or sleeping tab stops new submissions; it does not create a background 24/7 trading process.</span></div>
          </article>
        </>
      )}
    </section>
  );
}
