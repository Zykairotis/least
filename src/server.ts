import fsp from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LeastConfig } from "./config.js";
import { WorkspaceManager, PathGuard, LeastError, type Workspace } from "./guard.js";
import { contextPack } from "./contextPackOps.js";
import { repoTree, readTextFile, readManyTextFiles, writeTextFile, editTextFile, ensureAiBridge, fileContentSha256 } from "./fsOps.js";
import { searchWorkspace, searchWorkspaceContext } from "./searchOps.js";
import { listWorkspaceFiles } from "./filesOps.js";
import { warmCommandCapabilities } from "./commandCaps.js";
import { queryJsonFiles } from "./jsonQueryOps.js";
import { applyWorkspacePatch } from "./patchOps.js";
import { runBash, bashRequiresMutationLock } from "./bashOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { buildProjectMap, invalidateProjectMap } from "./projectMapOps.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { exportProContext } from "./proContext.js";
import {
  REVIEW_GIT_STATUS_OPTIONS,
  diffMaxCharsFromTokens,
  diffSummary,
  expandUntrackedDirectoryEntries,
  parseGitStatusEntries,
  readChangedFiles,
  summarizeUntrackedFiles
} from "./reviewOps.js";
import { leastInventory, loadSkill } from "./capabilitiesOps.js";
import { formatLeastDiscoverText, formatLeastGainText, leastDiscover, leastGain } from "./gainOps.js";
import { reviewMinimality } from "./minimalityOps.js";
import { saveProjectMemory, searchProjectMemory, updateProjectMemory } from "./projectMemory.js";
import { shapeTextOutput, shellKindFromCommand, type OutputKind } from "./outputShaper.js";
import { retrieveStoredOutput } from "./toolOutputStore.js";
import { getLeastPerfSnapshot, measuredToolCall, recordRetrieval, resetLeastPerf } from "./perf.js";
import { TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, TOOL_CARD_URI_ALIASES, toolCardWidgetHtml } from "./toolCardWidget.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import { ToolTimeoutError, withTimeout } from "./timeout.js";
import {
  ToolRegistry,
  inputSchemaToJsonSchema,
  mcpToolResultToText,
  type McpToolResultShape
} from "./toolRegistry.js";
import { buildPermissionContext, evaluateBashPermission, evaluateReadPermission, evaluateWritePermission, evaluateRules, formatPermissionRequired, type PermissionContext } from "./permissions.js";
import { emitDashboardEvent } from "./dashboardEvents.js";
import { runHooks } from "./hooks.js";
import {
  agentAttachHint,
  agentCancel,
  agentDoctor,
  agentInputFromArgs,
  agentList,
  agentPlan,
  agentResult,
  agentSessions,
  agentStart,
  agentStatus,
  agentTail,
  agentTerminalDoctor,
  agentWatchdog,
  normalizeAgentIdleTimeoutMs,
  normalizeAgentTimeoutMs,
  validateStartInput
} from "./agentOps.js";
import { agentCleanup, agentResume } from "./agentLifecycle.js";

import { getWorkspaceCacheStats, invalidateWorkspaceCaches } from "./workspaceCache.js";
import { getSharedWorkspaceManager } from "./workspaceManager.js";
import {
  getSharedWorkspaceLockManager,
  lockSecondsRemaining,
  StaleFileStateError,
  WorkspaceLockedError,
  type WorkspaceLock
} from "./workspaceLocks.js";

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

async function shapeForTool(
  config: LeastConfig,
  workspace: Workspace,
  toolName: string,
  kind: OutputKind,
  text: string,
  options: {
    command?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    truncated?: boolean;
    maxVisibleBytes?: number;
    outputMode?: "raw" | "compact" | "compressed";
  } = {}
): Promise<{ text: string; outputMeta: Record<string, unknown> & { compacted?: boolean; retrievalHint?: string; summary?: string }; rawBytes: number; visibleBytes: number; savedBytes: number }> {
  const rawBytes = Buffer.byteLength(text, "utf8");
  const shaped = await shapeTextOutput(
    config,
    {
      kind,
      text,
      rawBytes,
      toolName,
      command: options.command,
      exitCode: options.exitCode,
      timedOut: options.timedOut,
      truncated: options.truncated
    },
    {
      mode: options.outputMode ?? config.outputMode,
      maxVisibleBytes: options.maxVisibleBytes ?? config.maxOutputBytes,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root
    }
  );
  return {
    text: shaped.content,
    outputMeta: { ...shaped.meta },
    rawBytes: shaped.meta.rawBytes,
    visibleBytes: shaped.meta.visibleBytes,
    savedBytes: shaped.meta.savedBytes
  };
}

function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

function errorResult(error: unknown): any {
  if (error instanceof ToolTimeoutError) {
    return {
      isError: true,
      content: [{ type: "text", text: `Tool timeout: ${error.message}` }],
      structuredContent: { error: error.message, timed_out: true, timeout_ms: error.timeoutMs, tool: error.toolName }
    };
  }
  if (error instanceof WorkspaceLockedError) {
    const structured = error.toStructured();
    return {
      isError: true,
      content: [{ type: "text", text: errorText(error) }],
      structuredContent: structured
    };
  }
  if (error instanceof StaleFileStateError) {
    const structured = error.toStructured();
    return {
      isError: true,
      content: [{ type: "text", text: errorText(error) }],
      structuredContent: structured
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorText(error) }
  };
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  result.structuredContent = {
    least_tool: name,
    least_title: options.title ?? name,
    ...base,
    ...(_yoloMode ? { yolo_mode: true } : {}),
  };
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.LEAST_LOG_TOOL_CALLS === "1" || process.env.LEAST_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number, structured?: Record<string, unknown>): void {
  if (!toolCallLoggingEnabled()) return;
  const parts = [`[LeastTool] ${name} ${status} ${Date.now() - started}ms`];
  const backend = structured?.used ?? structured?.backend;
  if (backend) parts.push(`backend=${String(backend)}`);
  if (structured?.truncated) parts.push("truncated=true");
  if (typeof structured?.count === "number") parts.push(`count=${structured.count}`);
  if (typeof structured?.matches === "object" && Array.isArray(structured.matches)) {
    parts.push(`matches=${structured.matches.length}`);
  }
  console.error(parts.join(" "));
}

export type McpSurface = "chatgpt" | "grok";
export type McpAuthMode = "noauth" | "oauth2";

export interface SessionContext {
  sessionId: string;
  lockOwnerId?: string;
  surface?: McpSurface;
}

export interface SessionContextRef {
  get(): SessionContext;
}

export interface CreateLeastServerOptions {
  surface?: McpSurface;
  authMode?: McpAuthMode;
  sessionContext?: SessionContextRef;
}

function toolSecuritySchemes(authMode: McpAuthMode): Record<string, unknown>[] {
  return authMode === "oauth2"
    ? [{ type: "oauth2", scopes: ["mcp"] }]
    : [{ type: "noauth" }];
}

function toolCardResourceContents(uri: string, config: LeastConfig): Record<string, unknown> {
  return {
    uri,
    mimeType: TOOL_CARD_MIME_TYPE,
    text: toolCardWidgetHtml,
    _meta: {
      ui: {
        prefersBorder: true,
        domain: config.widgetDomain,
        csp: {
          connectDomains: [],
          resourceDomains: []
        }
      },
      "openai/widgetDescription":
        "Renders Least workspace orientation, file diffs, change reviews, Pro context exports, and handoff plans as compact developer cards. Bash stays data-only.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetDomain": config.widgetDomain,
      "openai/widgetCSP": {
        connect_domains: [],
        resource_domains: []
      }
    }
  };
}

function registerToolCardResource(server: McpServer, config: LeastConfig): void {
  const s = server as any;
  if (typeof s.registerResource !== "function") return;
  const uris = [TOOL_CARD_URI, ...TOOL_CARD_URI_ALIASES];
  for (const uri of uris) {
    const resourceName = uri === TOOL_CARD_URI ? "least-tool-card" : `least-tool-card-${uri.split("/").pop()?.replace(".html", "") ?? "alias"}`;
    s.registerResource(
      resourceName,
      uri,
      {
        title: "Least Tool Card",
        description: "Compact visual renderer for Least workspace orientation, source changes, and handoffs.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [toolCardResourceContents(uri, config)]
      })
    );
  }
}


