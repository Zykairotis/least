import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { HookSettings, HookSpec } from "./settingsSchema.js";
import type { LoadedSettings } from "./settings.js";
import { redactSensitiveText } from "./redact.js";
import { emitDashboardEvent } from "./dashboardEvents.js";
import { recordHookEvent } from "./dashboardSnapshot.js";

// ── Types ───────────────────────────────────────────────────────

export type HookEvent =
  | "ConfigLoad" | "ConfigChange" | "WorkspaceOpen"
  | "PreToolUse" | "PostToolUse" | "ToolError"
  | "PreBash" | "PostBash"
  | "PreRead" | "PostRead"
  | "PreWrite" | "PostWrite"
  | "PreEdit" | "PostEdit"
  | "LockAcquired" | "LockReleased";

export interface HookPayload {
  event: HookEvent;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  workspace?: { id: string; root: string };
  timestamp: string;
  context?: string;
}

export interface HookResult {
  decision: "allow" | "deny" | "error";
  reason?: string;
  context?: string;
}

export interface HookExecutionResult {
  hookId: string;
  result: HookResult;
  timedOut: boolean;
  error?: string;
}

// ── Trust evaluation ────────────────────────────────────────────

export function isHookCommandTrusted(
  spec: HookSpec,
  settings: LoadedSettings | null,
  workspaceRoot: string
): { trusted: boolean; reason?: string } {
  const hookSettings = settings?.effective?.hooks;

  if (hookSettings?.enabled === false) {
    return { trusted: false, reason: "Hooks are disabled in settings." };
  }

  const resolved = path.isAbsolute(spec.command)
    ? spec.command
    : path.resolve(workspaceRoot, spec.command);

  const isProjectHook = !spec.command.startsWith("~") && !path.isAbsolute(spec.command);

  if (isProjectHook) {
    if (hookSettings?.allowProjectHooks !== true) {
      return { trusted: false, reason: "Project hooks require allowProjectHooks=true in .least/settings.local.json or user settings." };
    }
    const trustedList = hookSettings?.trustedHookCommands ?? [];
    if (trustedList.length > 0) {
      const matched = trustedList.some((cmd) => {
        const normalized = cmd.replace(/\\/g, "/");
        return (
          resolved.endsWith(normalized) ||
          resolved.endsWith(path.resolve(workspaceRoot, cmd))
        );
      });
      if (!matched) {
        return { trusted: false, reason: `Hook command ${spec.command} is not in trustedHookCommands list.` };
      }
    }
  }

  // Block dangerous paths
  const normalizedCommand = resolved.replace(/\\/g, "/");
  if (
    normalizedCommand.includes("/.git/") ||
    normalizedCommand.includes("/node_modules/") ||
    normalizedCommand.includes("/.env") ||
    normalizedCommand.startsWith("/etc") ||
    normalizedCommand.startsWith("/dev")
  ) {
    return { trusted: false, reason: `Hook command resolves to a blocked path: ${spec.command}` };
  }

  if (isProjectHook && !resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    return { trusted: false, reason: `Hook command ${spec.command} resolves outside the workspace.` };
  }

  return { trusted: true };
}

// ── Hook matching ───────────────────────────────────────────────

function specMatchesEvent(spec: HookSpec, event: HookEvent, toolName?: string): boolean {
  if (!spec.matcher) return true;
  if (event === "PreToolUse" || event === "PostToolUse" || event === "ToolError") {
    if (!toolName) return false;
    return spec.matcher.toLowerCase() === toolName.toLowerCase();
  }
  const toolPart = event.replace(/^(Pre|Post)/, "").toLowerCase();
  return spec.matcher.toLowerCase() === toolPart;
}

export function getHooksForEvent(
  event: HookEvent,
  settings: LoadedSettings | null,
  workspaceRoot: string,
  toolName?: string
): HookSpec[] {
  if (!settings?.effective?.hooks?.enabled) return [];
  const hookSettings = settings.effective.hooks;
  const field = event as keyof HookSettings;
  const rawSpecs = (hookSettings as Record<string, unknown>)[field];
  if (!Array.isArray(rawSpecs)) return [];
  const specs = rawSpecs as HookSpec[];
  return specs.filter((s) => specMatchesEvent(s, event, toolName));
}

// ── Hook execution ──────────────────────────────────────────────

