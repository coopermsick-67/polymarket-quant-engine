"use client";

import { AlertTriangle, Check, LockKeyhole, RefreshCw, ShieldCheck, SlidersHorizontal, Wallet, X, Zap } from "lucide-react";
import { LIVE_EXECUTION_DISABLED_REASON, type LiveRiskConfig } from "../lib/live-risk";
import type { Horizon, SignalParams } from "../lib/signal";
import { dollars, percentage, points } from "./format";

export type LiveSessionState = {
  connected: boolean;
  walletAddress: string;
  signerAddress: string;
  signatureType: number;
  keySource: "server" | "browser";
  balance: number | null;
  openOrders: number;
  expiresAt: number | null;
};

export type LiveExecutionStatus = { lastAction: string; lastDetail: string; lastError: string; lastLatencyMs: number | null };

export type LiveRiskPatch = Omit<Partial<LiveRiskConfig>, "signal"> & { signal?: Partial<SignalParams> };

type Props = {
  session: LiveSessionState | null;
  risk: LiveRiskConfig;
  marketCount: number;
  status: LiveExecutionStatus;
  now: number;
  onLink: () => void;
  onKill: () => void;
  onRefresh: () => void;
  onRiskChange: (patch: LiveRiskPatch) => void;
};

const ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "ZEC"];

