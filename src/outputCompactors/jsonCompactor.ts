import type { OutputCompactorInput, OutputCompactorResult } from "../outputShaper.js";

function summarizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length <= 120) return value;
    return `${value.slice(0, 80)}…[${value.length} chars]`;
  }
  if (Array.isArray(value)) {
    if (value.length <= 6) return value.map((item) => summarizeValue(item, depth + 1));
    const first = value.slice(0, 3).map((item) => summarizeValue(item, depth + 1));
    const last = value.slice(-2).map((item) => summarizeValue(item, depth + 1));
    return { _summary: `array[${value.length}]`, first, last };
  }
  if (value && typeof value === "object") {
    if (depth > 4) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = summarizeValue(child, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function compactJson(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
  const rawBytes = input.rawBytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return {
      content: input.text.slice(0, maxVisibleBytes),
      mode: "truncated",
      rawBytes,
      visibleBytes: Math.min(rawBytes, maxVisibleBytes),
      savedBytes: Math.max(0, rawBytes - maxVisibleBytes),
      reason: "invalid json fallback truncate",
      warnings: ["Input was not valid JSON; truncated as text"]
    };
  }

  const summary = summarizeValue(parsed, 0);
  const content = `JSON summary (not original data):\n${JSON.stringify(summary, null, 2)}`;
  const visibleBytes = Buffer.byteLength(content, "utf8");
  if (visibleBytes >= rawBytes) {
    return {
      content: input.text,
      mode: "raw",
      rawBytes,
      visibleBytes: rawBytes,
      savedBytes: 0,
      reason: "summary not smaller",
      warnings: []
    };
  }
  return {
    content,
    summary: "Summarized large JSON structure",
    mode: "compact",
    rawBytes,
    visibleBytes,
    savedBytes: rawBytes - visibleBytes,
    reason: "json summary",
    warnings: []
  };
}