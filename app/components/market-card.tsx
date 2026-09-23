import type { MarketSignal } from "../lib/engines";
import type { DerivedFeed } from "../lib/feeds";
import type { LiveMarket } from "../lib/polymarket-data";
import { Sparkline } from "./charts";
import { assetTone, cents, formatSpot, percentage, points, timeLeft } from "./format";

export function MarketCard({
  market,
  signal,
  feed,
  remaining,
  selected,
  onSelect,
}: {
  market: LiveMarket;
  signal: MarketSignal;
  feed: DerivedFeed | null;
  remaining: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const actionTone = signal.action === "PASS" ? "warning" : signal.action === "UP" ? "positive" : "negative";
  const distanceBps = market.reference !== null && feed?.spot ? ((feed.spot - market.reference) / market.reference) * 10_000 : null;
  const recent = feed?.ticks.slice(-120).map((tick) => tick.price) ?? [];
  return (
    <button className={`market-card ${selected ? "market-card-selected" : ""}`} onClick={onSelect} type="button">
      <div className="market-card-header">
        <div className="market-identity">
          <span className={`asset-token ${assetTone(market.asset)}`}>{market.asset.slice(0, 1)}</span>
          <span>
            <strong>{market.asset}</strong>
            <small>
              {market.duration} · {market.twapLookbackSeconds ? `${market.twapLookbackSeconds}s TWAP` : "point"} settle
            </small>
          </span>
        </div>
        <span className={`action-pill ${actionTone}`}>{signal.action === "PASS" ? `PASS · ${signal.gate}` : `${signal.tier} ${signal.action}`}</span>
      </div>
      <div className="market-question">{market.question}</div>
      <div className="market-price-row">
        <div>
          <small>TIME LEFT</small>
          <strong className="countdown">{timeLeft(remaining)}</strong>
        </div>
        <div className="market-spot">
          <small>UNDERLYING · {feed?.spotSource ?? "MISSING"}</small>
          <strong>{formatSpot(market.asset, feed?.spot)}</strong>
          <small className="market-reference" title="Official price to beat: the Chainlink TWAP-stream value at the window start.">
            {market.reference === null
              ? "price to beat pending"
              : `beat ${formatSpot(market.asset, market.reference)}${distanceBps === null ? "" : ` · ${distanceBps >= 0 ? "+" : ""}${distanceBps.toFixed(1)}bp`}`}
          </small>
        </div>
      </div>
      {recent.length > 2 ? <Sparkline values={recent} color={distanceBps !== null && distanceBps < 0 ? "#ff7d8a" : "#6cf2c4"} height={22} /> : null}
      <div className="book-grid">
        <div>
          <span>UP</span>
          <strong>{cents(market.upAsk)}</strong>
          <small>bid {cents(market.upBid)}</small>
        </div>
        <div>
          <span>DOWN</span>
          <strong>{cents(market.downAsk)}</strong>
          <small>bid {cents(market.downBid)}</small>
        </div>
        <div>
          <span>P(UP)</span>
          <strong>{percentage(signal.fairUp)}</strong>
          <small>
            model {percentage(signal.modelUp)} · book {percentage(signal.marketUp)}
          </small>
        </div>
      </div>
      <div className="market-footer">
        <span className="market-edge">
          <span className="metric-label">EDGE UP / DOWN</span>
          <strong className={signal.action !== "PASS" ? "text-positive" : "text-muted"}>
            {points(signal.upEdge)} / {points(signal.downEdge)}
          </strong>
        </span>
        <span className="market-liquidity">
          <span className="metric-label">FLOOR</span>
          <strong>{points(signal.requiredEdge)}</strong>
        </span>
      </div>
    </button>
  );
}
