import type { OutputCompactorInput, OutputCompactorResult } from "../outputShaper.js";

const ERROR_LINE_RE = /(?:error|fail|fatal|exception|assertion|panic|traceback|ERR!|✖|×)/i;

function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function preserveErrorLines(lines: string[]): string[] {
  const kept = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (ERROR_LINE_RE.test(lines[i] ?? "")) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j += 1) {
        kept.add(j);
      }
    }
  }
  return [...kept].sort((a, b) => a - b).map((idx) => lines[idx] ?? "");
}

export function compactText(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
  const cleaned = stripControlChars(input.text);
  const rawBytes = input.rawBytes;
  if (Buffer.byteLength(cleaned, "utf8") <= maxVisibleBytes) {
    return {
      content: cleaned,
      mode: "raw",
      rawBytes,
      visibleBytes: Buffer.byteLength(cleaned, "utf8"),
      savedBytes: 0,
      reason: "below threshold",
      warnings: []
    };
  }

  const lines = cleaned.split("\n");
  const headCount = Math.min(20, Math.floor(lines.length * 0.15));
  const tailCount = Math.min(15, Math.floor(lines.length * 0.1));
  const errorSnippets = preserveErrorLines(lines);
  const head = lines.slice(0, headCount);
  const tail = lines.slice(Math.max(headCount, lines.length - tailCount));
  const omitted = Math.max(0, lines.length - head.length - tail.length);

  const parts = [
    `Text compacted: ${lines.length} lines -> showing ${head.length + tail.length} lines (${rawBytes} raw bytes).`,
    ...errorSnippets.length ? ["", "Preserved error context:", ...errorSnippets] : [],
    "",
    ...head,
    omitted > 0 ? `\n...[${omitted} lines omitted]...\n` : "",
    ...tail
  ];
  let content = parts.join("\n");
  if (Buffer.byteLength(content, "utf8") > maxVisibleBytes) {
    content = content.slice(0, maxVisibleBytes) + "\n...[truncated to byte cap]";
  }

  const visibleBytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    summary: `Compacted ${lines.length} lines to ${head.length + tail.length} snippets`,
    mode: "compact",
    rawBytes,
    visibleBytes,
    savedBytes: Math.max(0, rawBytes - visibleBytes),
    reason: "line budget exceeded",
    warnings: omitted > 0 ? [`Omitted ${omitted} middle lines`] : []
  };
}