const Range = ({
  label,
  value,
  display,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) => (
  <label className="range-control">
    <span>
      <b>{label}</b>
      <em>{display}</em>
    </span>
    <input disabled={disabled} max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="range" value={value} />
  </label>
);

export default function LiveExecutionPanel({ session, risk, marketCount, status, now, onLink, onKill, onRefresh, onRiskChange }: Props) {
  const balance = session?.balance ?? null;
  const unitCap = balance === null ? null : Math.min(balance * risk.unitBalancePct * risk.unitsPerTrade, risk.maxTradeUsd);
  const ttl = session?.expiresAt ? Math.max(0, Math.floor((session.expiresAt - now) / 1000)) : null;
  const toggle = <T extends string>(list: T[], item: T) => (list.includes(item) ? list.filter((value) => value !== item) : [...list, item]);

  return (
    <section className="live-executor">
      <div className="section-heading">
        <div>
          <div className="eyebrow">LIVE EXECUTOR</div>
          <h2>Live order submission is disabled</h2>
          <p className="section-subtitle">
            The browser does not run an order loop. Buys and sells remain blocked until the out-of-sample strategy and execution safety evidence gates pass.
            Account reads and an explicit cancel-all request remain available for reconciliation.
          </p>
          <p className="live-disabled-note">{LIVE_EXECUTION_DISABLED_REASON}</p>
        </div>
        <span className={`result-badge ${session?.connected ? "ready" : "waiting"}`}>
          <span className={`status-dot ${session?.connected ? "status-ready" : "status-locked"}`} />
          {session?.connected ? `LIVE SESSION · ${session.keySource === "server" ? "SERVER KEY" : "BROWSER KEY"}` : "LOCKED"}
        </span>
      </div>

      {!session?.connected ? (
        <article className="panel live-lock-panel">
          <div className="live-lock-icon">
            <LockKeyhole size={23} />
          </div>
          <div>
            <h3>Link an account to view its status</h3>
            <p>
              Account linking enables balance and position reads plus an explicit cancel-all request. It does not enable order placement. If you link an
              account, configure POLYMARKET_PRIVATE_KEY and POLYMARKET_WALLET_ADDRESS on the server so the key never enters the browser.
            </p>
            <div className="gate-list">
              <div>
                <Check size={15} />
                <span>Official price to beat + Chainlink-anchored settlement model</span>
                <b className="gate-pass">ON</b>
              </div>
              <div>
                <Check size={15} />
                <span>Limit price, exposure, correlation, daily loss, rate limit</span>
                <b className="gate-pass">ON</b>
              </div>
              <div>
                <X size={15} />
                <span>Guaranteed fills or profit</span>
                <b className="gate-pending">NEVER</b>
              </div>
            </div>
            <button className="button-primary" onClick={onLink} type="button">
              <Wallet size={14} />
              LINK POLYMARKET WALLET
            </button>
          </div>
        </article>
      ) : (
        <>
          <div className="live-stat-grid">
            <article className="live-stat-card">
              <span>AVAILABLE USDC</span>
              <strong>{dollars(balance)}</strong>
              <small>CLOB collateral</small>
            </article>
            <article className="live-stat-card">
              <span>MAX STAKE</span>
              <strong>{dollars(unitCap)}</strong>
              <small>before Kelly + depth caps</small>
            </article>
            <article className="live-stat-card">
              <span>DAILY LOSS STOP</span>
              <strong>{percentage(risk.dailyLossPct)}</strong>
              <small>server-enforced, persisted</small>
            </article>
            <article className="live-stat-card">
              <span>SESSION TTL</span>
              <strong>{ttl === null ? "—" : `${Math.floor(ttl / 60)}m ${String(ttl % 60).padStart(2, "0")}s`}</strong>
              <small>{session.openOrders} open CLOB orders</small>
            </article>
          </div>
          <div className="live-grid">
            <article className="panel live-control-card">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">EXECUTION CONTROL</div>
                  <h3>Order placement blocked</h3>
                </div>
                <span className="feed-live">
                  <span className="status-dot status-locked" />
                  DISABLED
                </span>
              </div>
              <div className="live-control-summary">
                <span>
                  <b>{marketCount}</b> active markets
                </span>
                <span>
                  <b>{session.openOrders}</b> open CLOB orders
                </span>
                <span>
                  <b>{risk.allowedAssets.join(" ")}</b>
                </span>
              </div>
              <div className="live-actions">
                <button className="button-secondary" onClick={onRefresh} type="button">
                  <RefreshCw size={14} />
                  REFRESH ACCOUNT
                </button>
                <button className="button-danger" onClick={onKill} type="button">
                  <Zap size={14} />
                  KILL + CANCEL ALL
                </button>
              </div>
              <div className="live-session-line">
                <ShieldCheck size={14} />
                <span>
                  {session.walletAddress.slice(0, 6)}…{session.walletAddress.slice(-4)} · signer {session.signerAddress.slice(0, 6)}…
                  {session.signerAddress.slice(-4)} · type {session.signatureType}
                </span>
              </div>
            </article>
            <article className="panel live-risk-card">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">LIVE RISK POLICY</div>
                  <h3>Edge, sizing, portfolio</h3>
                </div>
                <SlidersHorizontal size={17} className="heading-icon" />
              </div>
              <div className="duration-toggles">
                <span>DURATIONS</span>
                {(["5m", "15m"] as Horizon[]).map((duration) => (
                  <button
                    className={risk.allowedDurations.includes(duration) ? "duration-toggle active" : "duration-toggle"}
                    key={duration}
                    onClick={() => onRiskChange({ allowedDurations: toggle(risk.allowedDurations, duration) })}
                    type="button"
                  >
                    {duration}
                  </button>
                ))}
              </div>
              <div className="duration-toggles">
                <span>ASSETS</span>
                {ASSETS.map((asset) => (
                  <button
                    className={risk.allowedAssets.includes(asset) ? "duration-toggle active" : "duration-toggle"}
                    key={asset}
                    onClick={() => onRiskChange({ allowedAssets: toggle(risk.allowedAssets, asset) })}
                    type="button"
                  >
                    {asset}
                  </button>
                ))}
              </div>
              <div className="risk-controls live-risk-controls">
                <Range
                  label="Edge floor after fees"
                  value={risk.signal.minEdge}
                  display={points(risk.signal.minEdge)}
                  min={0.01}
                  max={0.2}
                  step={0.005}
                  onChange={(minEdge) => onRiskChange({ signal: { minEdge } })}
                />
                <Range
                  label="Model weight vs book"
                  value={risk.signal.modelWeight}
                  display={percentage(risk.signal.modelWeight, 0)}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(modelWeight) => onRiskChange({ signal: { modelWeight } })}
                />
                <Range
                  label="Kelly fraction"
                  value={risk.kellyFraction}
                  display={percentage(risk.kellyFraction, 0)}
                  min={0.05}
                  max={0.5}
                  step={0.05}
                  onChange={(kellyFraction) => onRiskChange({ kellyFraction })}
                />
                <Range
                  label="Unit / balance"
                  value={risk.unitBalancePct}
                  display={percentage(risk.unitBalancePct, 2)}
                  min={0.0025}
                  max={0.05}
                  step={0.0025}
                  onChange={(unitBalancePct) => onRiskChange({ unitBalancePct })}
                />
                <Range
                  label="Max trade"
                  value={risk.maxTradeUsd}
                  display={dollars(risk.maxTradeUsd, 0)}
                  min={1}
                  max={500}
                  step={1}
                  onChange={(maxTradeUsd) => onRiskChange({ maxTradeUsd })}
                />
                <Range
                  label="Max open exposure"
                  value={risk.maxOpenExposurePct}
                  display={percentage(risk.maxOpenExposurePct, 0)}
                  min={0.01}
                  max={0.5}
                  step={0.01}
                  onChange={(maxOpenExposurePct) => onRiskChange({ maxOpenExposurePct })}
                />
                <Range
                  label="Same window + side"
                  value={risk.maxSameWindowSameSide}
                  display={`${risk.maxSameWindowSameSide} max`}
                  min={1}
                  max={8}
                  step={1}
                  onChange={(maxSameWindowSameSide) => onRiskChange({ maxSameWindowSameSide })}
                />
                <Range
                  label="Daily loss stop"
                  value={risk.dailyLossPct}
                  display={percentage(risk.dailyLossPct)}
                  min={0.005}
                  max={0.25}
                  step={0.005}
                  onChange={(dailyLossPct) => onRiskChange({ dailyLossPct })}
                />
                <Range
                  label="Max share of depth"
                  value={risk.maxDepthFraction}
                  display={percentage(risk.maxDepthFraction, 0)}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onChange={(maxDepthFraction) => onRiskChange({ maxDepthFraction })}
                />
              </div>
              <label className="live-checkbox">
                <input checked={risk.requireLock} onChange={(event) => onRiskChange({ requireLock: event.target.checked })} type="checkbox" />
                <span>Require LOCK tier (edge ≥ {risk.signal.strongEdgeMultiple}× floor, anchored feeds)</span>
              </label>
            </article>
          </div>
          <article className="panel live-risk-card early-exit-card">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">MODEL-AWARE CASHOUT</div>
                <h3>Sell when the book pays more than fair value</h3>
              </div>
            </div>
            <label className="live-checkbox">
              <input checked={risk.earlyExitEnabled} onChange={(event) => onRiskChange({ earlyExitEnabled: event.target.checked })} type="checkbox" />
              <span>Enable early exits for live positions (limit-priced sells)</span>
            </label>
            <div className="risk-controls live-risk-controls">
              <Range
                disabled={!risk.earlyExitEnabled}
                label="Net bid above fair"
                value={risk.earlyExitModelGap}
                display={points(risk.earlyExitModelGap)}
                min={0.01}
                max={0.15}
                step={0.01}
                onChange={(earlyExitModelGap) => onRiskChange({ earlyExitModelGap })}
              />
              <Range
                disabled={!risk.earlyExitEnabled}
                label="Minimum profit"
                value={risk.earlyExitMinProfitUsd}
                display={dollars(risk.earlyExitMinProfitUsd, 0)}
                min={0}
                max={50}
                step={1}
                onChange={(earlyExitMinProfitUsd) => onRiskChange({ earlyExitMinProfitUsd })}
              />
              <Range
                disabled={!risk.earlyExitEnabled}
                label="Confirmations"
                value={risk.earlyExitConfirmations}
                display={`${risk.earlyExitConfirmations} ticks`}
                min={1}
                max={5}
                step={1}
                onChange={(earlyExitConfirmations) => onRiskChange({ earlyExitConfirmations })}
              />
            </div>
          </article>
          <article className="panel live-status-card">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">ORDER STATUS</div>
                <h3>Execution audit</h3>
              </div>
            </div>
            {status.lastError ? (
              <div className="data-alert">
                <AlertTriangle size={15} />
                <div>
                  <strong>Runner stopped safely</strong>
                  <span>{status.lastError}</span>
                </div>
              </div>
            ) : (
              <div className="live-status-row">
                <span className="status-dot status-locked" />
                <strong>{status.lastAction || "Live buys and sells are disabled"}</strong>
                <span>{status.lastDetail || "No browser order runner is active. Review the evidence gates before enabling any live path."}</span>
                <b>{status.lastLatencyMs === null ? "—" : `${status.lastLatencyMs} ms`}</b>
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}
