import type { ReactNode } from "react";

interface MetricCardProps {
  title: string;
  value: string | number;
  label?: string;
  icon?: ReactNode;
  pill?: ReactNode;
}

export function MetricCard({ title, value, label, icon, pill }: MetricCardProps) {
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        {icon && <span style={{ color: "var(--accent-gray)" }}>{icon}</span>}
        <div className="card-header">{title}</div>
        {pill && <span style={{ marginLeft: "auto" }}>{pill}</span>}
      </div>
      <div className="card-value">{value}</div>
      {label && <div className="card-label">{label}</div>}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
}

export function StatusPill({ status }: { status: string }) {
  const cls = status === "ok" ? "pill-ok"
    : status === "error" ? "pill-error"
    : status === "warn" ? "pill-warn"
    : status === "running" ? "pill-running"
    : "pill-info";
  return <span className={`pill ${cls}`}>{status}</span>;
}