export async function executeHook(
  spec: HookSpec,
  payload: HookPayload,
  workspaceRoot: string,
  timeoutMs: number
): Promise<HookExecutionResult> {
  const hookId = `${spec.command}@${Date.now()}`;
  const resolved = path.isAbsolute(spec.command)
    ? spec.command
    : path.resolve(workspaceRoot, spec.command);

  const input = redactSensitiveText(JSON.stringify(payload));

  return new Promise((resolve) => {
    const startDir = spec.runIn === "settings"
      ? path.join(os.homedir(), ".least")
      : workspaceRoot;

    const child = spawn(process.execPath, [resolved], {
      cwd: startDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LEAST_HOOK_EVENT: payload.event,
        LEAST_HOOK_TOOL: payload.toolName ?? ""
      },
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdin.write(input);
    child.stdin.end();

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        resolve({ hookId, result: { decision: "deny", reason: "Hook timed out." }, timedOut: true });
        return;
      }
      let parsed: HookResult;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        if (code === 0) {
          parsed = { decision: "allow", context: stdout.trim() || undefined };
        } else {
          const errMsg = stderr.trim() || `Hook exited with code ${code}`;
          parsed = { decision: "deny", reason: redactSensitiveText(errMsg) };
        }
      }
      resolve({ hookId, result: parsed, timedOut: false, error: stderr ? redactSensitiveText(stderr) : undefined });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ hookId, result: { decision: "error", reason: `Hook process error: ${err.message}` }, timedOut: false, error: err.message });
    });
  });
}

// ── Run hook pipeline ───────────────────────────────────────────

export interface RunHooksOptions {
  event: HookEvent;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  workspace?: { id: string; root: string };
  context?: string;
  yoloMode?: boolean;
  failClosed?: boolean;
}

export async function runHooks(
  settings: LoadedSettings | null,
  workspaceRoot: string,
  options: RunHooksOptions
): Promise<HookResult[]> {
  const { event, toolName, toolInput, workspace, context, failClosed = true, yoloMode = false } = options;

  emitDashboardEvent({ kind: "hook:start", toolName, payload: { event } });

  const specs = getHooksForEvent(event, settings, workspaceRoot, toolName);
  if (specs.length === 0) {
    emitDashboardEvent({ kind: "hook:end", toolName, payload: { event, reason: "no specs" } });
    return [];
  }

  const payload: HookPayload = {
    event,
    toolName,
    toolInput: toolInput ? redactPayload(toolInput) : undefined,
    workspace: workspace ? { id: workspace.id, root: workspace.root } : undefined,
    timestamp: new Date().toISOString(),
    context
  };

  const results: HookResult[] = [];

  for (const spec of specs) {
    const trust = isHookCommandTrusted(spec, settings, workspaceRoot);
    if (!trust.trusted) {
      if (failClosed && !yoloMode) {
        emitDashboardEvent({ kind: "hook:end", toolName, payload: { event, decisions: ["deny"] } });
        return [{ decision: "deny", reason: trust.reason ?? "Hook not trusted." }];
      }
      continue;
    }

    const timeoutMs = spec.timeoutMs ?? 3_000;
    const hookStartTime = Date.now();
    const execResult = await executeHook(spec, payload, workspaceRoot, timeoutMs);
    const execDurationMs = Date.now() - hookStartTime;

    recordHookEvent({ id: 0, ts: new Date().toISOString(), event, toolName, decision: execResult.result.decision, durationMs: execDurationMs });

    if (execResult.result.decision === "deny" || execResult.result.decision === "error") {
      if (failClosed && !yoloMode) {
        emitDashboardEvent({ kind: "hook:end", toolName, payload: { event, decisions: ["deny"] } });
        return [execResult.result];
      }
      // In yolo mode, hook denials become non-blocking warnings — skip original result
      results.push({
        decision: "allow",
        context: `[yolo bypass] ${execResult.result.reason ?? "Hook returned " + execResult.result.decision}`
      });
      continue;
    }
    results.push(execResult.result);
  }

  emitDashboardEvent({ kind: "hook:end", toolName, durationMs: 0, payload: { event, decisions: results.map(r => r.decision) } });
  return results;
}

// ── Payload redaction ───────────────────────────────────────────

function redactPayload(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") safe[key] = redactSensitiveText(value);
    else if (Array.isArray(value)) safe[key] = value.map((v) => (typeof v === "string" ? redactSensitiveText(v) : v));
    else if (typeof value === "object" && value !== null) safe[key] = redactPayload(value as Record<string, unknown>);
    else safe[key] = value;
  }
  return safe;
}
