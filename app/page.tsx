"use client";

import {
  Activity,
  AlertTriangle,
  BarChart3,
  CircleDollarSign,
  Clock3,
  Gauge,
  LayoutDashboard,
  LineChart,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Target,
  Terminal,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountConnectModal, AccountView, RunnerSetupModal, type AccountConnection, type ConnectedAccount } from "./components/account-view";
import { EquityChart } from "./components/charts";
import {
  cents,
  dollars,
  downloadText,
  formatAge,
  percentage,
  readStoredJson,
  signedDollars,
  timeLeft,
  toneFor,
  writeStoredJson,
  type Tone,
} from "./components/format";
import LiveExecutionPanel, { type LiveExecutionStatus, type LiveSessionState } from "./components/live-execution-panel";
import { MarketCard } from "./components/market-card";
import PaperLabPanel, { type TelegramViewState } from "./components/paper-lab-panel";
import ResearchLab from "./components/research-lab";
import { SignalPanel } from "./components/signal-panel";
import { EmptyState, MetricCard, StatusDot } from "./components/ui";
import { useMarketFeed } from "./hooks/use-market-feed";
import { computeLedgerMetrics, decisionLedgerCsv, resolveLedgerRow, updateLedgerRow, type MarketDecisionRow } from "./lib/decision-ledger";
import {
  accountEquity,
  accountUnrealized,
  analyzeMarketSignal,
  buyPaper,
  closePaperPositions,
  createPaperAccount,
  markAccount,
  migratePaperAccount,
  type MarketSignal,
  type PaperAccount,
} from "./lib/engines";
import { normalizeLiveRiskConfig, type LiveRiskConfig } from "./lib/live-risk";
import { createEngineState, normalizePaperConfig, stepPaperEngine, type PaperConfig, type PaperEngineState } from "./lib/paper-engine";
import { snapshotFromLiveMarket, type LiveMarket } from "./lib/polymarket-data";
import { serializeResolutionLine, serializeSnapshotLine, type ReplayDataset } from "./lib/replay";
import { type MarketSnapshot, type Side } from "./lib/signal";

type View = "overview" | "paper" | "research" | "account" | "live";
type LogItem = { id: string; time: string; message: string; detail: string; tone: Tone };

const PAPER_KEY = "pqe-paper-v3";
const PAPER_CONFIG_KEY = "pqe-paper-config-v3";
const LIVE_RISK_KEY = "pqe-live-risk-v3";
const LEDGER_KEY = "pqe-ledger-v3";
const WALLET_KEY = "pqe-wallet-v1";
const TELEGRAM_ALERTS_KEY = "pqe-telegram-alerts-v1";
const TELEGRAM_LAST_SENT_KEY = "pqe-telegram-weekly-v1";
const MAX_RECORDED = 20_000;

const liveRequest = (body: Record<string, unknown>, confirm = false) =>
  fetch("/api/polymarket/live", {
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(confirm ? { "x-polymarket-live-confirm": "1" } : {}) },
    method: "POST",
  });

