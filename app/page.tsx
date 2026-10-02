"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyPolymarketPriceTicks,
  buildLiveMarket,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  synchronizedPolymarketTime,
  type LiveMarket,
  type PolymarketPriceTick,
} from "./lib/polymarket-data";
import {
  subscribePolymarketPrices,
  type PolymarketPriceStreamStatus,
} from "./lib/polymarket-price-stream";

type Side = "UP" | "DOWN";

type Vote = {
  label: string;
  side: Side;
  detail: string;
};

type LockedSignal = {
  marketId: string;
  question: string;
  side: Side;
  lockedAt: number;
  lockedRemaining: number;
  reference: number | null;
  settlement: number | null;
  spot: number | null;
  entryAsk: number | null;
  method: "ORACLE" | "FALLBACK";
  votes: Vote[];
};

const LOCK_AT_REMAINING = 10 * 60;
const FORCE_AT_REMAINING = 8 * 60;
const SIGNALS_STORAGE_KEY = "btc15-one-shot-signals-v1";

const money = (value: number | null, digits = 2) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return "$" + value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const cents = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return (value * 100).toFixed(1) + "¢";
};

const signedBps = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  const bps = value * 10000;
  return (bps >= 0 ? "+" : "") + bps.toFixed(1) + " bps";
};

const countdown = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const secs = (safe % 60).toString().padStart(2, "0");
  return minutes + ":" + secs;
};

const readStoredSignals = (): Record<string, LockedSignal> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SIGNALS_STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, LockedSignal> : {};
  } catch {
    return {};
  }
};

const bookTieBreak = (market: LiveMarket): Side => {
  if (market.upAsk !== null && market.downAsk !== null) {
    return market.upAsk >= market.downAsk ? "UP" : "DOWN";
  }
  if (market.spot !== null && market.reference !== null) {
    return market.spot >= market.reference ? "UP" : "DOWN";
  }
  const candles = market.chart15m;
  if (candles.length >= 2) {
    return candles[candles.length - 1].close >= candles[candles.length - 2].close ? "UP" : "DOWN";
  }
  return "UP";
};

