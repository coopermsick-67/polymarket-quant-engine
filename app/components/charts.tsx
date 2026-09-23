import type { MarketCandle } from "../lib/polymarket-data";
import type { ReliabilityBin } from "../lib/replay";

export function Sparkline({
  values,
  color = "#6cf2c4",
  height = 28,
  className = "sparkline",
}: {
  values: number[];
  color?: string;
  height?: number;
  className?: string;
}) {
  const safe = values.length ? values : [0];
  const min = Math.min(...safe);
  const range = Math.max(...safe) - min || 1;
  const points = safe
    .map((value, index) => `${safe.length === 1 ? 50 : (index / (safe.length - 1)) * 100},${3 + (1 - (value - min) / range) * (height - 7)}`)
    .join(" ");
  return (
    <svg aria-hidden="true" className={className} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
      <polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function CandleChart({ label, candles, trend, rsiValue }: { label: string; candles: MarketCandle[]; trend: string; rsiValue: number | null }) {
  const visible = candles.slice(-24);
  const tone = trend === "UP" ? "text-positive" : trend === "DOWN" ? "text-negative" : "text-muted";
  if (!visible.length) {
    return (
      <div className="candle-chart candle-chart-empty">
        <div>
          <strong>{label}</strong>
          <span className={tone}>{trend}</span>
        </div>
        <small>OHLC history unavailable</small>
      </div>
    );
  }
  const low = Math.min(...visible.map((candle) => candle.low));
  const high = Math.max(...visible.map((candle) => candle.high));
  const range = high - low || Math.max(high * 0.0001, 0.000001);
  const width = 280;
  const height = 74;
  const step = width / visible.length;
  const y = (price: number) => 8 + (1 - (price - low) / range) * (height - 16);
  return (
    <div className="candle-chart">
      <div className="candle-chart-heading">
        <strong>{label}</strong>
        <span className={tone}>{trend}</span>
        <small>RSI {rsiValue === null ? "—" : rsiValue.toFixed(0)} · display only</small>
      </div>
      <svg role="img" aria-label={`${label} price candles, trend ${trend}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line className="candle-grid" key={ratio} x1="0" x2={width} y1={8 + ratio * (height - 16)} y2={8 + ratio * (height - 16)} />
        ))}
        {visible.map((candle, index) => {
          const x = step * index + step / 2;
          const color = candle.close >= candle.open ? "#6cf2c4" : "#ff7d8a";
          return (
            <g key={candle.timestamp}>
              <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1" />
              <rect
                x={x - Math.max(1, step * 0.28)}
                y={Math.min(y(candle.open), y(candle.close))}
                width={Math.max(2, step * 0.56)}
                height={Math.max(2, Math.abs(y(candle.open) - y(candle.close)))}
                fill={color}
                rx="0.5"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function EquityChart({ values, color = "#6cf2c4" }: { values: number[]; color?: string }) {
  const safe = values.length ? values : [0];
  const min = Math.min(...safe) - 1;
  const range = Math.max(...safe) + 1 - min || 1;
  const points = safe
    .map((value, index) => `${(safe.length === 1 ? 310 : (index / (safe.length - 1)) * 620).toFixed(1)},${(178 - ((value - min) / range) * 150).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="equity-chart" viewBox="0 0 620 190" preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <defs>
        <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line className="chart-grid-line" x1="0" x2="620" y1="28" y2="28" />
      <line className="chart-grid-line" x1="0" x2="620" y1="78" y2="78" />
      <line className="chart-grid-line" x1="0" x2="620" y1="128" y2="128" />
      <polygon fill="url(#equity-fill)" points={`0,190 ${points} 620,190`} />
      <polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Predicted vs observed frequency per probability bucket; the diagonal is perfect calibration. */
export function ReliabilityChart({ bins }: { bins: ReliabilityBin[] }) {
  const size = 180;
  const filled = bins.filter((bin) => bin.n > 0);
  const maxN = Math.max(1, ...filled.map((bin) => bin.n));
  return (
    <svg className="reliability-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Calibration: predicted versus observed probability">
      <rect x="0" y="0" width={size} height={size} className="reliability-frame" />
      <line x1="0" y1={size} x2={size} y2="0" className="reliability-diagonal" />
      {filled.map((bin) => {
        const cx = bin.predicted * size;
        const cy = size - bin.observed * size;
        return <circle key={bin.from} cx={cx} cy={cy} r={3 + (bin.n / maxN) * 6} className="reliability-point" />;
      })}
    </svg>
  );
}