function isContextPath(config: LeastConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertWriteToolAllowed(config: LeastConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new LeastError(
      `Source writes are disabled because LEAST_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit only inside ${config.contextDir}/.`
    );
  }
  throw new LeastError("write/edit tools are disabled because LEAST_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

function registerToolCompat(
  authMode: McpAuthMode,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) =>
    measuredToolCall(name, workspaceIdFromArgs((args ?? {}) as Record<string, unknown>), async () => {
      const started = Date.now();
      try {
        const result = tagToolResult(await handler(args ?? {}), name, options);
        const structured =
          result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
            ? (result.structuredContent as Record<string, unknown>)
            : undefined;
        logToolCall(name, result?.isError ? "error" : "ok", started, structured);
        return result;
      } catch (error) {
        const result = tagToolResult(errorResult(error), name, options);
        logToolCall(name, "error", started);
        return result;
      }
    });

  const securitySchemes = toolSecuritySchemes(authMode);
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...options,
    _meta: {
      securitySchemes,
      ...(options._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const LOCK_TOOLS = new Set([
  "workspace_lock_status",
  "acquire_workspace_lock",
  "renew_workspace_lock",
  "release_workspace_lock"
]);

const MINIMAL_TOOLS = new Set([
  "server_config",
  "least_perf",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "bash",
  "shell",
  "show_changes",
  "retrieve_output",
  "least_gain",
  "least_discover",
  "agent_list",
  "agent_doctor",
  "agent_plan",
  "agent_status",
  "agent_terminal_doctor",
  "agent_sessions",
  "agent_attach_hint"
]);

const STANDARD_TOOLS = new Set([
  ...MINIMAL_TOOLS,
  "files",
  "tree",
  "search",
  "search_context",
  "read_many",
  "read_around",
  "json_query",
  "diff_summary",
  "read_changed_files",
  "context_pack",
  "project_map",
  "warmup",
  "batch",
  "multi_edit",
  "apply_patch",
  "load_skill",
  "read_handoff",
  "export_pro_context",
  "handoff_to_agent",
  "retrieve_output",
  "least_gain",
  "least_discover",
  "agent_list",
  "agent_doctor",
  "agent_plan",
  "agent_start",
  "agent_status",
  "agent_watchdog",
  "agent_tail",
  "agent_result",
  "agent_cancel",
  "agent_resume",
  "agent_cleanup",
  "agent_terminal_doctor",
  "agent_sessions",
  "agent_attach_hint",
  "review_minimality",
  "project_memory_search",
  "project_memory_save",
  "project_memory_update"
]);

const TOOLSET_TOOLS: Record<LeastConfig["toolset"], Set<string>> = {
  full: new Set<string>(),
  standard: new Set<string>(),
  explore: new Set(["server_config", "least_perf", "least_gain", "least_discover", "open_current_workspace", "open_workspace", "files", "search_context", "read_many", "read_around", "json_query", "context_pack", "project_map", "retrieve_output", "batch"]),
  edit: new Set(["server_config", "least_perf", "least_gain", "open_current_workspace", "open_workspace", "context_pack", "read_many", "read_around", "multi_edit", "apply_patch", "show_changes", "retrieve_output", "project_memory_search", "project_memory_save", "project_memory_update", "bash", "shell"]),
  review: new Set(["server_config", "least_perf", "least_gain", "least_discover", "open_current_workspace", "open_workspace", "diff_summary", "read_changed_files", "search_context", "show_changes", "review_minimality", "read_many", "read_around", "retrieve_output", "batch"]),
  handoff: new Set(["server_config", "least_perf", "open_current_workspace", "open_workspace", "export_pro_context", "handoff_to_agent", "handoff_to_codex", "read_handoff", "batch"])
};

const PROJECT_MEMORY_TOOLS = new Set(["project_memory_search", "project_memory_save", "project_memory_update"]);

function shouldRegisterTool(config: LeastConfig, name: string): boolean {
  if (config.yoloMode) return true;
  if (PROJECT_MEMORY_TOOLS.has(name) && !config.projectMemory) return false;
  if (LOCK_TOOLS.has(name)) {
    return config.concurrencyMode === "lease";
  }
  const toolModeAllowed = config.toolMode === "full" ? true : config.toolMode === "minimal" ? MINIMAL_TOOLS.has(name) : STANDARD_TOOLS.has(name);
  if (!toolModeAllowed) return false;
  if (config.toolset === "full" || config.toolset === "standard") return true;
  return TOOLSET_TOOLS[config.toolset].has(name);
}
// Module-level permission context set by createLeastServer
let _permCtx: PermissionContext | undefined;
let _defaultRoot: string = "";
let _yoloMode = false;
let _nextDashboardCallId = 1;

function nextDashboardCallId(toolName: string): string {
  return String(Date.now()) + "-" + String(_nextDashboardCallId++) + "-" + toolName;
}

function structuredResult(result: McpToolResultShape | undefined): Record<string, unknown> | undefined {
  return result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? (result.structuredContent as Record<string, unknown>)
    : undefined;
}

function summarizeToolResult(result: McpToolResultShape | undefined): Record<string, unknown> {
  const content = Array.isArray(result?.content) ? result.content : [];
  const textBytes = content.reduce((sum, item) => {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
      return sum + Buffer.byteLength(item.text, "utf8");
    }
    return sum;
  }, 0);
  const structured = structuredResult(result);
  return {
    isError: Boolean(result?.isError),
    contentItems: content.length,
    textBytes,
    structuredKeys: structured ? Object.keys(structured).slice(0, 20) : [],
  };
}

const AGENT_DASHBOARD_TOOLS = new Set([
  "agent_start",
  "agent_status",
  "agent_watchdog",
  "agent_tail",
  "agent_result",
  "agent_cancel",
  "agent_resume",
  "agent_cleanup",
  "agent_sessions",
  "agent_attach_hint",
  "agent_terminal_doctor"
]);

function compactAgentDashboardOutput(toolName: string, result: McpToolResultShape | undefined): Record<string, unknown> | undefined {
  if (!AGENT_DASHBOARD_TOOLS.has(toolName)) return undefined;
  const structured = structuredResult(result);
  if (!structured) return undefined;
  const out: Record<string, unknown> = { tool_name: toolName };
  for (const key of [
    "job_id", "task_id", "created_at", "updated_at", "workspace_id", "workspace_root", "agent", "repository", "title", "state",
    "worktree_dir", "branch_name", "workspace_name", "deadline_at", "idle_deadline_at", "source", "target", "session_name", "pane_id"
  ]) {
    if (structured[key] !== undefined) out[key] = structured[key];
  }
  if (structured.terminal && typeof structured.terminal === "object") out.terminal = structured.terminal;
  if (Array.isArray(structured.sessions)) out.sessions = structured.sessions.slice(0, 500);
  if (Array.isArray(structured.terminal_backends)) out.terminal_backends = structured.terminal_backends;
  if (Array.isArray(structured.attach_commands)) out.attach_commands = structured.attach_commands;
  if (Array.isArray(structured.watch_commands)) out.watch_commands = structured.watch_commands;
  if (Array.isArray(structured.tail_commands)) out.tail_commands = structured.tail_commands;
  if (Array.isArray(structured.fallback_commands)) out.fallback_commands = structured.fallback_commands;
  if (structured.git && typeof structured.git === "object" && !Array.isArray(structured.git)) {
    const git = structured.git as Record<string, unknown>;
    out.git = {
      available: git.available,
      changed_files: git.changed_files,
      diff_stat: git.diff_stat
    };
  }
  if (structured.tail && typeof structured.tail === "object" && !Array.isArray(structured.tail)) {
    const tail = structured.tail as Record<string, unknown>;
    out.tail = {
      source: tail.source,
      lines: tail.lines,
      truncated: tail.truncated,
      target: tail.target,
      session_name: tail.session_name,
      pane_id: tail.pane_id
    };
  }
  return out;
}

function registerCodexTool(
  config: LeastConfig,
  authMode: McpAuthMode,
  registry: ToolRegistry,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<McpToolResultShape> | McpToolResultShape
): void {
  if (!shouldRegisterTool(config, name)) return;

  // Generic permission + hook wrapper applied to every tool
  const wrappedHandler = async (args: Record<string, unknown>): Promise<McpToolResultShape> => {
    const safeArgs = args ?? {};
    const ctx = _permCtx;

    const dashboardWorkspaceId = workspaceIdFromArgs(safeArgs);
    const dashboardSessionId = dashboardWorkspaceId ?? "default";
    const dashboardToolCallId = nextDashboardCallId(name);
    const dashboardStarted = Date.now();
    emitDashboardEvent({ kind: "tool:start", toolName: name, workspaceId: dashboardWorkspaceId, sessionId: dashboardSessionId, payload: { toolCallId: dashboardToolCallId, input: safeArgs } });

    // 1. Generic permission check (yoloMode bypasses)
    if (!_yoloMode && ctx && (ctx.deny.length > 0 || ctx.ask.length > 0 || ctx.allow.length > 0)) {
      const decision = evaluateRules({
        ...ctx,
        toolName: name,
        toolInput: safeArgs
      });
      if (decision.decision === "deny") {
        return errorResult(new LeastError(decision.reason ?? `Tool ${name} denied by permission rules.`));
      }
      if (decision.decision === "ask") {
        return textResult(formatPermissionRequired(name, decision.reason));
      }
    }

    // 2. PreToolUse hooks
    if (config.settings && _defaultRoot) {
      const preResults = await runHooks(config.settings, _defaultRoot, {
        event: "PreToolUse",
        toolName: name,
        toolInput: safeArgs,
        workspace: { id: "unknown", root: _defaultRoot },
        failClosed: true,
        yoloMode: _yoloMode,
      });
      const denial = preResults.find((h) => h.decision !== "allow");
      if (denial) {
        return errorResult(new LeastError(denial.reason ?? `PreToolUse hook denied ${name}.`));
      }
    }

    // 3. Run the real handler
    const raw = await handler(safeArgs);

    // 4. PostToolUse hooks (fire-and-forget)
    if (config.settings && _defaultRoot) {
      void runHooks(config.settings, _defaultRoot, {
        event: "PostToolUse",
        toolName: name,
        toolInput: safeArgs,
        context: raw?.isError ? "Error" : undefined,
        workspace: { id: "unknown", root: _defaultRoot },
        failClosed: false,
        yoloMode: _yoloMode,
      }).catch(() => {});
    }

    const dashboardOutput = compactAgentDashboardOutput(name, raw);
    emitDashboardEvent({
      kind: "tool:end",
      toolName: name,
      workspaceId: dashboardWorkspaceId,
      sessionId: dashboardSessionId,
      durationMs: Date.now() - dashboardStarted,
      payload: { toolCallId: dashboardToolCallId, outputSummary: summarizeToolResult(raw), ...(dashboardOutput ? { output: dashboardOutput } : {}) },
    });
    return raw;
  };

  registerToolCompat(authMode, server, name, options, async (args: Record<string, unknown>) => {
    return wrappedHandler(args ?? {});
  });
  const inputSchema =
    options.inputSchema && typeof options.inputSchema === "object"
      ? (options.inputSchema as Record<string, unknown>)
      : {};
  let jsonSchema: Record<string, unknown>;
  try {
    jsonSchema = inputSchemaToJsonSchema(inputSchema);
  } catch (error) {
    console.error(
      `[Least] OpenAI schema conversion failed for tool ${name}:`,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }
  const description =
    typeof options.description === "string" ? options.description : name;
  registry.register({
    name,
    description,
    inputSchema: jsonSchema,
    handler: async (args: Record<string, unknown>) => {
      return measuredToolCall(name, workspaceIdFromArgs(args), async () => {
        const started = Date.now();
        try {
          const raw = await wrappedHandler(args);
          const tagged = tagToolResult(raw, name, options);
          const structured =
            tagged?.structuredContent && typeof tagged.structuredContent === "object" && !Array.isArray(tagged.structuredContent)
              ? (tagged.structuredContent as Record<string, unknown>)
              : undefined;
          logToolCall(name, tagged?.isError ? "error" : "ok", started, structured);
          const result = {
            content: mcpToolResultToText(tagged as McpToolResultShape),
            isError: Boolean(tagged?.isError)
          };
          emitDashboardEvent({ kind: "tool:end", toolName: name, durationMs: Date.now() - started, workspaceId: workspaceIdFromArgs(args) });
          return result;
        } catch (error) {
          const tagged = tagToolResult(errorResult(error), name, options);
          logToolCall(name, "error", started);
          emitDashboardEvent({ kind: "tool:error", toolName: name, durationMs: Date.now() - started, level: "error", payload: { message: error instanceof Error ? error.message : String(error) } });
          return {
            content: mcpToolResultToText(tagged as McpToolResultShape),
            isError: true
          };
        }
      });
    }
  });
}

function serverInstructions(config: LeastConfig): string {
  const lines = [
    "Least connects ChatGPT to one local development workspace.",
    "",
    "Preferred workflow:",
    "1. Start with open_current_workspace. Use open_workspace only when the user gives a different root or asks to switch folders.",
    "2. Follow any AGENTS.md-style instructions returned by the workspace open call before editing files.",
    "3. Explore with files, search_context, and read_many. Use files for candidate paths, search_context for symbol hits with nearby code, and read_many when exact file content is needed.",
    "4. Use search for quick line matches and tree only when directory orientation is useful. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    "5. Edit with write/edit. After edits, call show_changes once for git status, diff stats, and review diff.",
    "6. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.",
    "7. Keep tool calls minimal. Prefer one files or search_context call plus show_changes instead of repeated tree/read/bash loops."
  ];
  if (config.yoloMode) {
    lines.push(
      "",
      "**YOLO MODE**: All permission rules, hooks, and bash gating are disabled. Convenience for trusted local development only. Not for production or untrusted prompts."
    );
  }
  if (config.concurrencyMode === "lease") {
    lines.push(
      "",
      "Concurrent clients: acquire_workspace_lock before any write, edit, or mutating bash call.",
      "Read files first and pass expected_sha256 from the read result into write/edit to avoid stale overwrites.",
      "If another session owns the lock, use workspace_lock_status and wait for release or lease expiry."
    );
  }
  lines.push("", `Current modes: tool=${config.toolMode}, toolset=${config.toolset}, bash=${config.bashMode}, write=${config.writeMode}, concurrency=${config.concurrencyMode}.`);
  return lines.join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

const DEFAULT_TOOL_TIMEOUT_MS: Record<string, number> = {
  read: 5_000,
  read_many: 10_000,
  read_around: 5_000,
  files: 5_000,
  tree: 5_000,
  search: 10_000,
  search_context: 10_000,
  json_query: 5_000,
  diff_summary: 5_000,
  read_changed_files: 10_000,
  context_pack: 15_000,
  project_map: 30_000,
  warmup: 30_000,
  multi_edit: 15_000,
  apply_patch: 15_000,
  show_changes: 10_000,
  export_pro_context: 30_000,
  workspace_snapshot: 10_000,
  batch: 15_000,
  retrieve_output: 10_000,
  least_gain: 5_000,
  least_discover: 5_000,
  agent_list: 10_000,
  agent_doctor: 30_000,
  agent_plan: 5_000,
  agent_start: 120_000,
  agent_status: 10_000,
  agent_watchdog: 30_000,
  agent_tail: 10_000,
  agent_result: 30_000,
  agent_cancel: 30_000,
  agent_resume: 120_000,
  agent_cleanup: 60_000,
  agent_terminal_doctor: 15_000,
  agent_sessions: 10_000,
  agent_attach_hint: 5_000
};

async function runWithToolTimeout<T>(
  name: string,
  args: Record<string, unknown>,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS[name];
  if (!timeoutMs) {
    const controller = new AbortController();
    return fn(controller.signal);
  }
  return withTimeout(name, timeoutMs, fn);
}

function invalidateDerivedWorkspaceState(workspaceId: string): void {
  invalidateWorkspaceCaches(workspaceId);
  invalidateProjectMap(workspaceId);
}

function byteBudgetFromArgs(args: Record<string, unknown>, fallback: number): number {
  if (typeof args.max_tokens_estimate !== "number") return fallback;
  return Math.max(1_000, Math.floor(args.max_tokens_estimate * 4));
}

async function runWarmup(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  indexes: string[]
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const selected = indexes.length ? indexes : ["files", "git", "package"];
  if (selected.includes("files")) {
    const files = await listWorkspaceFiles(config, guard, workspace, { maxResults: 200, trackedOnly: false, includeHidden: false });
    out.files = { count: files.count, backend: files.backend };
  }
  if (selected.includes("git")) {
    out.git = { status: await gitStatus(config, workspace), log: await gitLog(config, workspace, 5) };
  }
  if (selected.includes("package")) {
    out.package = await queryJsonFiles(config, guard, workspace, { path: "package.json", pointer: "/", maxResults: 1 });
  }
  if (selected.includes("symbols")) {
    out.symbols = await buildProjectMap(config, guard, workspace, {});
  }
  return out;
}

function workspaceIdFromArgs(args: Record<string, unknown>): string | undefined {
  return typeof args.workspace_id === "string" ? args.workspace_id : undefined;
}

function strFromArgs(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function sessionIdFrom(options: CreateLeastServerOptions): string {
  const session = options.sessionContext?.get();
  return session?.lockOwnerId ?? session?.sessionId ?? "anonymous";
}

function leaseTokenFromArgs(args: Record<string, unknown>): string | undefined {
  const token = strFromArgs(args, "lease_token")?.trim();
  return token || undefined;
}

function lockManager(config: LeastConfig) {
  return getSharedWorkspaceLockManager(config);
}

function workspaceLockPayload(config: LeastConfig, workspaceId: string): Record<string, unknown> | undefined {
  if (config.concurrencyMode === "off") return undefined;
  return { lock: lockManager(config).status(workspaceId), concurrency_mode: config.concurrencyMode };
}

function assertMutationLock(config: LeastConfig, workspaceId: string, sessionId: string, leaseToken?: string): WorkspaceLock | undefined {
  if (config.concurrencyMode === "off") return undefined;
  return lockManager(config).requireOwner(workspaceId, sessionId, leaseToken);
}

function renewMutationLock(config: LeastConfig, workspaceId: string, sessionId: string, leaseToken?: string): void {
  if (config.concurrencyMode === "off") return;
  lockManager(config).renew(workspaceId, sessionId, leaseToken);
}

async function assertStaleFileState(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  args: Record<string, unknown>
): Promise<void> {
  const expected = strFromArgs(args, "expected_sha256");
  if (!expected) return;
  const expectAbsent = parseBool(args.expect_absent, false);
  const state = await fileContentSha256(config, guard, workspace, relPath);
  if (expectAbsent) {
    if (state.exists) {
      throw new StaleFileStateError(relPath, expected, state.sha256 ?? "");
    }
    return;
  }
  if (!state.exists) {
    throw new StaleFileStateError(relPath, expected, "");
  }
  if (state.sha256 !== expected) {
    throw new StaleFileStateError(relPath, expected, state.sha256 ?? "");
  }
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  return trimmed.startsWith("fatal:") || trimmed.startsWith("error:") || trimmed.startsWith("git unavailable or failed:");
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("##"));
}

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new LeastError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

async function readRawTextFileBounded(config: LeastConfig, guard: PathGuard, workspace: Workspace, filePath: string): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  await ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new LeastError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const BATCH_READ_ONLY_TOOLS = new Set([
  "server_config",
  "least_perf",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "tree",
  "files",
  "search",
  "search_context",
  "read",
  "read_many",
  "read_around",
  "json_query",
  "git_status",
  "git_diff",
  "diff_summary",
  "read_changed_files",
  "context_pack",
  "project_map",
  "warmup",
  "show_changes",
  "read_handoff",
  "codex_context",
  "least_inventory",
  "load_skill",
  "retrieve_output",
  "least_gain",
  "least_discover",
  "review_minimality",
  "project_memory_search"
]);

export function createLeastServer(
  config: LeastConfig,
  options: CreateLeastServerOptions = {}
): { server: McpServer; registry: ToolRegistry } {
  const authMode: McpAuthMode =
    options.authMode ?? (config.dualClient ? (options.surface === "grok" ? "oauth2" : "noauth") : config.grokOAuth ? "oauth2" : "noauth");
  const guard = new PathGuard(config);
  const permCtx = buildPermissionContext(config.settings, config);
  // Set module-level vars for registerCodexTool generic wrappers
  _permCtx = permCtx;
  _defaultRoot = config.defaultRoot;
  _yoloMode = config.yoloMode;

  const workspaces = getSharedWorkspaceManager(config);
  const registry = new ToolRegistry();
  const server = new McpServer({ name: "Least", version: "0.31.0" }, { instructions: serverInstructions(config) });
  registerToolCardResource(server, config);
  warmCommandCapabilities();
  if (config.warmup.length > 0) {
    const workspace = workspaces.defaultWorkspace();
    void runWarmup(config, guard, workspace, config.warmup).catch(() => {
      // Background warmup is best-effort only.
    });
  }

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show Least server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading Least server config...",
        "openai/toolInvocation/invoked": "Least server config ready"
      }
    },
    async () => {
      const registeredTools = registry.list().map((tool) => tool.name);
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        shellBackend: config.shellBackend,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        toolset: config.toolset,
        concurrencyMode: config.concurrencyMode,
        lockLeaseMs: config.lockLeaseMs,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        warmup: config.warmup,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        outputMode: config.outputMode,
        outputStore: config.outputStore,
        outputStoreTtlMs: config.outputStoreTtlMs,
        outputStoreMaxItemBytes: config.outputStoreMaxItemBytes,
        compactSearch: config.compactSearch,
        compactGitDiff: config.compactGitDiff,
        compactShell: config.compactShell,
        yoloMode: config.yoloMode,
        outputCompactionPolicy:
          config.outputMode === "raw"
            ? "raw: no compaction (hard caps still apply)"
            : config.outputMode === "compressed"
              ? "compressed: compact all eligible large outputs"
              : "compact: compact only per-kind enabled outputs above threshold",
        projectMemory: config.projectMemory,
        registeredTools
      };
      return textResult(`# Least Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "least_perf",
    {
      title: "Least Performance",
      description: "Show Least tool timing, timeout, cache, and output-size telemetry for the current session or lifetime window.",
      inputSchema: {
        reset: z.boolean().optional().describe("Reset the selected telemetry window after reading it. Default: false."),
        window: z.enum(["session", "lifetime"]).optional().describe("Telemetry window to inspect. Default: session.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading Least performance telemetry...",
        "openai/toolInvocation/invoked": "Least performance telemetry ready"
      }
    },
    async (args) => {
      const windowName = strFromArgs(args, "window") === "lifetime" ? "lifetime" : "session";
      const snapshot = getLeastPerfSnapshot(windowName);
      const caches = getWorkspaceCacheStats();
      if (parseBool(args.reset, false)) {
        resetLeastPerf(windowName);
      }
      const text = `# Least Performance\n\nWindow: ${windowName}\nReset applied: ${parseBool(args.reset, false)}\n\n\`\`\`json\n${JSON.stringify({ ...snapshot, caches }, null, 2)}\n\`\`\``;
      return textResult(text, { ...snapshot, caches, reset_applied: parseBool(args.reset, false) });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "least_gain",
    {
      title: "Least Gain",
      description: "Show local compaction savings: raw bytes processed, model-visible bytes emitted, and top savers.",
      inputSchema: {
        window: z.enum(["session", "lifetime"]).optional().describe("Telemetry window. Default: session."),
        format: z.enum(["text", "json"]).optional().describe("Output format. Default: text.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading Least gain telemetry...",
        "openai/toolInvocation/invoked": "Least gain telemetry ready"
      }
    },
    async (args) => {
      const windowName = strFromArgs(args, "window") === "lifetime" ? "lifetime" : "session";
      const format = strFromArgs(args, "format") === "json" ? "json" : "text";
      const snapshot = leastGain(windowName, format);
      const text = typeof snapshot === "string" ? snapshot : formatLeastGainText(snapshot);
      return textResult(text, typeof snapshot === "object" ? snapshot : { window: windowName, text });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "least_discover",
    {
      title: "Least Discover",
      description: "Report missed local optimization opportunities from Least telemetry.",
      inputSchema: {
        window: z.enum(["session", "lifetime"]).optional().describe("Telemetry window. Default: session.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Analyzing missed optimization opportunities...",
        "openai/toolInvocation/invoked": "Least discover report ready"
      }
    },
    async (args) => {
      const windowName = strFromArgs(args, "window") === "lifetime" ? "lifetime" : "session";
      const snapshot = leastDiscover(windowName);
      const text = formatLeastDiscoverText(snapshot);
      return textResult(text, snapshot);
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "retrieve_output",
    {
      title: "Retrieve Output",
      description: "Retrieve raw compacted tool output by retrieval key from the local workspace output store.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        key: z.string().describe("Retrieval key such as sha256:... from compacted tool output."),
        start_line: z.number().int().min(1).optional().describe("First line to return. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to return."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum returned bytes.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Retrieving stored output...",
        "openai/toolInvocation/invoked": "Stored output retrieved"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const key = String(strFromArgs(args, "key") ?? "");
      const result = await retrieveStoredOutput(config, workspace.root, workspace.id, key, {
        startLine: args.start_line === undefined ? undefined : limitInt(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER),
        endLine: args.end_line === undefined ? undefined : limitInt(args.end_line, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
        maxBytes: args.max_bytes === undefined ? undefined : limitInt(args.max_bytes, config.maxOutputBytes, 1_000, config.maxOutputBytes)
      });
      recordRetrieval();
      const text = `# Retrieve Output\n\nKey: ${result.key}\nRaw bytes: ${result.rawBytes}\nReturned bytes: ${result.returnedBytes}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nTruncated: ${result.truncated}\n\n\`\`\`text\n${result.content}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  const agentWorkspaceSchema = {
    workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
  };
  const agentStartInputSchema = {
    ...agentWorkspaceSchema,
    agent: z.string().optional().describe("Groundcrew agent profile name. Omit to use agents.default from crew.config.ts."),
    repository: z.string().optional().describe("Groundcrew repository name. Alias: repo."),
    repo: z.string().optional().describe("Alias for repository."),
    title: z.string().optional().describe("Short task title. Default: Local agent task."),
    prompt: z.string().describe("Task prompt to give the local agent."),
    task_id: z.string().optional().describe("Optional explicit Groundcrew task id. Omit to generate one."),
    idempotency_key: z.string().optional().describe("Optional durable idempotency key. agent_start reuses an existing job by task_id first, then by idempotency_key."),
    wait_for_launch: z.boolean().optional().describe("When true, wait briefly for provisioning to reach running/completed/failed-to-launch. Default: false."),
    startup_wait_ms: z.number().int().min(0).max(30000).optional().describe("Maximum app-level wait when wait_for_launch=true. Default: 5000ms."),
    mode: z.enum(["analysis", "implementation", "review", "debug", "build"]).optional().describe("Planning mode. Default: implementation."),
    timeout_ms: z.number().int().min(60000).max(86400000).optional().describe("Agent wall-clock timeout recorded in Least job state. Default: 1 hour."),
    idle_timeout_ms: z.number().int().min(60000).max(10800000).optional().describe("Agent idle timeout recorded in Least job state. Default: 15 minutes."),
    lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Required for agent_start/agent_cancel/agent_resume when concurrency mode is lease.")
  };
  const agentJobInputSchema = {
    ...agentWorkspaceSchema,
    job_id: z.string().optional().describe("Least agent job id."),
    task_id: z.string().optional().describe("Groundcrew task id when job_id is unknown.")
  };
  const agentWatchdogInputSchema = {
    ...agentJobInputSchema,
    enforce_timeouts: z.boolean().optional().describe("When true, interrupt an expired job through Groundcrew. Default: true for agent_watchdog. Default: false for agent_status."),
    lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Required for enforcing watchdog timeouts when concurrency mode is lease.")
  };
  const agentResumeInputSchema = {
    ...agentJobInputSchema,
    fresh: z.boolean().optional().describe("When true, cold-start the agent without Groundcrew resumeArgs. Default: false."),
    lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Required for agent_resume when concurrency mode is lease.")
  };
  const agentCleanupInputSchema = {
    ...agentWorkspaceSchema,
    job_id: z.string().optional().describe("Least agent job id to clean up."),
    task_id: z.string().optional().describe("Groundcrew task id when job_id is unknown."),
    older_than: z.string().optional().describe("Only clean jobs updated before this ISO timestamp or relative duration like 7d, 24h, 30m."),
    dry_run: z.boolean().optional().describe("Preview cleanup without deleting anything. Default: true."),
    clean_worktrees: z.boolean().optional().describe("Also call Groundcrew cleanupWorkspace for matching jobs. Default: false; worktrees are preserved."),
    force: z.boolean().optional().describe("Allow Groundcrew to remove dirty worktrees when clean_worktrees=true. Default: false."),
    lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Required when dry_run=false and concurrency mode is lease.")
  };

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_list",
    {
      title: "Agent List",
      description: "List configured Groundcrew local agent profiles. Requires @clipboard-health/groundcrew and a valid crew.config.ts.",
      inputSchema: agentWorkspaceSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading local agent profiles...",
        "openai/toolInvocation/invoked": "Local agent profiles ready"
      }
    },
    async () => {
      const result = await runWithToolTimeout("agent_list", {}, async () => await agentList());
      return textResult(result.text, result.structured);
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_doctor",
    {
      title: "Agent Doctor",
      description: "Check local agent orchestration setup: Least agent config, Groundcrew import/config, and required local commands.",
      inputSchema: agentWorkspaceSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Checking local agent setup...",
        "openai/toolInvocation/invoked": "Local agent setup checked"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_doctor", args, async () => await agentDoctor(workspace));
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_terminal_doctor",
    {
      title: "Agent Terminal Doctor",
      description: "Check local terminal backends for agent viewing and capture: Zellij, tmux, and Least job logs.",
      inputSchema: agentWorkspaceSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Checking local agent terminal backends...",
        "openai/toolInvocation/invoked": "Local agent terminal backends checked"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_terminal_doctor", args, async () => await agentTerminalDoctor(workspace));
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_sessions",
    {
      title: "Agent Sessions",
      description: "List known local agent terminal sessions and log fallback views across Zellij, tmux, and Least jobs.",
      inputSchema: agentWorkspaceSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Listing local agent sessions...",
        "openai/toolInvocation/invoked": "Local agent sessions listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_sessions", args, async () => await agentSessions(workspace));
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_attach_hint",
    {
      title: "Agent Attach Hint",
      description: "Return exact human attach/watch/tail commands for a local agent job, including Zellij, tmux, and log fallback commands.",
      inputSchema: agentJobInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Preparing local agent attach commands...",
        "openai/toolInvocation/invoked": "Local agent attach commands ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_attach_hint", args, async () =>
        await agentAttachHint(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id")
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_plan",
    {
      title: "Agent Plan",
      description: "Dry-run a local agent launch request and return the generated task id, risk, and timeout metadata. Does not launch anything.",
      inputSchema: agentStartInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Planning local agent launch...",
        "openai/toolInvocation/invoked": "Local agent launch plan ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const input = agentInputFromArgs(args, workspace);
      validateStartInput(input);
      const result = await runWithToolTimeout("agent_plan", args, async () => await Promise.resolve(agentPlan(input)));
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_start",
    {
      title: "Agent Start",
      description: "Create or reuse a durable Groundcrew local agent job and return job_id/task_id quickly while backend provisioning continues asynchronously. Requires a mutation lock in lease mode.",
      inputSchema: agentStartInputSchema,
      annotations: {},
      _meta: {
        "openai/toolInvocation/invoking": "Submitting local agent job...",
        "openai/toolInvocation/invoked": "Local agent job accepted"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const input = agentInputFromArgs(args, workspace);
      validateStartInput(input);
      const result = await runWithToolTimeout("agent_start", args, async () => await agentStart(workspace, input));
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_status",
    {
      title: "Agent Status",
      description: "Read a Least/Groundcrew local agent job status by job_id or task_id.",
      inputSchema: {
        ...agentJobInputSchema,
        enforce_timeouts: z.boolean().optional().describe("When true, also enforce watchdog timeouts during the status check. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading local agent status...",
        "openai/toolInvocation/invoked": "Local agent status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_status", args, async () =>
        await agentStatus(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          enforceTimeouts: parseBool(args.enforce_timeouts, false)
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_watchdog",
    {
      title: "Agent Watchdog",
      description: "Evaluate and optionally enforce Least wall-clock and idle timeouts for a local agent job. Enforcing interrupts the Groundcrew workspace and preserves the worktree.",
      inputSchema: agentWatchdogInputSchema,
      annotations: {},
      _meta: {
        "openai/toolInvocation/invoking": "Checking local agent watchdog...",
        "openai/toolInvocation/invoked": "Local agent watchdog checked"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const enforce = parseBool(args.enforce_timeouts, true);
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      if (enforce) {
        assertMutationLock(config, workspace.id, sessionId, leaseToken);
      }
      const result = await runWithToolTimeout("agent_watchdog", args, async () =>
        await agentWatchdog(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          enforceTimeouts: enforce
        })
      );
      if (enforce) {
        renewMutationLock(config, workspace.id, sessionId, leaseToken);
      }
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_tail",
    {
      title: "Agent Tail",
      description: "Capture recent output from a local agent terminal backend by job_id or task_id. Tries Zellij, then tmux, then Least job logs.",
      inputSchema: {
        ...agentJobInputSchema,
        lines: z.number().int().min(20).max(2000).optional().describe("Number of recent terminal/log lines to capture. Default: 200.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Capturing local agent output...",
        "openai/toolInvocation/invoked": "Local agent output captured"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_tail", args, async () =>
        await agentTail(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          lines: args.lines === undefined ? undefined : limitInt(args.lines, 200, 20, 2000)
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_result",
    {
      title: "Agent Result",
      description: "Summarize a local agent job worktree with changed files, diff stat, optional diff, and optional tail.",
      inputSchema: {
        ...agentJobInputSchema,
        include_diff: z.boolean().optional().describe("Include full git diff, truncated by diff_max_chars. Default: false."),
        include_tail: z.boolean().optional().describe("Include recent terminal output using agent_tail. Default: false."),
        diff_max_chars: z.number().int().min(1000).max(500000).optional().describe("Maximum diff characters when include_diff=true. Default: 60000."),
        tail_lines: z.number().int().min(20).max(2000).optional().describe("Number of recent terminal lines when include_tail=true. Default: 200.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Summarizing local agent result...",
        "openai/toolInvocation/invoked": "Local agent result ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("agent_result", args, async () =>
        await agentResult(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          includeDiff: parseBool(args.include_diff, false),
          includeTail: parseBool(args.include_tail, false),
          diffMaxChars: args.diff_max_chars === undefined ? undefined : limitInt(args.diff_max_chars, 60000, 1000, 500000),
          tailLines: args.tail_lines === undefined ? undefined : limitInt(args.tail_lines, 200, 20, 2000)
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_cancel",
    {
      title: "Agent Cancel",
      description: "Interrupt a running Groundcrew local agent workspace while preserving its worktree. Requires a mutation lock in lease mode.",
      inputSchema: {
        ...agentJobInputSchema,
        reason: z.string().optional().describe("Optional reason stored in Groundcrew run state.")
      },
      annotations: {},
      _meta: {
        "openai/toolInvocation/invoking": "Cancelling local agent job...",
        "openai/toolInvocation/invoked": "Local agent job cancelled"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const result = await runWithToolTimeout("agent_cancel", args, async () =>
        await agentCancel(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          reason: strFromArgs(args, "reason")
        })
      );
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_resume",
    {
      title: "Agent Resume",
      description: "Resume an interrupted or dead Groundcrew local agent session in its existing worktree. Requires a mutation lock in lease mode.",
      inputSchema: agentResumeInputSchema,
      annotations: {},
      _meta: {
        "openai/toolInvocation/invoking": "Resuming local agent job...",
        "openai/toolInvocation/invoked": "Local agent job resumed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const result = await runWithToolTimeout("agent_resume", args, async () =>
        await agentResume(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          fresh: parseBool(args.fresh, false)
        })
      );
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "agent_cleanup",
    {
      title: "Agent Cleanup",
      description: "Conservatively clean stale .ai-bridge/agent-runs entries. Worktrees are preserved unless clean_worktrees=true. Never deletes active jobs. Requires a mutation lock in lease mode when dry_run=false.",
      inputSchema: agentCleanupInputSchema,
      annotations: {},
      _meta: {
        "openai/toolInvocation/invoking": "Scanning stale local agent jobs...",
        "openai/toolInvocation/invoked": "Local agent cleanup finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const dryRun = parseBool(args.dry_run, true);
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      if (!dryRun) {
        assertMutationLock(config, workspace.id, sessionId, leaseToken);
      }
      const result = await runWithToolTimeout("agent_cleanup", args, async () =>
        await agentCleanup(workspace, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          jobId: strFromArgs(args, "job_id"),
          taskId: strFromArgs(args, "task_id"),
          olderThan: strFromArgs(args, "older_than"),
          dryRun,
          cleanWorktrees: parseBool(args.clean_worktrees, false),
          force: parseBool(args.force, false)
        })
      );
      if (!dryRun) {
        renewMutationLock(config, workspace.id, sessionId, leaseToken);
      }
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.structured });
    }
  );

  const shellInputSchema = {
    workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
    command: z.string().describe("Command to run."),
    cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
    timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000."),
    lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
  };

  const runShellTool = async (args: Record<string, unknown>) => {
    const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
    const command = String(strFromArgs(args, "command") ?? "");
    // Check bash permission rules from settings
    const bashDecision = evaluateBashPermission(permCtx, "bash", command);
    if (bashDecision.decision === "deny") {
      return errorResult(new LeastError(bashDecision.reason ?? "Command denied by permission rules."));
    }
    if (bashDecision.decision === "ask") {
      return textResult(formatPermissionRequired("bash", bashDecision.reason));
    }
    const sessionId = sessionIdFrom(options);
    const leaseToken = leaseTokenFromArgs(args);
    const mutatesWorkspace = bashRequiresMutationLock(config, command);
    if (mutatesWorkspace) {
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
    }
    const result = await runBash(config, guard, workspace, command, {
      cwd: strFromArgs(args, "cwd"),
      timeoutMs: limitInt(args.timeout_ms, 120_000, 1_000, 3_600_000)
    });
    if (mutatesWorkspace) {
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);
    }
    const combined = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`;
    const shaped = await shapeForTool(config, workspace, "bash", shellKindFromCommand(result.command), combined, {
      command: result.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated
    });
    const retrievalHint = shaped.outputMeta.retrievalHint ? `\nRetrieval: ${shaped.outputMeta.retrievalHint}` : "";
    const text = `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms${retrievalHint}\n\n## output\n\n\`\`\`text\n${shaped.text}\n\`\`\``;
    return textResult(text, {
      workspace_id: workspace.id,
      root: workspace.root,
      ...result,
      stdout: shaped.text,
      rawBytes: shaped.rawBytes,
      visibleBytes: shaped.visibleBytes,
      savedBytes: shaped.savedBytes,
      compacted: shaped.outputMeta.compacted,
      output_meta: shaped.outputMeta
    });
  };

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "least_inventory",
    {
      title: "Least Inventory",
      description:
        "List Least modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading Least inventory...",
        "openai/toolInvocation/invoked": "Least inventory ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const inventory = await leastInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        skills: inventory.skills,
        mcp_servers: inventory.mcpServers,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        name: z.string().describe("Exact skill name from skill_inventory or least_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source when multiple skills share a name."),
        path: z.string().optional().describe("Exact sanitized path from skill_inventory when name/source are still ambiguous."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: true."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const loaded = await loadSkill(workspace, config, {
        name: String(strFromArgs(args, "name") ?? ""),
        source: (() => {
        const raw = strFromArgs(args, "source");
        if (raw === "workspace" || raw === "user" || raw === "plugin" || raw === "other") return raw;
        return undefined;
      })(),
        path: typeof strFromArgs(args, "path") === "string" ? strFromArgs(args, "path") : undefined,
        includeGlobal: parseBool(args.include_global_skills, true),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List currently opened Least workspaces for this MCP session.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Listing Least workspaces...",
        "openai/toolInvocation/invoked": "Least workspaces listed"
      }
    },
    async () => {
      const current = workspaces.listWorkspaces();
      const text = current.length
        ? current.map((workspace) => `- ${workspace.id} — ${workspace.root} (opened ${workspace.openedAt})`).join("\n")
        : "No workspaces opened yet. Call open_workspace first.";
      return textResult(text, { workspaces: current });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Use this once at the start to open the configured default workspace without accepting a path. Do not call open_workspace after this unless switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover workspace, user, and plugin skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        include_recent_commits: z.boolean().optional().describe("Include recent git log lines. Default: false for speed.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current Least workspace...",
        "openai/toolInvocation/invoked": "Current Least workspace opened"
      }
    },
    async (args) => {
      const workspace = workspaces.defaultWorkspace();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        includeRecentCommits: parseBool(args.include_recent_commits, false),
        bootstrapContext: false
      });
      const lockPayload = workspaceLockPayload(config, summary.workspaceId);
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        shell_backend: config.shellBackend,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        toolset: config.toolset,
        concurrency_mode: config.concurrencyMode,
        ...lockPayload
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "workspace_lock_status",
    {
      title: "Workspace Lock Status",
      description: "Inspect whether this workspace currently has an exclusive mutation lock and who owns it.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading workspace lock status...",
        "openai/toolInvocation/invoked": "Workspace lock status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const status = lockManager(config).status(workspace.id);
      const text = status.locked
        ? `# Workspace Lock Status\n\nLocked: yes\nOwner: ${status.owner_label ?? status.owner_session_id ?? "unknown"}\nExpires: ${status.expires_at}\nSeconds remaining: ${status.seconds_remaining}`
        : "# Workspace Lock Status\n\nLocked: no";
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...status, concurrency_mode: config.concurrencyMode });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "acquire_workspace_lock",
    {
      title: "Acquire Workspace Lock",
      description: "Acquire exclusive mutation rights for this workspace. Required before write, edit, or mutating bash when concurrency mode is lease.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        client_label: z.string().optional().describe("Optional human label for lock visibility, for example chatgpt or grok.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Acquiring workspace lock...",
        "openai/toolInvocation/invoked": "Workspace lock acquired"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const result = lockManager(config).acquire(workspace.id, sessionId, strFromArgs(args, "client_label"));
      if (!result.ok) {
        const seconds = lockSecondsRemaining(result.lock);
        const structured = {
          acquired: false,
          workspace_id: workspace.id,
          owner: false,
          locked_by_other: true,
          current_owner_label: result.lock.ownerLabel,
          current_expires_at: result.lock.expiresAt,
          seconds_remaining: seconds,
          concurrency_mode: config.concurrencyMode
        };
        const text = `# Acquire Workspace Lock\n\nDenied: workspace is locked by ${result.lock.ownerLabel ?? "another session"} for ${seconds}s.`;
        return { ...textResult(text, structured), isError: true };
      }
      const seconds = lockSecondsRemaining(result.lock);
      const structured = {
        acquired: true,
        workspace_id: workspace.id,
        owner: true,
        owner_label: result.lock.ownerLabel,
        lease_token: result.lock.leaseToken,
        acquired_at: result.lock.acquiredAt,
        expires_at: result.lock.expiresAt,
        seconds_remaining: seconds,
        already_owned: result.alreadyOwned,
        concurrency_mode: config.concurrencyMode
      };
      const text = `# Acquire Workspace Lock\n\nAcquired exclusive mutation lock.\nLease token: ${result.lock.leaseToken}\nExpires: ${result.lock.expiresAt}\nSeconds remaining: ${seconds}`;
      return textResult(text, structured);
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "renew_workspace_lock",
    {
      title: "Renew Workspace Lock",
      description: "Extend the current session's workspace mutation lease without performing a mutation.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Renewing workspace lock...",
        "openai/toolInvocation/invoked": "Workspace lock renewed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const renewed = lockManager(config).renew(workspace.id, sessionId, leaseTokenFromArgs(args));
      if (!renewed) {
        throw new LeastError("Cannot renew workspace lock. Acquire it first with acquire_workspace_lock.");
      }
      const seconds = lockSecondsRemaining(renewed);
      const structured = {
        renewed: true,
        workspace_id: workspace.id,
        expires_at: renewed.expiresAt,
        seconds_remaining: seconds,
        concurrency_mode: config.concurrencyMode
      };
      const text = `# Renew Workspace Lock\n\nRenewed.\nExpires: ${renewed.expiresAt}\nSeconds remaining: ${seconds}`;
      return textResult(text, structured);
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "release_workspace_lock",
    {
      title: "Release Workspace Lock",
      description: "Release the current session's workspace mutation lock when finished editing.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Releasing workspace lock...",
        "openai/toolInvocation/invoked": "Workspace lock released"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const result = lockManager(config).release(workspace.id, sessionId, leaseTokenFromArgs(args));
      const structured = {
        released: result.released,
        workspace_id: workspace.id,
        concurrency_mode: config.concurrencyMode,
        ...(!result.released ? { reason: result.reason } : {})
      };
      const text = result.released
        ? "# Release Workspace Lock\n\nReleased."
        : result.reason === "no_lock"
          ? "# Release Workspace Lock\n\nNo active lock to release."
          : "# Release Workspace Lock\n\nNot the lock owner; nothing released.";
      return textResult(text, structured);
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open a local project directory as a Least workspace. Returns a workspace_id plus git status and AGENTS.md. Use files/search_context for fast exploration instead of include_tree by default.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use LEAST_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover workspace, user, and plugin skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        include_recent_commits: z.boolean().optional().describe("Include recent git log lines. Default: false for speed."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening Least workspace...",
        "openai/toolInvocation/invoked": "Least workspace opened"
      }
    },
    async (args) => {
      if (strFromArgs(args, "root") && strFromArgs(args, "path") && strFromArgs(args, "root") !== strFromArgs(args, "path")) {
        throw new LeastError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = workspaces.openWorkspace(strFromArgs(args, "root") ?? strFromArgs(args, "path"));
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        includeRecentCommits: parseBool(args.include_recent_commits, false),
        bootstrapContext: false
      });
      const lockPayload = workspaceLockPayload(config, summary.workspaceId);
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        shell_backend: config.shellBackend,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        toolset: config.toolset,
        concurrency_mode: config.concurrencyMode,
        ...lockPayload
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const text = `${summary.text}\n\n## AI handoff context\n\n${ai.text}`;
      const lockPayload = workspaceLockPayload(config, workspace.id);
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ai_context_files: ai.files,
        concurrency_mode: config.concurrencyMode,
        ...lockPayload
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "tree",
    {
      title: "File Tree",
      description: "Render a directory tree for orientation. Prefer files for fast candidate discovery during exploration.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await repoTree(config, guard, workspace, {
        path: strFromArgs(args, "path") ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "context_pack",
    {
      title: "Context Pack",
      description: "Gather compact task-relevant repo context in one call.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task: z.string().describe("Task description used to rank relevant files."),
        profile: z.enum(["explore", "edit", "debug", "review"]).optional().describe("Ranking profile. Default: edit."),
        explain: z.boolean().optional().describe("Include score breakdown reasons for selected files. Default: false."),
        query: z.string().optional().describe("Optional search query to gather code snippets."),
        paths: z.array(z.string()).optional().describe("Exact workspace-relative files to prioritize."),
        globs: z.array(z.string()).optional().describe("Glob patterns to expand into candidate files."),
        max_files: z.number().int().min(1).max(50).optional().describe("Maximum candidate files. Default: 12."),
        max_snippets: z.number().int().min(1).max(40).optional().describe("Maximum snippets. Default: 12."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Byte budget across direct file reads."),
        max_tokens_estimate: z.number().int().min(100).max(500000).optional().describe("Approximate token budget for returned text."),
        include_git_status: z.boolean().optional().describe("Include git status. Default: true."),
        include_package_context: z.boolean().optional().describe("Include package.json context when available. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Packing repo context...",
        "openai/toolInvocation/invoked": "Repo context packed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("context_pack", args, (signal) =>
        contextPack(config, guard, workspace, {
          task: String(strFromArgs(args, "task") ?? ""),
          profile: strFromArgs(args, "profile") as "explore" | "edit" | "debug" | "review" | undefined,
          explain: parseBool(args.explain, false),
          query: strFromArgs(args, "query"),
          paths: Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === "string") : undefined,
          globs: Array.isArray(args.globs) ? args.globs.filter((item): item is string => typeof item === "string") : undefined,
          maxFiles: limitInt(args.max_files, 12, 1, 50),
          maxSnippets: limitInt(args.max_snippets, 12, 1, 40),
          maxBytes: Math.min(limitInt(args.max_bytes, config.maxReadBytes * 2, 1_000, config.maxReadBytes * 10), byteBudgetFromArgs(args, config.maxReadBytes * 2)),
          maxTokensEstimate: typeof args.max_tokens_estimate === "number" ? args.max_tokens_estimate : undefined,
          includeGitStatus: parseBool(args.include_git_status, true),
          includePackageContext: parseBool(args.include_package_context, true),
          signal
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "project_memory_search",
    {
      title: "Project Memory Search",
      description: "Search durable project-scoped memory stored under .least/memory/project-memory.jsonl.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Search query for memory text and paths."),
        kind: z.enum(["architecture", "command", "decision", "warning", "workflow", "file_map"]).optional(),
        max_results: z.number().int().min(1).max(20).optional().describe("Maximum records. Default: 8.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Searching project memory...",
        "openai/toolInvocation/invoked": "Project memory search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const records = await searchProjectMemory(workspace, String(strFromArgs(args, "query") ?? ""), {
        kind: strFromArgs(args, "kind") as "architecture" | "command" | "decision" | "warning" | "workflow" | "file_map" | undefined,
        maxResults: limitInt(args.max_results, 8, 1, 20)
      });
      const text = records.length
        ? records.map((record) => `- [${record.kind}] ${record.text}${record.paths?.length ? ` (${record.paths.join(", ")})` : ""}`).join("\n")
        : "No project memory matched.";
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, records });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "project_memory_save",
    {
      title: "Project Memory Save",
      description: "Save a durable project fact to local JSONL memory with redaction and deduplication.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        kind: z.enum(["architecture", "command", "decision", "warning", "workflow", "file_map"]),
        text: z.string().describe("Short durable fact to remember."),
        paths: z.array(z.string()).optional().describe("Optional related workspace-relative paths."),
        confidence: z.number().min(0).max(1).optional().describe("Confidence score. Default: 0.7.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Saving project memory...",
        "openai/toolInvocation/invoked": "Project memory saved"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const record = await saveProjectMemory(workspace, {
        kind: strFromArgs(args, "kind") as "architecture" | "command" | "decision" | "warning" | "workflow" | "file_map",
        text: String(strFromArgs(args, "text") ?? ""),
        paths: Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === "string") : undefined,
        confidence: typeof args.confidence === "number" ? args.confidence : undefined,
        source: "tool"
      });
      return textResult(`Saved project memory [${record.kind}]: ${record.text}`, { workspace_id: workspace.id, root: workspace.root, record });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "project_memory_update",
    {
      title: "Project Memory Update",
      description: "Update an existing project memory record by id, optionally superseding it with a new record.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        id: z.string().describe("Existing memory record id."),
        text: z.string().describe("Updated memory text."),
        supersede: z.boolean().optional().describe("Create a new record and mark the old one superseded. Default: false.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Updating project memory...",
        "openai/toolInvocation/invoked": "Project memory updated"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const record = await updateProjectMemory(workspace, String(strFromArgs(args, "id") ?? ""), String(strFromArgs(args, "text") ?? ""), parseBool(args.supersede, false));
      return textResult(`Updated project memory [${record.kind}]: ${record.text}`, { workspace_id: workspace.id, root: workspace.root, record });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "project_map",
    {
      title: "Project Map",
      description: "Build a lightweight symbol and file map for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        refresh: z.boolean().optional().describe("Ignore the cached project map and rebuild. Default: false."),
        globs: z.array(z.string()).optional().describe("Optional file globs to restrict indexing."),
        include_imports: z.boolean().optional().describe("Include import edges. Default: true."),
        include_exports: z.boolean().optional().describe("Include exported symbols. Default: true."),
        include_tests: z.boolean().optional().describe("Include test files. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Building project map...",
        "openai/toolInvocation/invoked": "Project map ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("project_map", args, () =>
        buildProjectMap(config, guard, workspace, {
          refresh: parseBool(args.refresh, false),
          globs: Array.isArray(args.globs) ? args.globs.filter((item): item is string => typeof item === "string") : undefined,
          includeImports: parseBool(args.include_imports, true),
          includeExports: parseBool(args.include_exports, true),
          includeTests: parseBool(args.include_tests, true)
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "warmup",
    {
      title: "Warmup",
      description: "Warm file, git, package, and symbol caches in the background-friendly server process.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        indexes: z.array(z.enum(["files", "git", "package", "symbols"])).optional().describe("Indexes to warm. Default: files, git, package.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Warming Least caches...",
        "openai/toolInvocation/invoked": "Least caches warmed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const indexes = Array.isArray(args.indexes) ? args.indexes.filter((item): item is "files" | "git" | "package" | "symbols" => item === "files" || item === "git" || item === "package" || item === "symbols") : [];
      const warmed = await runWithToolTimeout("warmup", args, () => runWarmup(config, guard, workspace, indexes));
      return textResult(`# Warmup\n\nIndexes: ${(indexes.length ? indexes : ["files", "git", "package"]).join(", ")}\n`, { workspace_id: workspace.id, root: workspace.root, warmed });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "files",
    {
      title: "List Files",
      description:
        "Fast flat file discovery using git ls-files, ripgrep --files, or a Node fallback. Prefer this over tree for first-pass exploration.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob filter, for example src/**/*.ts."),
        tracked_only: z.boolean().optional().describe("Use git ls-files for version-controlled files only. Default: false."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(20000).optional().describe("Maximum files to return. Default: 5000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("files", args, (signal) =>
        listWorkspaceFiles(config, guard, workspace, {
          root: strFromArgs(args, "path") ?? ".",
          glob: strFromArgs(args, "glob"),
          trackedOnly: parseBool(args.tracked_only, false),
          includeHidden: parseBool(args.include_hidden, false),
          maxResults: limitInt(args.max_results, 5000, 1, 20_000),
          signal
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "search",
    {
      title: "Search Files",
      description:
        "Fast content search using native ripgrep when available. Prefer search_context when nearby code is needed. Avoid repeated broad searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("search", args, (signal) =>
        searchWorkspace(config, guard, workspace, {
          query: strFromArgs(args, "query"),
          regex: parseBool(args.regex, false),
          root: strFromArgs(args, "path") ?? ".",
          glob: strFromArgs(args, "glob"),
          includeHidden: parseBool(args.include_hidden, false),
          maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults),
          signal
        })
      );
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "search_context",
    {
      title: "Search With Context",
      description:
        "Search and return matched lines plus surrounding context in one call. Prefer this over search followed by multiple read calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        before_lines: z.number().int().min(0).max(20).optional().describe("Context lines before each match. Default: 2."),
        after_lines: z.number().int().min(0).max(20).optional().describe("Context lines after each match. Default: 2."),
        max_matches: z.number().int().min(1).max(2000).optional().describe("Maximum matches. Default from config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Searching workspace with context...",
        "openai/toolInvocation/invoked": "Context search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await runWithToolTimeout("search_context", args, (signal) =>
        searchWorkspaceContext(config, guard, workspace, {
          query: strFromArgs(args, "query"),
          regex: parseBool(args.regex, false),
          root: strFromArgs(args, "path") ?? ".",
          glob: strFromArgs(args, "glob"),
          includeHidden: parseBool(args.include_hidden, false),
          beforeLines: limitInt(args.before_lines, 2, 0, 20),
          afterLines: limitInt(args.after_lines, 2, 0, 20),
          maxResults: limitInt(args.max_matches, config.maxSearchResults, 1, config.maxSearchResults),
          signal
        })
      );
      const shaped = await shapeForTool(config, workspace, "search_context", "search", result.text, {
        maxVisibleBytes: config.maxOutputBytes
      });
      const text = shaped.outputMeta.compacted ? `${shaped.outputMeta.summary ?? "Search compacted"}\n\n${shaped.text}` : result.text;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ...result,
        text,
        rawBytes: shaped.rawBytes,
        visibleBytes: shaped.visibleBytes,
        savedBytes: shaped.savedBytes,
        compacted: shaped.outputMeta.compacted,
        output_meta: shaped.outputMeta
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "read",
    {
      title: "Read File",
      description: "Read one text file with line numbers. Prefer read_many when inspecting multiple files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config."),
        include_sha256: z.boolean().optional().describe("Compute and return the full-file SHA-256. Default: false for faster exploration reads."),
        include_line_numbers: z.boolean().optional().describe("Include line numbers in returned text. Default: true."),
        include_total_lines: z.boolean().optional().describe("Return an exact total line count. Default: false for bounded range reads and true for full-file reads."),
        max_tokens_estimate: z.number().int().min(100).max(500000).optional().describe("Optional approximate token budget to convert into a byte cap for faster reads.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      // Check read permission rules from settings
      const readDecision = evaluateReadPermission(permCtx, "read", strFromArgs(args, "path") ?? "");
      if (readDecision.decision === "deny") {
        return errorResult(new LeastError(readDecision.reason ?? "Read denied by permission rules."));
      }
      if (readDecision.decision === "ask") {
        return textResult(formatPermissionRequired("read", readDecision.reason));
      }

      const tokenBudgetBytes = typeof args.max_tokens_estimate === "number" ? Math.max(1_000, Math.floor(args.max_tokens_estimate * 4)) : config.maxReadBytes;
      const result = await runWithToolTimeout("read", args, (signal) =>
        readTextFile(config, guard, workspace, strFromArgs(args, "path") ?? "", {
          startLine: limitInt(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER),
          endLine: args.end_line === undefined ? undefined : limitInt(args.end_line, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
          maxBytes: Math.min(limitInt(args.max_bytes, config.maxReadBytes, 1, config.maxReadBytes), tokenBudgetBytes),
          includeSha256: parseBool(args.include_sha256, false),
          includeLineNumbers: parseBool(args.include_line_numbers, true),
          includeTotalLines: parseBool(args.include_total_lines, args.end_line === undefined),
          signal
        })
      );
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine}${result.totalLines !== undefined ? ` of ${result.totalLines}` : ""}\nBytes: ${result.bytes}\n${result.sha256 ? `SHA-256: ${result.sha256}\n` : ""}${result.partial ? "Partial: true\n" : ""}${result.timedOut ? "Timed out: true\n" : ""}\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "read_around",
    {
      title: "Read Around",
      description: "Read lines around a known line number in one call.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        line: z.number().int().min(1).describe("Anchor line number."),
        before: z.number().int().min(0).max(500).optional().describe("Lines to include before the anchor. Default: 20."),
        after: z.number().int().min(0).max(500).optional().describe("Lines to include after the anchor. Default: 40."),
        include_sha256: z.boolean().optional().describe("Compute and return full-file SHA-256. Default: false."),
        include_line_numbers: z.boolean().optional().describe("Include line numbers in returned text. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading surrounding lines...",
        "openai/toolInvocation/invoked": "Surrounding lines read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const line = limitInt(args.line, 1, 1, Number.MAX_SAFE_INTEGER);
      const before = limitInt(args.before, 20, 0, 500);
      const after = limitInt(args.after, 40, 0, 500);
      const result = await runWithToolTimeout("read_around", args, (signal) =>
        readTextFile(config, guard, workspace, strFromArgs(args, "path") ?? "", {
          startLine: Math.max(1, line - before),
          endLine: line + after,
          maxBytes: Math.min(config.maxReadBytes, byteBudgetFromArgs(args, config.maxReadBytes)),
          includeSha256: parseBool(args.include_sha256, false),
          includeLineNumbers: parseBool(args.include_line_numbers, true),
          includeTotalLines: false,
          signal
        })
      );
      const text = `# Read Around\n\nPath: ${result.path}\nAnchor line: ${line}\nLines: ${result.startLine}-${result.endLine}\n${result.sha256 ? `SHA-256: ${result.sha256}\n` : ""}\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, anchor_line: line, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "read_many",
    {
      title: "Read Many Files",
      description: "Read multiple text files or line ranges in one request. Prefer this over repeated read calls during exploration.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        items: z
          .array(
            z.object({
              path: z.string().describe("File path relative to workspace root."),
              start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
              end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file.")
            })
          )
          .min(1)
          .max(20)
          .describe("Files or ranges to read in one batch."),
        max_total_bytes: z.number().int().min(1000).max(2000000).optional().describe("Total byte budget across all files."),
        max_tokens_estimate: z.number().int().min(100).max(500000).optional().describe("Optional approximate token budget to convert into a byte cap for the batch."),
        concurrency: z.number().int().min(1).max(16).optional().describe("Maximum concurrent file reads. Default: 8."),
        include_sha256: z.boolean().optional().describe("Compute and return full-file SHA-256 values. Default: false."),
        include_line_numbers: z.boolean().optional().describe("Include line numbers in returned file text. Default: true."),
        include_total_lines: z.boolean().optional().describe("Return exact total line counts. Default: false for bounded range reads.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading files...",
        "openai/toolInvocation/invoked": "Files read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const rawItems = Array.isArray(args.items) ? args.items : [];
      const items = rawItems.map((item) => {
        if (!item || typeof item !== "object") throw new LeastError("Each read_many item must be an object with path.");
        const record = item as Record<string, unknown>;
        return {
          path: String(record.path ?? ""),
          startLine: typeof record.start_line === "number" ? record.start_line : undefined,
          endLine: typeof record.end_line === "number" ? record.end_line : undefined
        };
      });
      const tokenBudgetBytes =
        typeof args.max_tokens_estimate === "number"
          ? Math.max(1_000, Math.floor(args.max_tokens_estimate * 4))
          : config.maxReadBytes * 3;
      const result = await runWithToolTimeout("read_many", args, (signal) =>
        readManyTextFiles(config, guard, workspace, items, {
          maxTotalBytes: Math.min(
            limitInt(args.max_total_bytes, config.maxReadBytes * 3, 1000, config.maxReadBytes * 10),
            tokenBudgetBytes
          ),
          concurrency: limitInt(args.concurrency, 8, 1, 16),
          includeSha256: parseBool(args.include_sha256, false),
          includeLineNumbers: parseBool(args.include_line_numbers, true),
          includeTotalLines: parseBool(args.include_total_lines, false),
          signal
        })
      );
      const text = `# Read Many\n\nFiles: ${result.files.length}\nTotal bytes: ${result.totalBytes}\nTruncated: ${result.truncated}\n${result.partial ? "Partial: true\n" : ""}${result.timedOut ? "Timed out: true\n" : ""}\n${result.text}`;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "batch",
    {
      title: "Batch",
      description: "Run multiple read-only Least tools in one request to reduce round trips during exploration and review workflows.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Read-only Least tool name."),
              args: z.record(z.unknown()).optional().describe("Arguments for the tool call.")
            })
          )
          .min(1)
          .max(12)
          .describe("Read-only tool calls to run in one batch."),
        max_parallel: z.number().int().min(1).max(8).optional().describe("Maximum concurrent internal tool calls. Default: 4.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Running Least batch...",
        "openai/toolInvocation/invoked": "Least batch complete"
      }
    },
    async (args) => {
      const rawCalls = Array.isArray(args.calls) ? args.calls : [];
      if (!rawCalls.length) {
        throw new LeastError("calls must include at least one batch entry.");
      }
      const maxParallel = limitInt(args.max_parallel, 4, 1, 8);
      const results = new Array<{ tool: string; isError: boolean; content: string }>(rawCalls.length);
      let nextIndex = 0;

      async function worker(): Promise<void> {
        while (nextIndex < rawCalls.length) {
          const current = nextIndex;
          nextIndex += 1;
          const entry = rawCalls[current];
          if (!entry || typeof entry !== "object") {
            results[current] = { tool: "unknown", isError: true, content: "Invalid batch call entry." };
            continue;
          }
          const record = entry as Record<string, unknown>;
          const tool = String(record.tool ?? "");
          const callArgs =
            record.args && typeof record.args === "object" && !Array.isArray(record.args)
              ? (record.args as Record<string, unknown>)
              : {};
          if (!BATCH_READ_ONLY_TOOLS.has(tool)) {
            results[current] = {
              tool,
              isError: true,
              content: `Tool ${tool || "(empty)"} is not allowed in batch.`
            };
            continue;
          }
          const invoked = await registry.invoke(tool, callArgs);
          results[current] = { tool, isError: Boolean(invoked?.isError), content: invoked?.content ?? "" };
        }
      }

      await Promise.all(Array.from({ length: Math.min(maxParallel, rawCalls.length) }, () => worker()));
      const errors = results.filter((item) => item?.isError).length;
      const text = `# Batch\n\nCalls: ${results.length}\nErrors: ${errors}\n\n${results
        .map((item, index) => `## ${index + 1}. ${item.tool}\nError: ${item.isError}\n\n${item.content}`)
        .join("\n\n---\n\n")}`;
      return textResult(text, { count: results.length, errors, results });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "json_query",
    {
      title: "JSON Query",
      description:
        "Read JSON or JSONC files and extract values with a JSON Pointer. Useful for package.json, tsconfig.json, and config inspection without shell jq.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Single JSON file relative to workspace root."),
        glob: z.string().optional().describe("Glob for JSON files when path is omitted. Default: **/*.{json,jsonc}."),
        pointer: z.string().optional().describe('JSON Pointer to extract, for example /scripts or /dependencies/react. Default: /.'),
        max_results: z.number().int().min(1).max(100).optional().describe("Maximum files to inspect. Default: 20.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Querying JSON files...",
        "openai/toolInvocation/invoked": "JSON query complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await queryJsonFiles(config, guard, workspace, {
        path: strFromArgs(args, "path"),
        glob: strFromArgs(args, "glob"),
        pointer: strFromArgs(args, "pointer") ?? "/",
        maxResults: limitInt(args.max_results, 20, 1, 100)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. Returns a unified diff; do not create empty placeholder files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true."),
        expected_sha256: z.string().optional().describe("SHA-256 from read. Rejects stale writes when the file changed."),
        expect_absent: z.boolean().optional().describe("When true with expected_sha256, require that the file does not exist yet."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const filePath = strFromArgs(args, "path") ?? "";
      // Check write permission rules from settings
      const writeDecision = evaluateWritePermission(permCtx, "write", filePath);
      if (writeDecision.decision === "deny") {
        return errorResult(new LeastError(writeDecision.reason ?? "Write denied by permission rules."));
      }
      if (writeDecision.decision === "ask") {
        return textResult(formatPermissionRequired("write", writeDecision.reason));
      }
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const resolved = guard.resolve(workspace, filePath, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      await assertStaleFileState(config, guard, workspace, filePath, args);
      const result = await writeTextFile(config, guard, workspace, filePath, String(strFromArgs(args, "content") ?? ""), {
        createDirs: parseBool(args.create_dirs, true),
        overwrite: parseBool(args.overwrite, true)
      });
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement inside a workspace text file. Returns a unified diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs."),
        expected_sha256: z.string().optional().describe("SHA-256 from read. Rejects stale edits when the file changed."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const filePath = strFromArgs(args, "path") ?? "";
      // Check edit permission rules from settings
      const editDecision = evaluateWritePermission(permCtx, "edit", filePath);
      if (editDecision.decision === "deny") {
        return errorResult(new LeastError(editDecision.reason ?? "Edit denied by permission rules."));
      }
      if (editDecision.decision === "ask") {
        return textResult(formatPermissionRequired("edit", editDecision.reason));
      }

      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const resolved = guard.resolve(workspace, filePath, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      await assertStaleFileState(config, guard, workspace, filePath, args);
      const result = await editTextFile(config, guard, workspace, filePath, String(strFromArgs(args, "old_text") ?? ""), String(strFromArgs(args, "new_text") ?? ""), {
        replaceAll: parseBool(args.replace_all, false),
        expectedReplacements: limitInt(args.expected_replacements, 1, 1, 10_000)
      });
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "multi_edit",
    {
      title: "Multi Edit",
      description: "Apply several exact text edits across files in one call.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        edits: z
          .array(
            z.object({
              path: z.string(),
              old_text: z.string(),
              new_text: z.string(),
              replace_all: z.boolean().optional(),
              expected_replacements: z.number().int().min(1).optional()
            })
          )
          .min(1)
          .max(100)
          .describe("Exact text edits to apply."),
        expected_sha256s: z.record(z.string()).optional().describe("Optional map of expected file sha256 values keyed by path."),
        include_diff: z.boolean().optional().describe("Include the combined diff. Default: true."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying multiple edits...",
        "openai/toolInvocation/invoked": "Multiple edits applied"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const rawEdits = Array.isArray(args.edits) ? args.edits : [];
      if (!rawEdits.length) throw new LeastError("edits must include at least one item.");
      const expectedShaMap =
        args.expected_sha256s && typeof args.expected_sha256s === "object" && !Array.isArray(args.expected_sha256s)
          ? (args.expected_sha256s as Record<string, unknown>)
          : {};
      const results: Array<Record<string, unknown>> = [];
      const diffs: string[] = [];
      for (const item of rawEdits) {
        if (!item || typeof item !== "object") throw new LeastError("Each multi_edit item must be an object.");
        const edit = item as Record<string, unknown>;
        const filePath = String(edit.path ?? "");
        const resolved = guard.resolve(workspace, filePath, { forWrite: true });
        assertWriteToolAllowed(config, resolved.relPath);
        const expected =
          typeof expectedShaMap[filePath] === "string"
            ? expectedShaMap[filePath]
            : typeof expectedShaMap[resolved.relPath] === "string"
              ? expectedShaMap[resolved.relPath]
              : undefined;
        if (typeof expected === "string") {
          await assertStaleFileState(config, guard, workspace, resolved.relPath, { expected_sha256: expected });
        }
        const result = await editTextFile(
          config,
          guard,
          workspace,
          filePath,
          String(edit.old_text ?? ""),
          String(edit.new_text ?? ""),
          {
            replaceAll: parseBool(edit.replace_all, false),
            expectedReplacements: typeof edit.expected_replacements === "number" ? edit.expected_replacements : undefined
          }
        );
        results.push(result);
        diffs.push(result.diff.diff);
      }
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);
      const includeDiff = parseBool(args.include_diff, true);
      const additions = results.reduce((sum, item) => sum + Number((item.diff as { additions?: number })?.additions ?? 0), 0);
      const deletions = results.reduce((sum, item) => sum + Number((item.diff as { deletions?: number })?.deletions ?? 0), 0);
      const text = `# Multi Edit\n\nEdits: ${results.length}\nDiff stats: +${additions} -${deletions}${includeDiff ? diffBlock(diffs.join("\n\n")) : "\n\nDiff omitted by request."}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        edits: results,
        additions,
        deletions,
        diff: includeDiff ? diffs.join("\n\n") : undefined
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "apply_patch",
    {
      title: "Apply Patch",
      description: "Apply a Codex-style Begin Patch block across one or more files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        patch: z.string().describe("Patch text using the *** Begin Patch / *** End Patch format."),
        check_only: z.boolean().optional().describe("Validate without writing files. Default: false."),
        include_diff: z.boolean().optional().describe("Include the combined diff. Default: true."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying patch...",
        "openai/toolInvocation/invoked": "Patch applied"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const result = await applyWorkspacePatch(config, guard, workspace, String(strFromArgs(args, "patch") ?? ""), {
        checkOnly: parseBool(args.check_only, false)
      });
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      if (!parseBool(args.check_only, false)) {
        invalidateDerivedWorkspaceState(workspace.id);
      }
      const includeDiff = parseBool(args.include_diff, true);
      const text = `# Apply Patch\n\nChanged files: ${result.changedFiles.length}\nCheck only: ${parseBool(args.check_only, false)}\nDiff stats: +${result.additions} -${result.deletions}${includeDiff ? diffBlock(result.diff) : "\n\nDiff omitted by request."}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ...result,
        check_only: parseBool(args.check_only, false),
        diff: includeDiff ? result.diff : undefined
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted shell command in the workspace. LEAST_BASH_MODE=safe allows tests/build scripts; readonly allows rg/head/tail-style inspection; full allows arbitrary commands. Prefer files/search_context/read_many for repo exploration. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: shellInputSchema,
      annotations: BASH_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    runShellTool
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "shell",
    {
      title: "Shell",
      description:
        "Run a shell command using the configured shell backend. This is an alias for bash with the current schema, including lease_token for lease-mode clients that reconnect between tool calls.",
      inputSchema: shellInputSchema,
      annotations: BASH_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Running shell command...",
        "openai/toolInvocation/invoked": "Shell command finished"
      }
    },
    runShellTool
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const status = await gitStatus(config, workspace);
      return textResult(status, { workspace_id: workspace.id, root: workspace.root, status });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const rawDiff = await gitDiff(config, guard, workspace, strFromArgs(args, "path"), parseBool(args.staged, false));
      const shaped = await shapeForTool(config, workspace, "git_diff", "git_diff", rawDiff, { maxVisibleBytes: config.maxOutputBytes });
      const diff = shaped.text;
      return textResult(diff, {
        workspace_id: workspace.id,
        root: workspace.root,
        diff,
        rawBytes: shaped.rawBytes,
        visibleBytes: shaped.visibleBytes,
        savedBytes: shaped.savedBytes,
        compacted: shaped.outputMeta.compacted,
        output_meta: shaped.outputMeta
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "diff_summary",
    {
      title: "Diff Summary",
      description: "Summarize changed files with status, line counts, and rough risk classification.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file or directory scope."),
        staged: z.boolean().optional().describe("Summarize staged changes. Default: false."),
        classify: z.boolean().optional().describe("Include kind and risk classification. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Summarizing diff...",
        "openai/toolInvocation/invoked": "Diff summary ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const scopedPath = strFromArgs(args, "path");
      const status = await gitStatus(config, workspace, guard, scopedPath, REVIEW_GIT_STATUS_OPTIONS);
      const result = await diffSummary(config, guard, workspace, status, {
        staged: parseBool(args.staged, false),
        classify: parseBool(args.classify, true),
        path: scopedPath
      });
      const text = `# Diff Summary\n\nFiles: ${result.totals.files}\nAdditions: ${result.totals.additions}\nDeletions: ${result.totals.deletions}\n\n${result.text}`;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, status, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "read_changed_files",
    {
      title: "Read Changed Files",
      description: "Read changed source, test, config, or docs files in one review-oriented result.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_untracked: z.boolean().optional().describe("Include untracked files. Default: true."),
        include_staged: z.boolean().optional().describe("Include staged files. Default: true."),
        include_unstaged: z.boolean().optional().describe("Include unstaged files. Default: true."),
        globs: z.array(z.string()).optional().describe("Optional include globs."),
        exclude_globs: z.array(z.string()).optional().describe("Optional exclude globs."),
        max_files: z.number().int().min(1).max(50).optional().describe("Maximum files to consider. Default: 12."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum bytes per file to read."),
        include_lockfiles: z.boolean().optional().describe("Include lockfiles. Default: false."),
        include_generated: z.boolean().optional().describe("Include generated files. Default: false."),
        max_tokens_estimate: z.number().int().min(100).max(500000).optional().describe("Approximate token budget for file contents.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading changed files...",
        "openai/toolInvocation/invoked": "Changed files read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const status = await gitStatus(config, workspace, guard, undefined, REVIEW_GIT_STATUS_OPTIONS);
      const result = await runWithToolTimeout("read_changed_files", args, (signal) =>
        readChangedFiles(config, guard, workspace, status, {
          includeUntracked: parseBool(args.include_untracked, true),
          includeStaged: parseBool(args.include_staged, true),
          includeUnstaged: parseBool(args.include_unstaged, true),
          globs: Array.isArray(args.globs) ? args.globs.filter((item): item is string => typeof item === "string") : undefined,
          excludeGlobs: Array.isArray(args.exclude_globs) ? args.exclude_globs.filter((item): item is string => typeof item === "string") : undefined,
          maxFiles: limitInt(args.max_files, 12, 1, 50),
          maxBytes: Math.min(limitInt(args.max_bytes, config.maxReadBytes, 1_000, config.maxReadBytes), byteBudgetFromArgs(args, config.maxReadBytes)),
          includeLockfiles: parseBool(args.include_lockfiles, false),
          includeGenerated: parseBool(args.include_generated, false),
          signal
        })
      );
      const text = `# Read Changed Files\n\nChanged files: ${result.changedFiles.length}\nSkipped: ${result.skipped.length}\nTruncated: ${result.truncated}\n\n${result.text}`;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, status, ...result });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true unless summary_only=true."),
        summary_only: z.boolean().optional().describe("Return only changed files plus diff stats. Default: false."),
        diff_max_chars: z.number().int().min(1000).max(500000).optional().describe("Maximum diff characters to include when include_diff=true."),
        max_tokens_estimate: z.number().int().min(100).max(500000).optional().describe("Approximate token budget for returned text.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const scopedPath = typeof strFromArgs(args, "path") === "string" ? strFromArgs(args, "path") : undefined;
      const status = await gitStatus(config, workspace, guard, scopedPath, REVIEW_GIT_STATUS_OPTIONS);
      const summaryOnly = parseBool(args.summary_only, false);
      const includeDiff = summaryOnly ? false : parseBool(args.include_diff, true);
      const diffCharBudget = Math.min(limitInt(args.diff_max_chars, config.maxOutputBytes, 1_000, config.maxOutputBytes), diffMaxCharsFromTokens(typeof args.max_tokens_estimate === "number" ? args.max_tokens_estimate : undefined, config.maxOutputBytes));
      const rawDiff = includeDiff ? normalizeGitOutput(await gitDiff(config, guard, workspace, scopedPath, parseBool(args.staged, false))).slice(0, diffCharBudget) : "";
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const untrackedSummary = statusError
        ? undefined
        : summarizeUntrackedFiles(await expandUntrackedDirectoryEntries(guard, workspace, parseGitStatusEntries(status)));
      const rawStats = diffStats(diff);
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : untrackedSummary?.count
            ? "- No tracked changes."
            : "- No changed files.";
      const untrackedText = untrackedSummary?.count ? `\n\n## Untracked\n\n${untrackedSummary.text}` : "";
      const summaryBody = [
        "# Show Changes",
        "",
        `Workspace: ${workspace.root}`,
        "",
        "## Changed",
        "",
        changedText,
        untrackedText,
        "",
        "## Diff stats",
        "",
        `+${rawStats.additions} -${rawStats.deletions}`
      ].join("\n");
      const shapedSummary = await shapeForTool(config, workspace, "show_changes", "show_changes", summaryBody, {
        maxVisibleBytes: Math.min(diffCharBudget, config.maxOutputBytes)
      });
      const shapedDiff = diff
        ? await shapeForTool(config, workspace, "show_changes", "git_diff", diff, { maxVisibleBytes: diffCharBudget })
        : undefined;
      const visibleDiff = shapedDiff?.text ?? diff;
      const diffText = includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : visibleDiff
          ? diffBlock(visibleDiff)
          : "\n\nNo diff output."
        : summaryOnly
          ? "\n\nDiff omitted because summary_only=true."
          : "\n\nDiff omitted by request.";
      const retrievalHints = [shapedSummary.outputMeta.retrievalHint, shapedDiff?.outputMeta.retrievalHint].filter(Boolean);
      const retrievalHint = retrievalHints.length ? `\nRetrieval: ${retrievalHints.join(" | ")}` : "";
      const text = `${shapedSummary.text}${retrievalHint}${diffText}`;
      const rawBytes = (shapedSummary.rawBytes ?? 0) + (shapedDiff?.rawBytes ?? 0);
      const visibleBytes = Buffer.byteLength(text, "utf8");
      const savedBytes = (shapedSummary.savedBytes ?? 0) + (shapedDiff?.savedBytes ?? 0);
      const compacted = Boolean(shapedSummary.outputMeta.compacted || shapedDiff?.outputMeta.compacted);
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: strFromArgs(args, "path") ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: changedFiles,
        untracked_summary: untrackedSummary,
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        summary_only: summaryOnly,
        diff_max_chars: diffCharBudget,
        additions: rawStats.additions,
        deletions: rawStats.deletions,
        changed: !statusError && (changedFiles.length > 0 || rawStats.changed || Boolean(untrackedSummary?.count)),
        diff: visibleDiff,
        rawBytes: rawBytes || undefined,
        visibleBytes,
        savedBytes: savedBytes || undefined,
        compacted,
        output_meta: {
          ...shapedSummary.outputMeta,
          diff_output_meta: shapedDiff?.outputMeta
        }
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "review_minimality",
    {
      title: "Review Minimality",
      description:
        "Heuristic minimality review for current workspace changes. Findings are prompts for human/agent review, not mandatory removals.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional scope path for git status."),
        include_untracked: z.boolean().optional().describe("Include untracked files. Default: true."),
        max_findings: z.number().int().min(1).max(20).optional().describe("Maximum findings. Default: 8.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reviewing change minimality...",
        "openai/toolInvocation/invoked": "Minimality review ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const result = await reviewMinimality(config, guard, workspace, {
        path: strFromArgs(args, "path"),
        includeUntracked: parseBool(args.include_untracked, true),
        maxFindings: limitInt(args.max_findings, 8, 1, 20)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, findings: result.findings });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, { workspace_id: workspace.id, root: workspace.root, files: context.files });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: strFromArgs(args, "target_path"),
        includeAiBridge: parseBool(args.include_ai_bridge, true),
        includeGit: parseBool(args.include_git, false),
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: limitInt(args.max_agent_bytes, config.maxReadBytes, 1, config.maxReadBytes)
      });
      return textResult(context.text, {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const result = await exportProContext(config, guard, workspace, {
        title: strFromArgs(args, "title"),
        selectedPaths: Array.isArray(args.selected_paths)
          ? args.selected_paths.filter((item): item is string => typeof item === "string")
          : undefined,
        extraGlobs: Array.isArray(args.extra_globs)
        ? args.extra_globs.filter((item): item is string => typeof item === "string")
        : undefined,
        includeDiff: parseBool(args.include_diff, false),
        includeAiBridge: parseBool(args.include_ai_bridge, true),
        maxDepth: limitInt(args.max_depth, 3, 1, 12),
        maxFiles: limitInt(args.max_files, 40, 1, 500),
        maxFileBytes: limitInt(args.max_file_bytes, config.maxReadBytes, 1, config.maxReadBytes),
        maxTotalBytes: limitInt(args.max_total_bytes, 500_000, 1_000, 5_000_000)
      });
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with least pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: strFromArgs(args, "agent") ?? "custom",
        agentName: strFromArgs(args, "agent_name"),
        model: strFromArgs(args, "model"),
        title: cleanOneLine(strFromArgs(args, "title"), "Agent implementation plan"),
        plan: String(strFromArgs(args, "plan") ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_agent"
      });
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    authMode,
    registry,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false."),
        lease_token: z.string().optional().describe("Lease token returned by acquire_workspace_lock. Use this when the client session may reconnect between tool calls.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(workspaceIdFromArgs(args));
      const sessionId = sessionIdFrom(options);
      const leaseToken = leaseTokenFromArgs(args);
      assertMutationLock(config, workspace.id, sessionId, leaseToken);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "codex",
        title: cleanOneLine(strFromArgs(args, "title"), "Codex implementation plan"),
        plan: String(strFromArgs(args, "plan") ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_codex"
      });
      renewMutationLock(config, workspace.id, sessionId, leaseToken);
      invalidateDerivedWorkspaceState(workspace.id);
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  return { server, registry };
}
