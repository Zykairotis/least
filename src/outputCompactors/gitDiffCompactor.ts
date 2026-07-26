import type { OutputCompactorInput, OutputCompactorResult } from "../outputShaper.js";

const LOCKFILE_RE = /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock)/i;
const HIGH_SIGNAL_RE = /(?:import |export |function |class |interface |type |describe\(|it\(|test\(|assert|expect\(|scripts|"dependencies"|"devDependencies")/;

function isLockfilePath(line: string): boolean {
  return LOCKFILE_RE.test(line);
}

function splitHunks(diff: string): string[] {
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length) {
      hunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) hunks.push(current.join("\n"));
  return hunks;
}

function scoreHunk(hunk: string): number {
  let score = 0;
  if (hunk.includes("Binary files")) score += 100;
  if (HIGH_SIGNAL_RE.test(hunk)) score += 20;
  if (hunk.includes("package.json")) score += 30;
  if (isLockfilePath(hunk)) score -= 50;
  const adds = (hunk.match(/^\+[^+]/gm) ?? []).length;
  const dels = (hunk.match(/^-[^-]/gm) ?? []).length;
  score += Math.min(10, adds + dels);
  return score;
}

export function compactGitDiff(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
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

  const hunks = splitHunks(input.text);
  const fileSummaries: string[] = [];
  const keptHunks: string[] = [];

  for (const hunk of hunks) {
    const fileLine = hunk.split("\n").find((l) => l.startsWith("+++ b/")) ?? hunk.split("\n")[0] ?? "";
    const adds = (hunk.match(/^\+[^+]/gm) ?? []).length;
    const dels = (hunk.match(/^-[^-]/gm) ?? []).length;
    fileSummaries.push(`${fileLine.replace("+++ b/", "")} +${adds} -${dels}`);

    if (hunk.includes("Binary files")) {
      keptHunks.push(hunk);
      continue;
    }
    if (isLockfilePath(hunk) && hunk.length > 2000) {
      keptHunks.push(`${hunk.split("\n").slice(0, 4).join("\n")}\n...[lockfile hunk summarized: ${adds}+ ${dels}-]`);
      continue;
    }
    if (Buffer.byteLength(hunk, "utf8") <= 4000) {
      keptHunks.push(hunk);
      continue;
    }
    const lines = hunk.split("\n");
    const header = lines.slice(0, 6);
    const signal = lines.filter((l) => HIGH_SIGNAL_RE.test(l) || l.startsWith("@@")).slice(0, 40);
    keptHunks.push([...header, ...signal, `...[large hunk compacted: ${adds}+ ${dels}-]`].join("\n"));
  }

  const highSignal = fileSummaries
    .filter((_, idx) => scoreHunk(keptHunks[idx] ?? "") >= 20)
    .slice(0, 8);
  const parts = [
    `Git diff compacted: ${hunks.length} files.`,
    "File summary:",
    ...fileSummaries.map((s) => `  ${s}`),
    ...(highSignal.length ? ["", "High-signal files:", ...highSignal.map((s) => `  ${s}`)] : []),
    "",
    ...keptHunks
  ];
  let content = parts.join("\n");
  if (Buffer.byteLength(content, "utf8") > maxVisibleBytes) {
    content = content.slice(0, maxVisibleBytes) + "\n...[diff compact truncated]";
  }
  const visibleBytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    summary: `Compacted ${hunks.length} file diffs`,
    mode: "compact",
    rawBytes,
    visibleBytes,
    savedBytes: Math.max(0, rawBytes - visibleBytes),
    reason: "hunk scoring",
    warnings: []
  };
}