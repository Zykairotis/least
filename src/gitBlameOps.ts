import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { recordBackend, recordCacheOutcome } from "./perf.js";
import { runCappedProcess } from "./processRunner.js";
import { redactSensitiveText } from "./redact.js";
import { getCachedGitValue, setCachedGitValue } from "./workspaceCache.js";

export interface BlameLine {
  sha: string;
  author: string;
  date: string;
  line: number;
  content: string;
}

// ponytail: porcelain is the stable machine-readable blame format; no --line-porcelain flag matters.
async function runGitBlame(workspace: Workspace, args: string[], maxOutputBytes: number): Promise<string> {
  try {
    const result = await runCappedProcess({
      command: "git",
      args,
      cwd: workspace.root,
      maxOutputBytes,
      backend: "git",
      allowNonZeroExit: true
    });
    if (result.code !== 0 && !result.timedOut) {
      const stderr = result.stderr.trim();
      return stderr || `git exited with status ${result.code}`;
    }
    return redactSensitiveText(result.stdout || "");
  } catch (error) {
    return `git blame unavailable or failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Parser for `git blame --line-porcelain`: rows are tab-separated lines prefaced by
// <sha> <orig-line> <final-line> <num-lines>\n then key/value header pairs then a TAB line body.
function parseBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split("\n");
  const result: BlameLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    if (!header || header.startsWith("boundary")) {
      i += 1;
      continue;
    }
    const parts = header.split(" ");
    const sha = parts[0] ?? "";
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
      i += 1;
      continue;
    }
    const finalLine = Number(parts[2] ?? parts[1] ?? "0");
    let author = "";
    let date = "";
    let content = "";
    i += 1;
    while (i < lines.length) {
      const row = lines[i];
      if (row.startsWith("\t")) {
        content = row.slice(1);
        i += 1;
        break;
      }
      if (row.startsWith("author ")) author = row.slice("author ".length);
      else if (row.startsWith("author-mail ")) author = `${author} ${row.slice("author-mail ".length)}`.trim();
      else if (row.startsWith("author-time ")) date = row.slice("author-time ".length);
      i += 1;
    }
    result.push({ sha: sha.slice(0, 8), author, date, line: finalLine, content });
  }
  return result;
}

export async function gitBlameForRange(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  file: string,
  startLine: number,
  endLine: number
): Promise<BlameLine[]> {
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.max(start, Math.floor(endLine));
  const cacheKey = `blame:${file}:${start}-${end}`;
  const cached = getCachedGitValue(workspace.id, cacheKey);
  if (cached) {
    recordCacheOutcome(true);
    recordBackend("cache");
    return parseBlamePorcelain(cached.value);
  }
  recordCacheOutcome(false);
  const resolved = guard.resolve(workspace, file);
  const args = ["blame", "--line-porcelain", "-L", `${start},${end}`, "--", resolved.relPath];
  const raw = await runGitBlame(workspace, args, config.maxOutputBytes);
  if (!raw || raw.startsWith("git blame unavailable") || raw.startsWith("git exited")) {
    setCachedGitValue(workspace.id, cacheKey, "", 1_500);
    return [];
  }
  const parsed = parseBlamePorcelain(raw);
  setCachedGitValue(workspace.id, cacheKey, raw, 1_500);
  return parsed;
}

export function formatBlameBlock(blames: BlameLine[]): string {
  if (!blames.length) return "";
  const rows = blames.map((b) => `${b.sha}  ${b.author || "unknown"}  L${b.line}`);
  return `blame:\n${rows.join("\n")}`;
}
