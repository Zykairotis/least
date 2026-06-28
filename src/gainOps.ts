import { getDiscoverSnapshot, getGainSnapshot, type PerfWindowName } from "./perf.js";

export function formatLeastGainText(snapshot: Record<string, unknown>): string {
  const lines = [
    "Least gain this session",
    `- Raw bytes processed: ${formatBytes(Number(snapshot.raw_bytes_processed ?? 0))}`,
    `- Model-visible bytes emitted: ${formatBytes(Number(snapshot.visible_bytes_emitted ?? 0))}`,
    `- Estimated visible-token reduction: ${snapshot.estimated_visible_token_reduction ?? 0}%`,
    "- Top savers:"
  ];
  const savers = Array.isArray(snapshot.top_savers) ? snapshot.top_savers : [];
  savers.slice(0, 5).forEach((item, idx) => {
    const row = item as Record<string, unknown>;
    lines.push(`  ${idx + 1}. ${row.key}: ${formatBytes(Number(row.raw_bytes ?? 0))} -> ${formatBytes(Number(row.visible_bytes ?? 0))}`);
  });
  lines.push(`- Retrievals used: ${snapshot.retrievals_used ?? 0}`);
  lines.push(`- Compactor fallbacks: ${snapshot.compactor_fallbacks ?? 0}`);
  return lines.join("\n");
}

export function formatLeastDiscoverText(snapshot: Record<string, unknown>): string {
  const lines = ["Least discover — missed optimization opportunities", ""];
  const recs = Array.isArray(snapshot.recommendations) ? snapshot.recommendations : [];
  if (!recs.length) lines.push("No obvious missed opportunities recorded yet.");
  else recs.forEach((rec, idx) => lines.push(`${idx + 1}. ${rec}`));
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function leastGain(window: PerfWindowName = "session", format: "text" | "json" = "text"): string | Record<string, unknown> {
  const snapshot = getGainSnapshot(window);
  return format === "json" ? snapshot : formatLeastGainText(snapshot);
}

export function leastDiscover(window: PerfWindowName = "session"): Record<string, unknown> {
  return getDiscoverSnapshot(window);
}