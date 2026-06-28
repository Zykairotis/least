import type { LeastConfig } from "./config.js";
import type { PermissionSettings } from "./settingsSchema.js";
import { parsePermissionRule, parsePermissionRules, evaluateRules, ruleApplies, type PermissionDecision, type PermissionRule, type RuleKind } from "./permissionRules.js";
import type { LoadedSettings } from "./settings.js";

// ── Effective permission context ─────────────────────────────────

export interface PermissionContext {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
  defaultBashMode: string;
}

/**
 * Build a PermissionContext from effective settings + config fallback.
 */
export function buildPermissionContext(
  settings: LoadedSettings | null,
  config: LeastConfig
): PermissionContext {
  const ps: PermissionSettings | undefined = settings?.effective?.permissions;
  return {
    allow: parsePermissionRules(ps?.allow),
    ask: parsePermissionRules(ps?.ask),
    deny: parsePermissionRules(ps?.deny),
    defaultBashMode: ps?.defaultMode ?? config.bashMode
  };
}

/**
 * Evaluate whether a bash/shell command is permitted.
 */
export function evaluateBashPermission(
  ctx: PermissionContext,
  toolName: string,
  command: string
): PermissionDecision {
  return evaluateRules({
    ...ctx,
    toolName,
    toolInput: { command }
  });
}

/**
 * Evaluate whether a read operation on a path is permitted.
 */
export function evaluateReadPermission(
  ctx: PermissionContext,
  toolName: string,
  path: string
): PermissionDecision {
  return evaluateRules({
    ...ctx,
    toolName,
    toolInput: { path }
  });
}

/**
 * Evaluate whether a write/edit operation on a path is permitted.
 */
export function evaluateWritePermission(
  ctx: PermissionContext,
  toolName: string,
  path: string
): PermissionDecision {
  return evaluateRules({
    ...ctx,
    toolName,
    toolInput: { path }
  });
}

/**
 * Evaluate whether a generic tool operation is permitted.
 * Accepts arbitrary tool input for rules that inspect input beyond path/command.
 */
export function evaluateToolPermission(
  ctx: PermissionContext,
  toolName: string,
  toolInput: Record<string, unknown>
): PermissionDecision {
  return evaluateRules({
    ...ctx,
    toolName,
    toolInput
  });
}

/**
 * Check whether yolo mode is active (permission bypass for trusted local dev).
 */
export function isYoloAllowed(config: LeastConfig): boolean {
  return config.yoloMode;
}

/**
 * Format a permission_required response for ask decisions.
 */
export function formatPermissionRequired(toolName: string, reason: string): string {
  return `# Permission Required

**Tool**: ${toolName}
**Reason**: ${reason}

To allow this operation, add a more specific allow rule to \`.least/settings.local.json\` or \`.least/settings.json\`. Example:

\`\`\`json
{
  "permissions": {
    "allow": ["${toolName.charAt(0).toUpperCase() + toolName.slice(1)}(<specific pattern>)"]
  }
}
\`\`\`
`;
}

/**
 * Re-export permission rule primitives used by callers who need to
 * evaluate rules directly, check rule applicability, or reference
 * the PermissionDecision type.
 */
export { evaluateRules, ruleApplies, type PermissionDecision } from "./permissionRules.js";

