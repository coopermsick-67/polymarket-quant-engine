"use client";

import { Database, Download, FileUp, Gauge, LineChart, Play, ScanLine, ShieldCheck, Target, TrendingUp, Upload } from "lucide-react";
import { useState } from "react";
import { parseReplayCsv, parseReplayJsonl, replayCsvTemplate, runReplay, walkForward, type ReplayDataset, type ReplayReport } from "../lib/replay";
import type { SignalParams } from "../lib/signal";
import { EquityChart, ReliabilityChart } from "./charts";
import { downloadText, formatTime, percentage, points, signedDollars, toneFor } from "./format";
import { EmptyState, MetricCard } from "./ui";

type Props = {
  recorded: ReplayDataset;
  onExportRecording: () => void;
  baseParams: SignalParams;
};

const Breakdown = ({ title, rows }: { title: string; rows: Record<string, { trades: number; pnl: number }> }) => (
  <div className="breakdown">
    <strong>{title}</strong>
    {Object.entries(rows)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, value]) => (
        <div key={key} className="breakdown-row">
          <span>{key}</span>
          <span>{value.trades} tr</span>
          <b className={value.pnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(value.pnl)}</b>
        </div>
      ))}
  </div>
);

export default function ResearchLab({ recorded, onExportRecording, baseParams }: Props) {
  const [dataset, setDataset] = useState<ReplayDataset | null>(null);
  const [source, setSource] = useState("");
  const [latencyMs, setLatencyMs] = useState(750);
  const [stakeUsd, setStakeUsd] = useState(25);
  const [minEdge, setMinEdge] = useState(baseParams.minEdge);
  const [modelWeight, setModelWeight] = useState(baseParams.modelWeight);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [walk, setWalk] = useState<ReturnType<typeof walkForward> | null>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const parsed = file.name.endsWith(".csv") ? parseReplayCsv(text) : parseReplayJsonl(text);
    setDataset(parsed);
    setSource(file.name);
    setReport(null);
    setWalk(null);
  };
  const params = { ...baseParams, minEdge, modelWeight };
  const run = () => dataset && setReport(runReplay(dataset.snapshots, dataset.outcomes, { latencyMs, stakeUsd, params }));
  const runWalk = () => {
    if (!dataset) return;
    const grid = [0.02, 0.03, 0.05].flatMap((edge) => [0.4, 0.6, 0.8].map((weight) => ({ minEdge: edge, modelWeight: weight })));
    setWalk(walkForward(dataset.snapshots, dataset.outcomes, grid, { latencyMs, stakeUsd, params }, 0.6, 20));
  };

  return (
    <section className="backtest-lab">
      <div className="section-heading">
        <div>
          <div className="eyebrow">RESEARCH WORKBENCH</div>
          <h2>Event replay backtest</h2>
          <p className="section-subtitle">
            Runs the exact live decision function over recorded snapshots, fills after the configured latency at the decision&apos;s limit price against the
            book that existed then, and settles on official outcomes. Calibration is scored on every market against the book, not just on trades.
          </p>
        </div>
        <span className="research-badge">
          <LineChart size={14} />
          SAME CODE AS LIVE
        </span>
      </div>
      <div className="backtest-grid">
        <article className="panel dataset-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">DATASET</div>
              <h3>Recorded snapshots</h3>
            </div>
            <FileUp size={17} className="heading-icon" />
          </div>
          <p className="panel-copy">
            Best data: JSONL from the headless runner (`pnpm run headless -- --record`). This browser also records while open. CSV import is supported but lacks
            tick history, so it is treated as exchange-sourced.
          </p>
          <div className="upload-zone">
            <input accept=".jsonl,.json,.csv,text/csv" id="replay-upload" onChange={(event) => void load(event.target.files?.[0])} type="file" />
            <label htmlFor="replay-upload">
              <Upload size={17} />
              <strong>Import JSONL or CSV</strong>
              <span>Parsed locally · never uploaded</span>
            </label>
          </div>
          <div className="dataset-actions">
            <button
              className="button-secondary"
              disabled={!recorded.snapshots.length}
              onClick={() => {
                setDataset(recorded);
                setSource("this browser session");
                setReport(null);
                setWalk(null);
              }}
              type="button"
            >
              <Database size={14} />
              Use this session <span className="button-count">{recorded.snapshots.length}</span>
            </button>
            <button className="text-button" disabled={!recorded.snapshots.length} onClick={onExportRecording} type="button">
              <Download size={13} />
              Export JSONL
            </button>
            <button className="text-button" onClick={() => downloadText("replay-template.csv", replayCsvTemplate, "text/csv")} type="button">
              <Download size={13} />
              CSV template
            </button>
          </div>
          <div className="dataset-status">
            <span className={`status-dot ${dataset?.snapshots.length ? "status-ready" : "status-warning"}`} />
            <strong>{dataset ? `${dataset.snapshots.length.toLocaleString()} snapshots · ${dataset.outcomes.size} outcomes` : "No dataset loaded"}</strong>
            <span>{dataset ? `${source}${dataset.rejected ? ` · ${dataset.rejected} rejected` : ""}` : "Outcomes come from official resolutions"}</span>
          </div>
        </article>
        <article className="panel backtest-config-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">SIMULATION</div>
              <h3>Latency-aware replay</h3>
            </div>
          </div>
          <div className="backtest-form">
            <label>
              <span>Order latency (ms)</span>
              <input min="0" step="50" type="number" value={latencyMs} onChange={(event) => setLatencyMs(Number(event.target.value))} />
            </label>
            <label>
              <span>Stake per trade ($)</span>
              <input min="1" step="1" type="number" value={stakeUsd} onChange={(event) => setStakeUsd(Number(event.target.value))} />
            </label>
            <label>
              <span>Edge floor (prob.)</span>
              <input min="0.005" max="0.3" step="0.005" type="number" value={minEdge} onChange={(event) => setMinEdge(Number(event.target.value))} />
            </label>
            <label>
              <span>Model weight vs book</span>
              <input min="0" max="1" step="0.05" type="number" value={modelWeight} onChange={(event) => setModelWeight(Number(event.target.value))} />
            </label>
          </div>
          <div className="dataset-actions">
            <button className="button-primary run-backtest" disabled={!dataset?.snapshots.length} onClick={run} type="button">
              <Play size={15} fill="currentColor" />
              RUN REPLAY
            </button>
            <button className="button-secondary" disabled={!dataset?.snapshots.length} onClick={runWalk} type="button">
              WALK-FORWARD (60/40)
            </button>
          </div>
        </article>
      </div>
      {report ? (
        <>
          <div className="backtest-metrics metric-grid">
            <MetricCard
              label="TRADES"
              value={String(report.settled)}
              delta={`${report.signals} signals · fill ${percentage(report.fillRate, 0)}`}
              detail="after latency + limit"
              icon={<ScanLine size={17} />}
            />
            <MetricCard
              label="NET P&L"
              value={signedDollars(report.netPnl)}
              delta={`EV ${signedDollars(report.evPerTrade)} / trade`}
              deltaTone={toneFor(report.netPnl)}
              detail={`ROI on turnover ${percentage(report.roiOnTurnover)}`}
              icon={<TrendingUp size={17} />}
            />
            <MetricCard
              label="REALIZED EDGE"
              value={points(report.avgRealizedEdge)}
              delta={`predicted ${points(report.avgPredictedEdge)}`}
              deltaTone={toneFor(report.avgRealizedEdge)}
              detail={report.tradesNeededForSignificance ? `~${report.tradesNeededForSignificance} trades for 95% confidence` : "not significant"}
              icon={<Target size={17} />}
            />
            <MetricCard
              label="WIN RATE"
              value={percentage(report.winRate)}
              delta={report.winRateCi ? `95% CI ${percentage(report.winRateCi[0])}–${percentage(report.winRateCi[1])}` : "—"}
              detail="not the objective; EV is"
              icon={<ShieldCheck size={17} />}
            />
            <MetricCard
              label="MARKOUT 5s / 30s"
              value={points(report.avgMarkout5s)}
              delta={points(report.avgMarkout30s)}
              deltaTone={toneFor(report.avgMarkout5s)}
              detail={`slippage ${points(report.avgSlippage)}`}
              icon={<Gauge size={17} />}
            />
            <MetricCard
              label="MAX DD / SHARPE"
              value={percentage(report.maxDrawdown)}
              delta={report.dailySharpe === null ? "—" : `Sharpe ${report.dailySharpe.toFixed(2)}`}
              detail="daily, annualized"
              icon={<Gauge size={17} />}
            />
            <MetricCard
              label="BRIER MODEL / BOOK"
              value={report.calibration.model.brier?.toFixed(4) ?? "—"}
              delta={`book ${report.calibration.market.brier?.toFixed(4) ?? "—"}`}
              deltaTone={
                report.calibration.model.brier !== null &&
                report.calibration.market.brier !== null &&
                report.calibration.model.brier < report.calibration.market.brier
                  ? "positive"
                  : "negative"
              }
              detail={`${report.calibration.rows} checkpoints · lower is better`}
              icon={<ShieldCheck size={17} />}
            />
          </div>
          <section className="backtest-results">
            <article className="panel chart-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">EQUITY + CALIBRATION</div>
                  <h3>Settled equity and reliability</h3>
                </div>
              </div>
              <div className="replay-charts">
                <div className="chart-wrap">
                  <EquityChart values={report.equityCurve.map((point) => point.equity)} color={report.netPnl >= 0 ? "#6cf2c4" : "#ff7d8a"} />
                </div>
                <div>
                  <ReliabilityChart bins={report.calibration.reliability} />
                  <small className="text-muted">Model P(UP) vs observed frequency · diagonal = perfect</small>
                </div>
              </div>
              <div className="breakdown-grid">
                <Breakdown title="By asset" rows={report.byAsset} />
                <Breakdown title="By duration" rows={report.byDuration} />
                <Breakdown title="By hour (UTC)" rows={report.byHourUtc} />
              </div>
            </article>
            <article className="panel backtest-trades-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">TRADES</div>
                  <h3>Replay fills</h3>
                </div>
              </div>
              <div className="positions-table-wrap">
                <table className="positions-table">
                  <thead>
                    <tr>
                      <th>FILLED</th>
                      <th>MARKET</th>
                      <th>SIDE</th>
                      <th>COST</th>
                      <th>EDGE</th>
                      <th>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.trades.length ? (
                      report.trades
                        .slice(-200)
                        .reverse()
                        .map((trade) => (
                          <tr key={`${trade.marketId}-${trade.filledAt}`}>
                            <td>{formatTime(trade.filledAt)}</td>
                            <td>
                              <strong>
                                {trade.asset} {trade.duration}
                              </strong>
                              <small>
                                fair {percentage(trade.probability)} · book {percentage(trade.marketProbability)}
                              </small>
                            </td>
                            <td>
                              <span className={`side-chip ${trade.side === "UP" ? "up" : "down"}`}>{trade.side}</span>
                            </td>
                            <td>{(trade.costPerShare * 100).toFixed(1)}¢</td>
                            <td>{points(trade.predictedEdge)}</td>
                            <td className={trade.pnl === null ? "text-muted" : trade.pnl >= 0 ? "text-positive" : "text-negative"}>
                              {signedDollars(trade.pnl)}
                            </td>
                          </tr>
                        ))
                    ) : (
                      <tr>
                        <td className="empty-row" colSpan={6}>
                          No trades passed the gates and filled after latency.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </>
      ) : (
        <EmptyState
          title="Replay output is waiting"
          detail="Load a recording and run the replay. Nothing is synthesized: markets without an official outcome are excluded from P&L and calibration."
        />
      )}
      {walk ? (
        <article className="panel walk-forward-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">WALK-FORWARD</div>
              <h3>
                Tuned on {walk.trainMarkets} markets, tested on {walk.testMarkets} untouched markets
              </h3>
            </div>
          </div>
          {walk.chosen && walk.test ? (
            <p className="panel-copy">
              Chosen: edge floor {walk.chosen.minEdge}, model weight {walk.chosen.modelWeight}. Train EV {signedDollars(walk.train?.evPerTrade)} / trade over{" "}
              {walk.train?.settled} trades.{" "}
              <strong>
                Out-of-sample EV {signedDollars(walk.test.evPerTrade)} / trade over {walk.test.settled} trades
              </strong>
              , realized edge {points(walk.test.avgRealizedEdge)}, Brier model {walk.test.calibration.model.brier?.toFixed(4) ?? "—"} vs book{" "}
              {walk.test.calibration.market.brier?.toFixed(4) ?? "—"}.
            </p>
          ) : (
            <p className="panel-copy">No parameter set produced at least 20 trades on the training window; record more data before trusting any setting.</p>
          )}
        </article>
      ) : null}
    </section>
  );
}
