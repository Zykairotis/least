import { minimatch } from "minimatch";

// ── Rule kinds ──────────────────────────────────────────────────

export type RuleKind = "Tool" | "Bash" | "Read" | "Write" | "Edit";

export interface PermissionRule {
  kind: RuleKind;
  pattern: string;
  raw: string;
}

export type PermissionDecision =
  | { decision: "allow"; reason?: string; matchedRule?: string }
  | { decision: "ask"; reason: string; matchedRule?: string }
  | { decision: "deny"; reason: string; matchedRule?: string };

// ── Parse ───────────────────────────────────────────────────────

const RULE_RE = /^(Tool|Bash|Read|Write|Edit)\((.+)\)$/;

export function parsePermissionRule(rule: string): PermissionRule {
  const m = RULE_RE.exec(rule.trim());
  if (!m) {
    throw new Error(
      `Invalid permission rule: "${rule}". Expected Tool(...), Bash(...), Read(...), Write(...), or Edit(...).`
    );
  }
  return { kind: m[1] as RuleKind, pattern: m[2], raw: rule.trim() };
}

export function parsePermissionRules(rules: string[] | undefined): PermissionRule[] {
  if (!rules || rules.length === 0) return [];
  return rules.map(parsePermissionRule);
}

// ── Matching ────────────────────────────────────────────────────

function globMatch(pattern: string, value: string): boolean {
  return (
    minimatch(value, pattern, { dot: true, matchBase: false }) ||
    minimatch(value.replace(/\\/g, "/"), pattern, { dot: true, matchBase: false })
  );
}

/** Match a Bash command against a permission rule pattern. */
function matchBash(command: string, pattern: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized === pattern) return true;
  // Pattern ending with " *" matches prefix (e.g. "npm run build *" matches "npm run build --prod")
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2);
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length).trim();
      return rest.length > 0;
    }
  }
  return globMatch(pattern, normalized);
}

// Static tool-kind lookup tables
const READ_TOOLS: Record<string, boolean> = {
  read: true, read_many: true, read_around: true, files: true,
  search: true, search_context: true, json_query: true,
  context_pack: true, project_map: true, show_changes: true
};
const WRITE_TOOLS: Record<string, boolean> = {
  write: true, multi_edit: true, apply_patch: true,
  handoff_to_agent: true, export_pro_context: true
};
const EDIT_TOOLS: Record<string, boolean> = {
  edit: true, multi_edit: true, apply_patch: true
};

/** Check whether a permission rule applies to a given tool call. */
export function ruleApplies(
  rule: PermissionRule,
  toolName: string,
  toolInput: Record<string, unknown>
): boolean {
  switch (rule.kind) {
    case "Tool":
      return toolName === rule.pattern || globMatch(rule.pattern, toolName);
    case "Bash":
      if (toolName !== "bash" && toolName !== "shell") return false;
      if (typeof toolInput.command !== "string") return false;
      return matchBash(toolInput.command, rule.pattern);
    case "Read":
      if (!READ_TOOLS[toolName]) return false;
      return pathMatchFromArgs(toolInput, rule.pattern);
    case "Write":
      if (!WRITE_TOOLS[toolName]) return false;
      return pathMatchFromArgs(toolInput, rule.pattern);
    case "Edit":
      if (!EDIT_TOOLS[toolName]) return false;
      return pathMatchFromArgs(toolInput, rule.pattern);
    default:
      return false;
  }
}

/** Extract path-like args from tool input and check against a glob pattern. */
function pathMatchFromArgs(
  args: Record<string, unknown>,
  pattern: string
): boolean {
  for (const key of ["path", "paths", "target", "target_path"]) {
    const val = args[key];
    if (typeof val === "string") {
      const normalized = val.replace(/\\/g, "/");
      if (globMatch(pattern, normalized)) return true;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") {
          const normalized = item.replace(/\\/g, "/");
          if (globMatch(pattern, normalized)) return true;
        }
      }
    }
  }
  return false;
}

// ── Evaluation ──────────────────────────────────────────────────

export interface EvaluateOptions {
  allow?: PermissionRule[];
  ask?: PermissionRule[];
  deny?: PermissionRule[];
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Evaluate permission rules for a tool call.
 * Order: deny > ask > allow. First matching rule wins.
 */
export function evaluateRules(options: EvaluateOptions): PermissionDecision {
  const { allow = [], ask = [], deny = [], toolName, toolInput } = options;

  for (const rule of deny) {
    if (ruleApplies(rule, toolName, toolInput)) {
      return { decision: "deny", reason: `Blocked by deny rule: ${rule.raw}`, matchedRule: rule.raw };
    }
  }

  for (const rule of ask) {
    if (ruleApplies(rule, toolName, toolInput)) {
      return { decision: "ask", reason: `Matched ask rule: ${rule.raw}`, matchedRule: rule.raw };
    }
  }

  for (const rule of allow) {
    if (ruleApplies(rule, toolName, toolInput)) {
      return { decision: "allow", reason: `Matched allow rule: ${rule.raw}`, matchedRule: rule.raw };
    }
  }

  return { decision: "allow", reason: "No matching rule — using fallback" };
}