export default function Home() {
  const [view, setView] = useState<View>("overview");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const appendLog = useCallback((message: string, detail: string, tone: Tone = "neutral") => {
    setLogs((current) =>
      [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString("en-US", { hour12: false }), message, detail, tone }, ...current].slice(
        0,
        40,
      ),
    );
  }, []);
  const onFeedLog = useCallback(
    (level: "info" | "warn" | "error", message: string) =>
      appendLog(level === "info" ? "Feed" : "Feed warning", message, level === "info" ? "neutral" : "warning"),
    [appendLog],
  );
  const { controller, version } = useMarketFeed(onFeedLog);

  const [clock, setClock] = useState(0);
  const [durationFilter, setDurationFilter] = useState<"ALL" | "5m" | "15m">("ALL");
  const [selectedMarketId, setSelectedMarketId] = useState("");
  const [runnerOpen, setRunnerOpen] = useState(false);

  // ---- paper engine ------------------------------------------------------
  const [paperConfig, setPaperConfig] = useState<PaperConfig>(() => normalizePaperConfig(readStoredJson<Partial<PaperConfig>>(PAPER_CONFIG_KEY)));
  const [engine, setEngine] = useState<PaperEngineState>(() => {
    const stored = readStoredJson<{ account?: Partial<PaperAccount>; halt?: PaperEngineState["halt"] }>(PAPER_KEY);
    const account = migratePaperAccount(stored?.account ?? null) ?? createPaperAccount(1000, 0);
    return { ...createEngineState(account), halt: stored?.halt ?? null };
  });
  const [autoTrade, setAutoTrade] = useState(true);
  const engineRef = useRef(engine);
  const configRef = useRef(paperConfig);
  const autoRef = useRef(autoTrade);
  useEffect(() => {
    engineRef.current = engine;
    writeStoredJson(PAPER_KEY, { account: engine.account, halt: engine.halt });
  }, [engine]);
  useEffect(() => {
    configRef.current = paperConfig;
    writeStoredJson(PAPER_CONFIG_KEY, paperConfig);
  }, [paperConfig]);
  useEffect(() => {
    autoRef.current = autoTrade;
  }, [autoTrade]);

  // ---- ledger + recorder -------------------------------------------------
  const [ledger, setLedger] = useState<Map<string, MarketDecisionRow>>(
    () => new Map((readStoredJson<MarketDecisionRow[]>(LEDGER_KEY) ?? []).filter((row) => row && typeof row.endTime === "number").map((row) => [row.id, row])),
  );
  const ledgerRows = useMemo(() => [...ledger.values()], [ledger]);
  const ledgerMetrics = useMemo(() => computeLedgerMetrics(ledgerRows), [ledgerRows]);
  useEffect(() => writeStoredJson(LEDGER_KEY, [...ledger.values()].sort((left, right) => right.endTime - left.endTime).slice(0, 3000)), [ledger]);
  const recordingRef = useRef<{ snapshots: MarketSnapshot[]; outcomes: Map<string, Side>; lastAt: number }>({ snapshots: [], outcomes: new Map(), lastAt: 0 });
  const [recordedCount, setRecordedCount] = useState(0);

  // ---- telegram ----------------------------------------------------------
  const [telegram, setTelegram] = useState<TelegramViewState>(() => ({
    connected: false,
    botUsername: "",
    botName: "",
    chatId: "",
    chatTitle: "",
    expiresAt: null,
    alerts: readStoredJson<boolean>(TELEGRAM_ALERTS_KEY) ?? true,
    lastStatus: "",
    lastError: "",
  }));
  const telegramRef = useRef(telegram);
  useEffect(() => {
    telegramRef.current = telegram;
    writeStoredJson(TELEGRAM_ALERTS_KEY, telegram.alerts);
  }, [telegram]);
  const alertQueue = useRef<string[]>([]);
  const telegramRequest = useCallback(
    (body: Record<string, unknown>) =>
      fetch("/api/telegram", {
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    [],
  );
  const sendTelegram = useCallback(
    async (text: string) => {
      const response = await telegramRequest({ action: "send-report", text: text.slice(0, 3900) });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Telegram send failed.");
    },
    [telegramRequest],
  );
  const alert = useCallback((text: string) => {
    if (telegramRef.current.connected && telegramRef.current.alerts) alertQueue.current.push(text);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = alertQueue.current.shift();
      if (next)
        void sendTelegram(`Polymarket Quant Engine\n${next}`).catch((error) =>
          setTelegram((current) => ({ ...current, lastError: error instanceof Error ? error.message : "Alert failed." })),
        );
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [sendTelegram]);

  // ---- live execution ----------------------------------------------------
  const [liveRisk, setLiveRisk] = useState<LiveRiskConfig>(() => normalizeLiveRiskConfig(readStoredJson<Partial<LiveRiskConfig>>(LIVE_RISK_KEY)));
  const [liveSession, setLiveSession] = useState<LiveSessionState | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveExecutionStatus>({ lastAction: "", lastDetail: "", lastError: "", lastLatencyMs: null });
  const [serverKeyConfigured, setServerKeyConfigured] = useState(false);
  useEffect(() => writeStoredJson(LIVE_RISK_KEY, liveRisk), [liveRisk]);

  // ---- account -----------------------------------------------------------
  const [connection, setConnection] = useState<AccountConnection>(() => ({
    walletAddress: readStoredJson<string>(WALLET_KEY) ?? "",
    privateKey: "",
    signatureType: "3",
    useServerKey: true,
  }));
  const [connectedAccount, setConnectedAccount] = useState<ConnectedAccount | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void liveRequest({ action: "status" })
      .then((response) => response.json() as Promise<{ ok?: boolean; serverKeyConfigured?: boolean }>)
      .then((payload) => setServerKeyConfigured(Boolean(payload.ok && payload.serverKeyConfigured)))
      .catch(() => setServerKeyConfigured(false));
    void telegramRequest({ action: "status" })
      .then((response) => response.json() as Promise<{ ok?: boolean; telegram?: Partial<TelegramViewState> }>)
      .then((payload) => {
        if (payload.ok && payload.telegram) setTelegram((current) => ({ ...current, ...payload.telegram, connected: true, lastError: "" }));
      })
      .catch(() => undefined);
  }, [telegramRequest]);

  // ---- engine tick: paper engine, ledger, recorder -----------------------
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const current = engineRef.current;
      controller.watchResolution(current.account.positions.map((position) => position.marketId));
      const step = stepPaperEngine(current, {
        markets: controller.markets,
        feed: (asset) => controller.derived(asset, now),
        resolutions: controller.resolutions,
        config: configRef.current,
        now,
        autoTrade: autoRef.current,
      });
      engineRef.current = step.state;
      setEngine(step.state);
      for (const event of step.events) {
        appendLog(event.title, event.detail, event.tone);
        if (event.kind === "halt" || event.kind === "fill" || event.kind === "settle") alert(`${event.title}\n${event.detail}`);
      }
      setLedger((previous) => {
        let next: Map<string, MarketDecisionRow> | null = null;
        for (const [id, signal] of step.decisions) {
          const market = controller.markets.get(id);
          if (!market) continue;
          const before = previous.get(id);
          const row = updateLedgerRow(before, market, signal, now);
          if (
            !before ||
            before.decision !== row.decision ||
            before.entry !== row.entry ||
            before.checkpoint !== row.checkpoint ||
            now - before.lastUpdatedAt > 15_000
          ) {
            next = next ?? new Map(previous);
            next.set(id, row);
          }
        }
        const pendingIds: string[] = [];
        for (const row of previous.values()) {
          if (row.outcome || row.endTime > now) continue;
          const resolution = controller.resolutions.get(row.id);
          if (resolution) {
            next = next ?? new Map(previous);
            next.set(row.id, resolveLedgerRow(row, resolution));
          } else if ((row.entry || row.checkpoint) && now - row.endTime < 6 * 60 * 60 * 1000) pendingIds.push(row.id);
        }
        controller.watchResolution(pendingIds);
        return next ?? previous;
      });
      const recording = recordingRef.current;
      if (now - recording.lastAt >= 5_000) {
        recording.lastAt = now;
        for (const market of controller.markets.values()) {
          if (market.startTime > now || market.endTime <= now) continue;
          recording.snapshots.push(snapshotFromLiveMarket(market, controller.derived(market.asset, now), now));
        }
        for (const [id, resolution] of controller.resolutions) recording.outcomes.set(id, resolution.outcome);
        if (recording.snapshots.length > MAX_RECORDED) recording.snapshots.splice(0, recording.snapshots.length - MAX_RECORDED);
        setRecordedCount(recording.snapshots.length);
      }
    };
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [alert, appendLog, controller]);

  // ---- derived view state (recomputed on each controller flush) ----------
  const now = clock || Date.now();
  const markets = controller.markets;
  const activeMarkets = useMemo(
    () =>
      [...markets.values()]
        .filter((market) => market.startTime <= now && market.endTime > now)
        .sort((left, right) => left.endTime - right.endTime || left.asset.localeCompare(right.asset)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markets, version, now],
  );
  const signals = useMemo(() => {
    const map = new Map<string, MarketSignal>();
    for (const market of activeMarkets)
      map.set(market.id, analyzeMarketSignal(market, controller.derived(market.asset, now), { ...paperConfig.signal, budgetUsd: paperConfig.stakeUsd }, now));
    return map;
  }, [activeMarkets, controller, now, paperConfig]);
  const visibleMarkets = activeMarkets.filter((market) => durationFilter === "ALL" || market.duration === durationFilter);
  const selectedMarket = visibleMarkets.find((market) => market.id === selectedMarketId) ?? visibleMarkets[0] ?? null;
  const selectedSignal = selectedMarket ? (signals.get(selectedMarket.id) ?? null) : null;
  const account = engine.account;
  const equity = accountEquity(account, markets);
  const unrealized = accountUnrealized(account, markets);
  const dayPnl = equity - account.dayStartEquity;
  const drawdown = account.peakEquity > 0 ? Math.max(0, (account.peakEquity - equity) / account.peakEquity) : 0;
  const equitySeries = account.equityHistory.map((point) => point.equity);
  const upcoming = [...markets.values()].filter((market) => market.startTime > now).length;

  // ---- paper actions -----------------------------------------------------
  const manualBuy = (side: Side) => {
    if (!selectedMarket || !selectedSignal || selectedSignal.action !== side || selectedSignal.limitPrice === null) return;
    const result = buyPaper(engineRef.current.account, selectedMarket, side, paperConfig.stakeUsd, {
      slippageBps: paperConfig.signal.slippageBps,
      limitPrice: selectedSignal.limitPrice,
      probability: selectedSignal.probability,
      reason: `manual ${selectedSignal.tier}`,
    });
    if (!result.fill) {
      appendLog(`${side} paper order rejected`, result.error ?? "No depth under the limit.", "warning");
      return;
    }
    const next = { ...engineRef.current, account: markAccount(result.account, markets) };
    engineRef.current = next;
    setEngine(next);
    appendLog(
      `${selectedMarket.asset} ${selectedMarket.duration} manual ${side}`,
      `${result.fill.shares.toFixed(2)} sh @ ${cents(result.fill.avgPrice)} (all-in ${cents(result.fill.costPerShare)})`,
      "positive",
    );
  };
  const closeAll = () => {
    const result = closePaperPositions(engineRef.current.account, markets, { slippageBps: paperConfig.signal.slippageBps, reason: "manual close all" });
    const next = { ...engineRef.current, account: result.account };
    engineRef.current = next;
    setEngine(next);
    appendLog(
      result.closed ? "Positions sold into the bid" : "Nothing sellable",
      `${result.closed} closed · ${result.skipped} held (no bid depth) · ${signedDollars(result.realized)}`,
      result.closed ? "positive" : "warning",
    );
  };
  const killSwitch = () => {
    setAutoTrade(false);
    const next = { ...engineRef.current, pending: [], halt: { reason: "Manual kill switch.", at: Date.now() } };
    engineRef.current = next;
    setEngine(next);
    appendLog("KILL SWITCH", "Paper auto-trading disabled and pending orders cleared.", "negative");
    alert("Manual kill switch engaged.");
  };
  const resetAccount = (cash: number) => {
    if (typeof window !== "undefined" && !window.confirm("Reset the paper account? Positions and history are cleared; the decision ledger is kept.")) return;
    const next = createEngineState(createPaperAccount(cash));
    engineRef.current = next;
    setEngine(next);
    appendLog("Paper account reset", `${dollars(next.account.startingCash)} starting cash.`, "neutral");
  };
  const clearHalt = () => {
    const next = { ...engineRef.current, halt: null, account: { ...engineRef.current.account, dayStartEquity: equity, peakEquity: equity } };
    engineRef.current = next;
    setEngine(next);
    appendLog("Halt acknowledged", "Limits re-based to current equity.", "warning");
  };
  const exportRecording = () => {
    const recording = recordingRef.current;
    const lines =
      recording.snapshots.map(serializeSnapshotLine).join("") + [...recording.outcomes].map(([id, outcome]) => serializeResolutionLine(id, outcome)).join("");
    downloadText(`pqe-replay-${new Date().toISOString().slice(0, 19)}.jsonl`, lines, "application/x-ndjson");
  };
  const recordedDataset = useMemo<ReplayDataset>(() => {
    void recordedCount;
    return { snapshots: [...recordingRef.current.snapshots], outcomes: new Map(recordingRef.current.outcomes), rejected: 0 };
  }, [recordedCount]);

  // ---- account + live session -------------------------------------------
  const fetchAccount = useCallback(async (walletAddress: string) => {
    if (!walletAddress.trim()) return false;
    setAccountLoading(true);
    setAccountError("");
    try {
      const response = await fetch("/api/polymarket/account", {
        body: JSON.stringify({ walletAddress: walletAddress.trim() }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; account?: ConnectedAccount };
      if (!response.ok || !payload.ok || !payload.account) throw new Error(payload.error || "Account snapshot unavailable.");
      setConnectedAccount(payload.account);
      writeStoredJson(WALLET_KEY, walletAddress.trim());
      return true;
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Account request failed.");
      return false;
    } finally {
      setAccountLoading(false);
    }
  }, []);
  const connectLive = async () => {
    setAccountLoading(true);
    setAccountError("");
    try {
      const useServerKey = serverKeyConfigured && connection.useServerKey;
      const response = await liveRequest(
        useServerKey
          ? { action: "connect", useServerKey: true }
          : {
              action: "connect",
              walletAddress: connection.walletAddress.trim(),
              privateKey: connection.privateKey.trim(),
              signatureType: Number(connection.signatureType),
            },
      );
      const payload = (await response.json()) as { ok?: boolean; error?: string; live?: Omit<LiveSessionState, "connected"> };
      if (!response.ok || !payload.ok || !payload.live) throw new Error(payload.error || "Live session could not be established.");
      setLiveSession({ ...payload.live, connected: true });
      setConnection((current) => ({ ...current, privateKey: "", walletAddress: payload.live!.walletAddress }));
      setAccountDialogOpen(false);
      setView("live");
      appendLog(
        "Live account linked",
        `${payload.live.keySource === "server" ? "Server-held" : "Browser-entered"} key · ${dollars(payload.live.balance)} available. Order placement remains disabled.`,
        "neutral",
      );
      void fetchAccount(payload.live.walletAddress);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Live connection failed.");
    } finally {
      setAccountLoading(false);
    }
  };
  const disconnect = () => {
    void liveRequest({ action: "disconnect" }).catch(() => undefined);
    setLiveSession(null);
    setConnectedAccount(null);
    appendLog("Account disconnected", "Encrypted live session cleared.", "neutral");
  };
  const refreshLiveBalance = async () => {
    const response = await liveRequest({ action: "balance" });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; live?: Omit<LiveSessionState, "connected"> };
    if (payload.ok && payload.live) setLiveSession({ ...payload.live, connected: true });
    else setLiveStatus((current) => ({ ...current, lastError: payload.error || "Balance refresh failed." }));
  };
  const killLive = async () => {
    if (!liveSession?.connected) return;
    const response = await liveRequest({ action: "cancel-all", confirmLive: true }, true).catch(() => null);
    const ok = Boolean(response?.ok);
    setLiveStatus({
      lastAction: ok ? "KILL + CANCEL ALL" : "CANCEL UNCERTAIN",
      lastDetail: ok ? "Runner stopped; cancel-all accepted." : "Reconcile open orders in Account.",
      lastError: ok ? "" : "Cancel-all could not be confirmed.",
      lastLatencyMs: null,
    });
    alert(ok ? "LIVE kill switch: runner stopped, cancel-all accepted." : "LIVE kill switch: cancel-all could not be confirmed.");
  };

  // ---- telegram actions + weekly report ---------------------------------
  const reportText = (label: string) =>
    [
      `Polymarket Quant Engine · ${label}`,
      `Equity ${dollars(equity)} (${signedDollars(equity - account.startingCash)}) · day ${signedDollars(dayPnl)} · ${account.positions.length} open`,
      `Ledger: ${ledgerMetrics.entries} entries, ${ledgerMetrics.settled} settled, win ${percentage(ledgerMetrics.winRate)}, realized edge ${ledgerMetrics.realizedEdge === null ? "—" : (ledgerMetrics.realizedEdge * 100).toFixed(1) + "pt"}`,
      `Brier model ${ledgerMetrics.brierModel?.toFixed(4) ?? "—"} vs book ${ledgerMetrics.brierMarket?.toFixed(4) ?? "—"} (${ledgerMetrics.calibrated} checkpoints)`,
      engine.halt ? `HALTED: ${engine.halt.reason}` : "Not halted",
    ].join("\n");
  const reportRef = useRef(reportText);
  useEffect(() => {
    reportRef.current = reportText;
  });
  useEffect(() => {
    if (!telegram.connected) return;
    const check = () => {
      const parts = new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        timeZone: "America/New_York",
        weekday: "short",
        year: "numeric",
      }).formatToParts(new Date());
      const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
      if (part("weekday") !== "Sun" || Number(part("hour")) !== 21 || Number(part("minute")) > 5) return;
      const weekKey = `${part("year")}-${part("month")}-${part("day")}`;
      if (readStoredJson<string>(TELEGRAM_LAST_SENT_KEY) === weekKey) return;
      void sendTelegram(reportRef.current("Weekly report"))
        .then(() => writeStoredJson(TELEGRAM_LAST_SENT_KEY, weekKey))
        .catch(() => undefined);
    };
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [sendTelegram, telegram.connected]);
  const connectTelegram = async (botToken: string, chatId: string) => {
    try {
      const response = await telegramRequest({ action: "connect", botToken, chatId });
      const payload = (await response.json()) as { ok?: boolean; error?: string; telegram?: Partial<TelegramViewState> };
      if (!response.ok || !payload.ok || !payload.telegram) throw new Error(payload.error || "Telegram link failed.");
      setTelegram((current) => ({ ...current, ...payload.telegram, connected: true, lastStatus: "Telegram linked and verified.", lastError: "" }));
      return true;
    } catch (error) {
      setTelegram((current) => ({ ...current, lastError: error instanceof Error ? error.message : "Telegram link failed." }));
      return false;
    }
  };

  // ---- render ------------------------------------------------------------
  const status = controller.status;
  const sockets = [status.clob, status.rtds, status.coinbase];
  const feedStatus: "READY" | "WARN" = sockets.every((value) => value === "LIVE") ? "READY" : "WARN";
  const anchoredAssets = [...controller.feeds.keys()].filter((asset) => controller.derived(asset, now).spotSource === "ANCHORED").length;

  return (
    <main className="terminal-shell">
      <aside className="sidebar-rail">
        <div className="brand-mark" aria-label="Polymarket Quant Engine">
          <span className="brand-mark-core">P</span>
          <span className="brand-mark-pulse" />
        </div>
        <nav className="rail-nav" aria-label="Primary navigation">
          {(
            [
              ["overview", <LayoutDashboard key="o" size={19} />, "Overview"],
              ["paper", <BarChart3 key="p" size={19} />, "Paper engine"],
              ["research", <LineChart key="r" size={19} />, "Research"],
              ["account", <CircleDollarSign key="a" size={19} />, "Account"],
              ["live", <Zap key="l" size={19} />, "Live executor"],
            ] as const
          ).map(([id, icon, title]) => (
            <button className={`rail-button ${view === id ? "active" : ""}`} key={id} onClick={() => setView(id)} title={title} type="button">
              {icon}
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="rail-version">v1.0</span>
        </div>
      </aside>
      <section className="terminal-main">
        <header className="topbar">
          <div className="title-block">
            <div className="eyebrow">
              <span className="eyebrow-dot" />
              POLYMARKET / 5M + 15M CRYPTO
            </div>
            <h1>Decision terminal</h1>
            <p>Chainlink-anchored settlement model · official price to beat · fee-curve limit orders · official resolutions.</p>
          </div>
          <div className="topbar-right">
            <div className="connection-strip">
              <StatusDot label="BOOKS" status={status.clob === "LIVE" ? "READY" : "WARN"} detail="CLOB market WebSocket with delta integrity checks" />
              <StatusDot label="CHAINLINK" status={status.rtds === "LIVE" ? "READY" : "WARN"} detail="Polymarket RTDS: Chainlink settlement stream + Binance" />
              <StatusDot label="EXCHANGE" status={status.coinbase === "LIVE" ? "READY" : "WARN"} detail="Coinbase ticker for the underlying" />
              <StatusDot label="ANCHORED" status={anchoredAssets ? "READY" : "WARN"} detail={`${anchoredAssets} assets anchored to the settlement stream`} />
              <StatusDot label="LIVE" status={liveSession?.connected ? "READY" : "LOCKED"} detail="Owner-authenticated live session" />
            </div>
            <div className="topbar-actions">
              <button className="mode-pill runner-pill" onClick={() => setRunnerOpen(true)} type="button">
                <Terminal size={13} />
                HEADLESS RUNNER
              </button>
              <button className="mode-pill account-mode" onClick={() => setAccountDialogOpen(true)} type="button">
                <Wallet size={13} />
                {liveSession?.connected ? "LIVE LINKED" : "LINK ACCOUNT"}
              </button>
              <span className="clock-readout">
                <Clock3 size={14} />
                {clock ? new Date(clock).toLocaleTimeString("en-US", { hour12: false, timeZone: "UTC" }) : "--:--:--"} UTC
              </span>
            </div>
          </div>
        </header>
        {engine.halt ? (
          <div className="critical-banner">
            <AlertTriangle size={17} />
            <span>
              <strong>PAPER HALT</strong> — {engine.halt.reason}
            </span>
            <button onClick={clearHalt} type="button">
              Acknowledge
            </button>
          </div>
        ) : null}
        <div className="terminal-content">
          <div className="workspace-tabs" role="tablist" aria-label="Workspace">
            {(
              [
                ["overview", "Overview"],
                ["paper", "Paper engine"],
                ["research", "Research"],
                ["account", "Account"],
                ["live", "Live executor"],
              ] as const
            ).map(([id, label]) => (
              <button aria-selected={view === id} className={view === id ? "active" : ""} key={id} onClick={() => setView(id)} role="tab" type="button">
                {label}
              </button>
            ))}
            <span className="workspace-tab-spacer" />
            <span className="data-receipt">
              <span className={`status-dot ${feedStatus === "READY" ? "status-ready" : "status-warning"}`} />
              {sockets.join(" / ").toLowerCase()} · {formatAge(status.lastMessageAt, now)} · {status.bookResyncs} book resyncs
            </span>
          </div>
          <section className="control-row" aria-label="Trading controls">
            <div className="engine-state">
              <span className={`engine-pulse ${autoTrade && !engine.halt ? "running" : ""}`} />
              <span>
                <strong>{engine.halt ? "HALTED" : autoTrade ? "PAPER AUTO-TRADE ON" : "PAPER SIGNALS ONLY"}</strong>
                <small>
                  {engine.pending.length} in flight · {paperConfig.latencyMs}ms simulated latency · settles on official outcomes
                </small>
              </span>
            </div>
            <div className="control-buttons">
              <button className={autoTrade ? "button-secondary" : "button-primary"} onClick={() => setAutoTrade((current) => !current)} type="button">
                {autoTrade ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
                {autoTrade ? "PAUSE AUTO" : "START AUTO"}
              </button>
              <button className="button-secondary" disabled={!account.positions.length} onClick={closeAll} type="button">
                <Wallet size={15} />
                SELL ALL
              </button>
              <button className="button-danger" onClick={killSwitch} type="button">
                <Zap size={15} />
                KILL SWITCH
              </button>
            </div>
          </section>

          {view === "account" ? (
            <AccountView
              account={connectedAccount}
              error={accountError}
              loading={accountLoading}
              onConnect={() => setAccountDialogOpen(true)}
              onDisconnect={disconnect}
              onRefresh={() => void fetchAccount(connection.walletAddress)}
            />
          ) : view === "live" ? (
            <LiveExecutionPanel
              marketCount={activeMarkets.length}
              now={now}
              onKill={() => void killLive()}
              onLink={() => setAccountDialogOpen(true)}
              onRefresh={() => void refreshLiveBalance()}
              onRiskChange={(patch) =>
                setLiveRisk((current) =>
                  normalizeLiveRiskConfig({ ...current, ...patch, signal: { ...current.signal, ...(patch.signal ?? {}) } } as Partial<LiveRiskConfig>),
                )
              }
              risk={liveRisk}
              session={liveSession}
              status={liveStatus}
            />
          ) : view === "paper" ? (
            <PaperLabPanel
              account={account}
              clock={now}
              config={paperConfig}
              halt={engine.halt}
              ledgerRows={ledgerRows}
              markets={markets}
              metrics={ledgerMetrics}
              pending={engine.pending.length}
              telegram={telegram}
              onClearHalt={clearHalt}
              onClearLedger={() => {
                if (window.confirm("Clear the decision ledger?")) setLedger(new Map());
              }}
              onConfigChange={(patch) =>
                setPaperConfig((current) =>
                  normalizePaperConfig({ ...current, ...patch, signal: { ...current.signal, ...(patch.signal ?? {}) } } as Partial<PaperConfig>),
                )
              }
              onExportLedger={() => downloadText(`pqe-ledger-${new Date().toISOString().slice(0, 10)}.csv`, decisionLedgerCsv(ledgerRows), "text/csv")}
              onResetAccount={resetAccount}
              onTelegramAlerts={(alerts) => setTelegram((current) => ({ ...current, alerts }))}
              onTelegramConnect={connectTelegram}
              onTelegramDisconnect={() => {
                void telegramRequest({ action: "disconnect" });
                setTelegram((current) => ({ ...current, connected: false, lastStatus: "Telegram unlinked." }));
              }}
              onTelegramTest={() =>
                void sendTelegram(reportRef.current("Manual test"))
                  .then(() => setTelegram((current) => ({ ...current, lastStatus: "Test report sent.", lastError: "" })))
                  .catch((error) => setTelegram((current) => ({ ...current, lastError: error instanceof Error ? error.message : "Send failed." })))
              }
            />
          ) : view === "research" ? (
            <ResearchLab baseParams={paperConfig.signal} onExportRecording={exportRecording} recorded={recordedDataset} />
          ) : (
            <>
              <section className="metric-grid" aria-label="Paper account summary">
                <MetricCard
                  label="EQUITY"
                  value={dollars(equity)}
                  delta={signedDollars(equity - account.startingCash)}
                  deltaTone={toneFor(equity - account.startingCash)}
                  detail="marked to bid"
                  icon={<CircleDollarSign size={17} />}
                  spark={equitySeries.slice(-200)}
                />
                <MetricCard
                  label="CASH"
                  value={dollars(account.cash)}
                  delta={`${account.positions.length} open`}
                  detail="available"
                  icon={<Wallet size={17} />}
                />
                <MetricCard
                  label="DAY P&L"
                  value={signedDollars(dayPnl)}
                  delta={`halt at −${percentage(paperConfig.dailyLossPct)}`}
                  deltaTone={toneFor(dayPnl)}
                  detail="since ET day open"
                  icon={dayPnl >= 0 ? <TrendingUp size={17} /> : <TrendingDown size={17} />}
                />
                <MetricCard
                  label="UNREALIZED"
                  value={signedDollars(unrealized)}
                  delta={`${engine.pending.length} in flight`}
                  deltaTone={toneFor(unrealized)}
                  detail="bid − all-in cost"
                  icon={<Activity size={17} />}
                />
                <MetricCard
                  label="REALIZED"
                  value={signedDollars(account.realizedPnl)}
                  delta={`${account.closedTrades.length} closed`}
                  deltaTone={toneFor(account.realizedPnl)}
                  detail="official settlements + exits"
                  icon={<Target size={17} />}
                />
                <MetricCard label="FEES PAID" value={dollars(account.fees)} delta="fee curve" detail="rate × (p(1−p))^e" icon={<Gauge size={17} />} />
                <MetricCard
                  label="DRAWDOWN"
                  value={percentage(drawdown)}
                  delta={`halt at ${percentage(paperConfig.maxDrawdownPct)}`}
                  deltaTone={drawdown < paperConfig.maxDrawdownPct ? "positive" : "negative"}
                  detail="from peak equity"
                  icon={<Gauge size={17} />}
                />
                <MetricCard
                  label="REALIZED EDGE"
                  value={ledgerMetrics.realizedEdge === null ? "—" : `${(ledgerMetrics.realizedEdge * 100).toFixed(1)}pt`}
                  delta={`${ledgerMetrics.settled} graded`}
                  deltaTone={toneFor(ledgerMetrics.realizedEdge)}
                  detail="first entries, official outcomes"
                  icon={<ShieldCheck size={17} />}
                />
              </section>
              <section className="section-heading">
                <div>
                  <div className="eyebrow">LIVE WINDOWS</div>
                  <h2>Active 5m / 15m markets</h2>
                </div>
                <div className="section-heading-right">
                  <span className="last-tick">
                    {visibleMarkets.length} live · {upcoming} upcoming
                  </span>
                  <div className="filter-tabs" role="tablist" aria-label="Market duration">
                    {(["ALL", "5m", "15m"] as const).map((filter) => (
                      <button
                        aria-selected={durationFilter === filter}
                        className={durationFilter === filter ? "filter-tab active" : "filter-tab"}
                        key={filter}
                        onClick={() => setDurationFilter(filter)}
                        role="tab"
                        type="button"
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                  <button className="icon-button" onClick={() => void controller.refresh()} title="Refresh discovery and books" type="button">
                    {status.lastRestAt === null ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  </button>
                </div>
              </section>
              {status.lastError ? (
                <div className="data-alert">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>Public data warning</strong>
                    <span>{status.lastError}</span>
                  </div>
                </div>
              ) : null}
              <section className="market-layout">
                {visibleMarkets.length ? (
                  <div className="market-grid" aria-label="Live markets">
                    {visibleMarkets.map((market: LiveMarket) => {
                      const signal = signals.get(market.id);
                      return signal ? (
                        <MarketCard
                          feed={controller.derived(market.asset, now)}
                          key={market.id}
                          market={market}
                          onSelect={() => setSelectedMarketId(market.id)}
                          remaining={(market.endTime - now) / 1000}
                          selected={selectedMarket?.id === market.id}
                          signal={signal}
                        />
                      ) : null;
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title={status.lastRestAt === null ? "Connecting to Polymarket" : "No live windows right now"}
                    detail="Discovery runs every 15 s; nothing is fabricated while waiting."
                  />
                )}
                {selectedMarket && selectedSignal ? (
                  <SignalPanel
                    disabled={Boolean(engine.halt)}
                    feed={controller.derived(selectedMarket.asset, now)}
                    market={selectedMarket}
                    now={now}
                    onBuy={manualBuy}
                    signal={selectedSignal}
                    stakeUsd={paperConfig.stakeUsd}
                  />
                ) : null}
              </section>
              <section className="dashboard-grid">
                <article className="panel chart-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">PAPER EQUITY</div>
                      <h3>Equity curve</h3>
                    </div>
                  </div>
                  <div className="chart-wrap">
                    <EquityChart values={equitySeries} color={equity >= account.startingCash ? "#6cf2c4" : "#ff7d8a"} />
                  </div>
                </article>
                <article className="panel positions-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">EXPOSURE</div>
                      <h3>
                        Open positions <span className="heading-muted">/ {account.positions.length}</span>
                      </h3>
                    </div>
                  </div>
                  <div className="positions-table-wrap">
                    <table className="positions-table">
                      <thead>
                        <tr>
                          <th>MARKET</th>
                          <th>SIDE</th>
                          <th>COST</th>
                          <th>BID</th>
                          <th>P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {account.positions.length ? (
                          account.positions.map((position) => {
                            const market = markets.get(position.marketId);
                            const bid = market ? (position.side === "UP" ? market.upBid : market.downBid) : position.mark;
                            const pnl = bid === null ? null : bid * position.shares - position.totalCost;
                            return (
                              <tr key={position.id}>
                                <td>
                                  <strong>{position.marketLabel}</strong>
                                  <small>{position.endTime > now ? `${timeLeft((position.endTime - now) / 1000)} left` : "awaiting resolution"}</small>
                                </td>
                                <td>
                                  <span className={`side-chip ${position.side === "UP" ? "up" : "down"}`}>{position.side}</span>
                                </td>
                                <td>{cents(position.avgEntry)}</td>
                                <td>{cents(bid)}</td>
                                <td className={pnl === null ? "text-muted" : pnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(pnl)}</td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td className="empty-row" colSpan={5}>
                              Flat.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>
              </section>
              <section className="dashboard-grid lower">
                <article className="panel feed-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">AUDIT TRAIL</div>
                      <h3>Engine feed</h3>
                    </div>
                  </div>
                  {logs.length ? (
                    <div className="feed-list">
                      {logs.map((log) => (
                        <div className="feed-row" key={log.id}>
                          <span className="feed-time">{log.time}</span>
                          <span className={`feed-marker ${log.tone}`} />
                          <div>
                            <strong>{log.message}</strong>
                            <small>{log.detail}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No events yet" detail="Fills, misses, settlements, halts, and feed warnings appear here." />
                  )}
                </article>
                <article className="panel risk-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">FEEDS</div>
                      <h3>Settlement anchoring</h3>
                    </div>
                  </div>
                  <div className="positions-table-wrap">
                    <table className="positions-table">
                      <thead>
                        <tr>
                          <th>ASSET</th>
                          <th>SOURCE</th>
                          <th>BASIS</th>
                          <th>VOL/MIN</th>
                          <th>AGE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...controller.feeds.keys()].sort().map((asset) => {
                          const feed = controller.derived(asset, now);
                          return (
                            <tr key={asset}>
                              <td>
                                <strong>{asset}</strong>
                              </td>
                              <td>{feed.spotSource}</td>
                              <td>{feed.basisBps === null ? "—" : `${feed.basisBps.toFixed(1)}bp`}</td>
                              <td>{feed.sigmaPerSqrtSecond ? `${(feed.sigmaPerSqrtSecond * Math.sqrt(60) * 10_000).toFixed(1)}bp` : "—"}</td>
                              <td>{formatAge(feed.spotTimestamp, now)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              </section>
            </>
          )}
          <footer className="terminal-footer">
            <span>
              <Terminal size={14} />
              Same engine in browser and headless runner
            </span>
            <span>
              <ShieldCheck size={14} />
              Paper settles on official outcomes only
            </span>
            <span className="footer-spacer" />
            <span>No strategy is guaranteed to profit. Validate on recorded data first.</span>
          </footer>
        </div>
      </section>
      {accountDialogOpen ? (
        <AccountConnectModal
          connection={connection}
          error={accountError}
          loading={accountLoading}
          onChange={(field, value) => setConnection((current) => ({ ...current, [field]: value }))}
          onClose={() => setAccountDialogOpen(false)}
          onSubmit={() => void connectLive()}
          serverKeyConfigured={serverKeyConfigured}
        />
      ) : null}
      {runnerOpen ? <RunnerSetupModal onClose={() => setRunnerOpen(false)} /> : null}
    </main>
  );
}
