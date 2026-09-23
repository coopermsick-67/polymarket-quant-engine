import { Database } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "./charts";
import type { Tone } from "./format";

export function StatusDot({ label, status, detail }: { label: string; status: "READY" | "PUBLIC" | "WARN" | "LOCKED"; detail: string }) {
  const statusClass = status === "READY" ? "status-ready" : status === "PUBLIC" ? "status-sim" : status === "WARN" ? "status-warning" : "status-locked";
  return (
    <div className="status-item" title={detail}>
      <span className={`status-dot ${statusClass}`} />
      <span className="status-label">{label}</span>
      <span className={`status-value ${statusClass}`}>{status}</span>
    </div>
  );
}

export function MetricCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  detail,
  icon,
  spark,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: Tone;
  detail: string;
  icon: ReactNode;
  spark?: number[];
}) {
  return (
    <article className="metric-card">
      <div className="metric-topline">
        <span className="metric-label">{label}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-bottom">
        <span className={`delta ${deltaTone}`}>{delta}</span>
        <span className="metric-detail">{detail}</span>
      </div>
      {spark && spark.length > 1 ? <Sparkline values={spark} color={deltaTone === "negative" ? "#ff7d8a" : "#6cf2c4"} /> : null}
    </article>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Database size={18} />
      </div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}
