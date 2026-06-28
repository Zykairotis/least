import type { OutputCompactorInput, OutputCompactorResult } from "../outputShaper.js";

export function compactShowChanges(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
  const rawBytes = input.rawBytes;
  if (Buffer.byteLength(input.text, "utf8") <= maxVisibleBytes) {
    return {
      content: input.text,
      mode: "raw",
      rawBytes,
      visibleBytes: rawBytes,
      savedBytes: 0,
      reason: "below threshold",
      warnings: []
    };
  }

  const lines = input.text.split("\n");
  const kept: string[] = [];
  const buckets = { staged: [] as string[], unstaged: [] as string[], untracked: [] as string[], other: [] as string[] };

  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("# ") || line.startsWith("Workspace:")) {
      kept.push(line);
      continue;
    }
    const statusLine = line.match(/^[-*]\s+([ MADRCU?]{1,2})\s+(.+)/);
    if (statusLine) {
      const status = statusLine[1] ?? "";
      const path = statusLine[2] ?? "";
      if (status.includes("?")) buckets.untracked.push(path);
      else if (status[0] !== " " && status[0] !== "?") buckets.staged.push(path);
      else buckets.unstaged.push(path);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) continue;
    if (line.startsWith("-") && !line.startsWith("---")) continue;
    if (line.startsWith("@@")) kept.push(line);
  }

  const summary = [
    "",
    "## Buckets",
    `Staged: ${buckets.staged.length}`,
    `Unstaged: ${buckets.unstaged.length}`,
    `Untracked: ${buckets.untracked.length}`,
    "",
    "## Top paths",
    ...buckets.staged.slice(0, 8).map((p) => `S ${p}`),
    ...buckets.unstaged.slice(0, 8).map((p) => `U ${p}`),
    ...buckets.untracked.slice(0, 12).map((p) => `? ${p}`)
  ];
  if (buckets.untracked.length && !buckets.staged.length && !buckets.unstaged.length) {
    summary.push("", "No tracked diff exists; untracked files listed above.");
  }

  let content = [...kept, ...summary].join("\n");
  if (Buffer.byteLength(content, "utf8") > maxVisibleBytes) {
    content = content.slice(0, maxVisibleBytes) + "\n...[show_changes compact truncated]";
  }
  const visibleBytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    summary: `Buckets: staged=${buckets.staged.length} unstaged=${buckets.unstaged.length} untracked=${buckets.untracked.length}`,
    mode: "compact",
    rawBytes,
    visibleBytes,
    savedBytes: Math.max(0, rawBytes - visibleBytes),
    reason: "bucket summary",
    warnings: []
  };
}