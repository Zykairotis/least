import fsp from "node:fs/promises";
import path from "node:path";
import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { parseGitStatusEntries } from "./reviewOps.js";
import { gitStatus } from "./gitOps.js";
import { REVIEW_GIT_STATUS_OPTIONS } from "./reviewOps.js";

export interface MinimalityFinding {
  title: string;
  file: string;
  detail: string;
  recommendation: string;
  risk: "low" | "medium" | "high";
}

const NATIVE_HINTS: Array<{ pattern: RegExp; native: string }> = [
  { pattern: /left-pad|pad-start-polyfill/i, native: "String.prototype.padStart" },
  { pattern: /uuid|nanoid/i, native: "crypto.randomUUID" },
  { pattern: /query-string|qs\b/i, native: "URLSearchParams" }
];

export async function reviewMinimality(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { path?: string; includeUntracked?: boolean; maxFindings?: number } = {}
): Promise<{ text: string; findings: MinimalityFinding[] }> {
  const status = await gitStatus(config, workspace, guard, options.path, REVIEW_GIT_STATUS_OPTIONS);
  const entries = parseGitStatusEntries(status).filter((entry) => options.includeUntracked !== false || entry.status !== "??");
  const findings: MinimalityFinding[] = [];
  const maxFindings = options.maxFindings ?? 8;

  let pkgText = "";
  try {
    pkgText = await fsp.readFile(path.join(workspace.root, "package.json"), "utf8");
  } catch {
    pkgText = "";
  }
  if (pkgText) {
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
    for (const [dep, hint] of NATIVE_HINTS.map((item) => {
      const hit = Object.keys(deps).find((name) => item.pattern.test(name));
      return hit ? ([hit, item.native] as const) : undefined;
    }).filter(Boolean) as Array<[string, string]>) {
      findings.push({
        title: "New dependency may be unnecessary",
        file: "package.json",
        detail: `Dependency: ${dep}`,
        recommendation: `Consider native alternative: ${hint}`,
        risk: "medium"
      });
    }
  }

  for (const entry of entries) {
    if (findings.length >= maxFindings) break;
    if (!entry.path.endsWith(".ts") && !entry.path.endsWith(".js")) continue;
    try {
      const resolved = guard.resolve(workspace, entry.path);
      const text = await fsp.readFile(resolved.absPath, "utf8");
      if (/function\s+(\w+)/.test(text) && text.split("\n").length > 120) {
        findings.push({
          title: "Large new/edited function without obvious tests",
          file: entry.path,
          detail: "File exceeds 120 lines in current snapshot.",
          recommendation: "Split helper or add focused tests if behavior is new.",
          risk: "low"
        });
      }
      if (/execSync|spawn\(|child_process/.test(text) && /fs\.readFile|readFileSync/.test(text)) {
        findings.push({
          title: "Shell/file complexity may be reducible",
          file: entry.path,
          detail: "Mixes child_process with direct fs reads.",
          recommendation: "Prefer existing Least tools (read_many, search_context) over custom shell parsing.",
          risk: "low"
        });
      }
    } catch {
      // ignore unreadable paths
    }
  }

  const text = findings.length
    ? [
        `Heuristic minimality review: ${findings.length} findings`,
        "Findings are prompts for human/agent review, not mandatory removals.",
        "",
        ...findings.map((f, idx) => `${idx + 1}. ${f.title}\n   File: ${f.file}\n   ${f.detail}\n   Recommendation: ${f.recommendation}\n   Risk: ${f.risk}`)
      ].join("\n\n")
    : "Heuristic minimality review: no findings in current change set.";
  return { text, findings: findings.slice(0, maxFindings) };
}