const momentumVote = (market: LiveMarket, now: number): Vote | null => {
  const history = (market.spotHistory ?? [])
    .filter((tick) => tick.timestamp <= now && Number.isFinite(tick.price) && tick.price > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (history.length < 2) return null;

  const latest = history[history.length - 1];
  const target = latest.timestamp - 180_000;
  let prior = history[0];
  for (const tick of history) {
    if (tick.timestamp <= target) prior = tick;
    else break;
  }
  if (!prior || prior.price <= 0 || latest.timestamp - prior.timestamp < 45_000) return null;

  const move = latest.price / prior.price - 1;
  return {
    label: "3-minute momentum",
    side: move >= 0 ? "UP" : "DOWN",
    detail: signedBps(move),
  };
};

const buildDecision = (market: LiveMarket, now: number): Omit<LockedSignal, "marketId" | "question" | "lockedAt" | "lockedRemaining"> | null => {
  const remaining = Math.max(0, Math.ceil((market.endTime - now) / 1000));
  if (remaining > LOCK_AT_REMAINING) return null;

  const votes: Vote[] = [];

  if (market.reference !== null && market.settlementPrice !== null) {
    const gap = market.settlementPrice / market.reference - 1;
    votes.push({
      label: "60s TWAP vs open",
      side: gap >= 0 ? "UP" : "DOWN",
      detail: signedBps(gap),
    });
  }

  if (market.reference !== null && market.spot !== null) {
    const gap = market.spot / market.reference - 1;
    votes.push({
      label: "Chainlink spot vs open",
      side: gap >= 0 ? "UP" : "DOWN",
      detail: signedBps(gap),
    });
  }

  const momentum = momentumVote(market, now);
  if (momentum) votes.push(momentum);

  const fullOracleReady = market.referenceVerified && market.reference !== null && votes.length >= 2;
  if (!fullOracleReady && remaining > FORCE_AT_REMAINING) return null;

  let side: Side;
  if (votes.length) {
    const upVotes = votes.filter((vote) => vote.side === "UP").length;
    const downVotes = votes.length - upVotes;
    side = upVotes === downVotes ? bookTieBreak(market) : upVotes > downVotes ? "UP" : "DOWN";
  } else {
    side = bookTieBreak(market);
    votes.push({
      label: "Fallback tie-break",
      side,
      detail: "Oracle inputs unavailable by 08:00",
    });
  }

  return {
    side,
    reference: market.reference,
    settlement: market.settlementPrice ?? null,
    spot: market.spot,
    entryAsk: side === "UP" ? market.upAsk : market.downAsk,
    method: fullOracleReady ? "ORACLE" : "FALLBACK",
    votes,
  };
};

export default function Home() {
  const [markets, setMarkets] = useState<LiveMarket[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [status, setStatus] = useState<"LOADING" | "READY" | "ERROR">("LOADING");
  const [error, setError] = useState("");
  const [streamStatus, setStreamStatus] = useState<PolymarketPriceStreamStatus>("CONNECTING");
  const [signals, setSignals] = useState<Record<string, LockedSignal>>({});
  const [signalsLoaded, setSignalsLoaded] = useState(false);
  const tickCache = useRef<Map<string, PolymarketPriceTick>>(new Map());
  const refreshBusy = useRef(false);

  useEffect(() => {
    setSignals(readStoredSignals());
    setSignalsLoaded(true);
  }, []);

  useEffect(() => {
    if (!signalsLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(SIGNALS_STORAGE_KEY, JSON.stringify(signals));
  }, [signals, signalsLoaded]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const stop = subscribePolymarketPrices(
      ["BTC"],
      (ticks) => {
        for (const tick of ticks) {
          const key = tick.asset + ":" + tick.priceFeed + ":" + tick.timestamp;
          tickCache.current.set(key, tick);
        }
        if (tickCache.current.size > 1500) {
          const ordered = [...tickCache.current.entries()]
            .sort((left, right) => left[1].timestamp - right[1].timestamp)
            .slice(-1000);
          tickCache.current = new Map(ordered);
        }
        const localNow = Date.now();
        setMarkets((current) => current.map((market) => applyPolymarketPriceTicks(market, ticks, localNow)));
      },
      setStreamStatus,
      controller.signal,
    );
    return () => {
      controller.abort();
      stop();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    const controller = new AbortController();
    try {
      const now = synchronizedPolymarketTime(Date.now());
      const definitions = (await discoverCryptoMarkets(controller.signal))
        .filter((market) => market.asset === "BTC" && market.duration === "15m" && market.endTime > now)
        .sort((left, right) => left.endTime - right.endTime)
        .slice(0, 3);

      const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]);
      const [books, candles] = await Promise.all([
        fetchOrderBooks(tokenIds, controller.signal),
        fetchCandleHistories(["BTC"], controller.signal),
      ]);

      const snapshot = [...tickCache.current.values()];
      const built = definitions.map((definition) => applyPolymarketPriceTicks(
        buildLiveMarket(
          definition,
          books,
          new Map(),
          null,
          Date.now(),
          candles.get("BTC") ?? null,
        ),
        snapshot,
        Date.now(),
      ));

      setMarkets(built);
      setStatus("READY");
      setError("");
    } catch (cause) {
      setStatus("ERROR");
      setError(cause instanceof Error ? cause.message : "Unable to load the BTC 15-minute market.");
    } finally {
      refreshBusy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const polymarketNow = synchronizedPolymarketTime(clock);
  const activeMarket = useMemo(() => {
    const live = markets.find((market) => market.startTime !== null && market.startTime <= polymarketNow && market.endTime > polymarketNow);
    return live ?? markets[0] ?? null;
  }, [markets, polymarketNow]);

  const remaining = activeMarket
    ? Math.max(0, Math.ceil((activeMarket.endTime - polymarketNow) / 1000))
    : 0;

  const locked = activeMarket ? signals[activeMarket.id] ?? null : null;

  useEffect(() => {
    if (!signalsLoaded || !activeMarket || locked) return;
    if (activeMarket.startTime !== null && polymarketNow < activeMarket.startTime) return;

    const decision = buildDecision(activeMarket, polymarketNow);
    if (!decision) return;

    const next: LockedSignal = {
      marketId: activeMarket.id,
      question: activeMarket.question,
      lockedAt: polymarketNow,
      lockedRemaining: Math.max(0, Math.ceil((activeMarket.endTime - polymarketNow) / 1000)),
      ...decision,
    };

    setSignals((current) => ({ ...current, [activeMarket.id]: next }));
  }, [activeMarket, locked, polymarketNow, signalsLoaded]);

  const reference = activeMarket?.reference ?? null;
  const settlement = activeMarket?.settlementPrice ?? null;
  const spot = activeMarket?.spot ?? null;
  const twapGap = reference !== null && settlement !== null ? settlement / reference - 1 : null;
  const spotGap = reference !== null && spot !== null ? spot / reference - 1 : null;
  const momentum = activeMarket ? momentumVote(activeMarket, polymarketNow) : null;

  const preLock = activeMarket && !locked && remaining > LOCK_AT_REMAINING;
  const waitingData = activeMarket && !locked && remaining <= LOCK_AT_REMAINING;
  const nextLockIn = Math.max(0, remaining - LOCK_AT_REMAINING);

  const signalClass = locked ? "signal signal-" + locked.side.toLowerCase() : "signal signal-waiting";
  const streamLabel = streamStatus === "CONNECTED" ? "LIVE" : streamStatus === "CONNECTING" ? "CONNECTING" : "RECONNECTING";

  return (
    <main className="app-shell">
      <section className="terminal">
        <header className="topbar">
          <div>
            <div className="eyebrow">BTC 15M · ONE SHOT</div>
            <h1>Bitcoin Up / Down</h1>
            <p>One decision. One entry. Locked until resolution.</p>
          </div>
          <div className="status-row">
            <span className={"status-chip " + (status === "READY" ? "ok" : status === "ERROR" ? "bad" : "")}>
              DATA {status}
            </span>
            <span className={"status-chip " + (streamStatus === "CONNECTED" ? "ok" : "")}>
              ORACLE {streamLabel}
            </span>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        {!activeMarket ? (
          <section className="empty-state">
            <div className="spinner" />
            <h2>Finding the active BTC 15-minute market</h2>
            <p>The page only accepts BTC 15m Up/Down markets.</p>
          </section>
        ) : (
          <>
            <section className="market-strip">
              <div>
                <span className="label">MARKET</span>
                <strong>{activeMarket.question}</strong>
              </div>
              <div className="timer-block">
                <span className="label">TIME LEFT</span>
                <strong className={remaining <= 120 ? "timer danger" : "timer"}>{countdown(remaining)}</strong>
              </div>
            </section>

            <section className={signalClass}>
              <span className="signal-kicker">{locked ? "LOCKED SIGNAL" : preLock ? "DECISION PENDING" : "LOCK WINDOW"}</span>
              <div className="signal-main">
                <strong>{locked ? locked.side : preLock ? countdown(nextLockIn) : "READING"}</strong>
                <span>{locked ? "HOLD TO RESOLUTION" : preLock ? "UNTIL LOCK" : waitingData ? "WAITING FOR ORACLE" : "WAITING"}</span>
              </div>
              <p>
                {locked
                  ? "This side will not flip for this market. The signal is stored locally by market ID."
                  : "Target lock is 10:00 remaining. If oracle inputs are late, the system waits until they arrive and forces a tie-break by 08:00 remaining."}
              </p>
              {locked ? (
                <div className="locked-meta">
                  <span>Locked at {countdown(locked.lockedRemaining)} left</span>
                  <span>{locked.method === "ORACLE" ? "Oracle vote" : "Fallback vote"}</span>
                  <span>Entry ask {cents(locked.entryAsk)}</span>
                </div>
              ) : null}
            </section>

            <section className="metric-grid">
              <article className="metric">
                <span>PRICE TO BEAT</span>
                <strong>{money(reference)}</strong>
                <small>{activeMarket.referenceVerified ? "Exact Polymarket opening oracle" : "Waiting for exact opening tick"}</small>
              </article>
              <article className="metric">
                <span>60s TWAP NOW</span>
                <strong>{money(settlement)}</strong>
                <small>{signedBps(twapGap)} vs open</small>
              </article>
              <article className="metric">
                <span>CHAINLINK SPOT</span>
                <strong>{money(spot)}</strong>
                <small>{signedBps(spotGap)} vs open</small>
              </article>
              <article className="metric">
                <span>3-MIN MOMENTUM</span>
                <strong>{momentum?.side ?? "—"}</strong>
                <small>{momentum?.detail ?? "Building history"}</small>
              </article>
            </section>

            <section className="rule-card">
              <div className="rule-heading">
                <div>
                  <span className="label">STUPID-SIMPLE RULE</span>
                  <h2>Three votes at 10:00 remaining</h2>
                </div>
                <span className="rule-badge">NO FLIPS</span>
              </div>
              <div className="rule-grid">
                <div><b>1</b><span>60s TWAP above opening price = UP, below = DOWN.</span></div>
                <div><b>2</b><span>Chainlink spot above opening price = UP, below = DOWN.</span></div>
                <div><b>3</b><span>Last ~3 minutes of Chainlink spot momentum up = UP, down = DOWN.</span></div>
              </div>
              <p className="rule-note">Majority wins. A tie uses the live Polymarket book. Once selected, the side is frozen through settlement.</p>
            </section>

            <section className="votes-card">
              <div className="rule-heading">
                <div>
                  <span className="label">LOCK EVIDENCE</span>
                  <h2>{locked ? locked.side + " was locked" : "Waiting to lock"}</h2>
                </div>
              </div>
              <div className="vote-list">
                {(locked?.votes ?? []).length ? locked?.votes.map((vote) => (
                  <div className="vote-row" key={vote.label}>
                    <span>{vote.label}</span>
                    <strong className={vote.side === "UP" ? "up-text" : "down-text"}>{vote.side}</strong>
                    <small>{vote.detail}</small>
                  </div>
                )) : (
                  <div className="vote-row muted">
                    <span>No frozen votes yet</span>
                    <strong>—</strong>
                    <small>Decision locks once the timer reaches the entry window.</small>
                  </div>
                )}
              </div>
            </section>

            <section className="book-card">
              <div><span>UP ASK</span><strong className="up-text">{cents(activeMarket.upAsk)}</strong></div>
              <div><span>DOWN ASK</span><strong className="down-text">{cents(activeMarket.downAsk)}</strong></div>
              <div><span>MODE</span><strong>HOLD TO RESOLUTION</strong></div>
            </section>

            <footer>
              <span>Signal tool only — it does not submit an order automatically.</span>
              {activeMarket.sourceUrl ? (
                <a href={activeMarket.sourceUrl} target="_blank" rel="noreferrer">Open market ↗</a>
              ) : null}
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
