import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoadedSettings } from "./settings.js";
import { loadSettings } from "./settings.js";


export type BashMode = "off" | "safe" | "readonly" | "full";
export type WriteMode = "off" | "handoff" | "workspace";
export type ToolMode = "minimal" | "standard" | "full";
export type Toolset = "standard" | "explore" | "edit" | "review" | "handoff" | "full";
export type HttpProtocol = "mcp" | "openai";
export type ConcurrencyMode = "off" | "lease";
export type ShellBackend = "auto" | "cmd" | "powershell" | "bash" | "wsl";
export type OutputMode = "raw" | "compact" | "compressed";

export interface LeastConfig {
  defaultRoot: string;
  allowedRoots: string[];
  host: string;
  port: number;
  widgetDomain: string;
  authToken?: string;
  requireHttpToken: boolean;
  bashMode: BashMode;
  writeMode: WriteMode;
  toolMode: ToolMode;
  toolset: Toolset;
  inheritEnv: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxSearchResults: number;
  maxHttpSessions: number;
  httpSessionTtlMs: number;
  blockedGlobs: string[];
  httpProtocols: HttpProtocol[];
  grokOAuth: boolean;
  grokOAuthClientId: string;
  dualClient: boolean;
  contextDir: string;
  concurrencyMode: ConcurrencyMode;
  lockLeaseMs: number;
  shellBackend: ShellBackend;
  warmup: Array<"files" | "git" | "package" | "symbols">;
  outputMode: OutputMode;
  outputStore: boolean;
  outputStoreTtlMs: number;
  outputStoreMaxItemBytes: number;
  compactSearch: boolean;
  compactGitDiff: boolean;
  compactShell: boolean;
  projectMemory: boolean;
  /** Loaded settings from ~/.least/settings.json, .least/settings.json, .least/settings.local.json */
  settings: LoadedSettings | null;
  yoloMode: boolean;
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  dashboardOpen: boolean;
  dashboardToken?: string;
  dashboardMaxEvents: number;
  dashboardSampleMs: number;
  dashboardDbPath: string;
}

const DEFAULT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**",
  ".least",
  ".least/**",
  "**/.least/**"
];

function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eqIndex >= 0) {
      key = withoutPrefix.slice(0, eqIndex);
      value = withoutPrefix.slice(eqIndex + 1);
    } else {
      key = withoutPrefix;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === "allow-root") {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else if (prev) out[key] = [String(prev), String(value)];
      else out[key] = [String(value)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function expandHome(input: string): string {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function splitList(value: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitRoots(value: string | undefined): string[] {
  return splitList(value, path.delimiter);
}

function warmupFrom(value: string | undefined): Array<"files" | "git" | "package" | "symbols"> {
  const raw = splitList(value, ",").map((item) => item.toLowerCase());
  const allowed = new Set(["files", "git", "package", "symbols"]);
  return raw.filter((item): item is "files" | "git" | "package" | "symbols" => allowed.has(item));
}

function toRealDir(input: string): string {
  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bashModeFrom(value: string | undefined): BashMode {
  if (value === "off" || value === "safe" || value === "readonly" || value === "full") return value;
  return "safe";
}

function writeModeFrom(value: string | undefined): WriteMode {
  if (value === "off" || value === "handoff" || value === "workspace") return value;
  return "workspace";
}

function toolModeFrom(value: string | undefined): ToolMode {
  if (value === "minimal" || value === "standard" || value === "full") return value;
  return "standard";
}

function toolsetFrom(value: string | undefined): Toolset {
  if (value === "standard" || value === "explore" || value === "edit" || value === "review" || value === "handoff" || value === "full") {
    return value;
  }
  return "full";
}

function concurrencyModeFrom(value: string | undefined): ConcurrencyMode {
  if (value === "off" || value === "lease") return value;
  return "off";
}

function shellBackendFrom(value: string | undefined): ShellBackend {
  if (value === "auto" || value === "cmd" || value === "powershell" || value === "bash" || value === "wsl") return value;
  return "auto";
}

function httpProtocolsFrom(value: string | undefined, argvProtocols?: string): HttpProtocol[] {
  const raw = argvProtocols ?? value ?? "mcp,openai";
  const tokens = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return ["mcp", "openai"];
  const out = new Set<HttpProtocol>();
  for (const token of tokens) {
    if (token === "both") {
      out.add("mcp");
      out.add("openai");
      continue;
    }
    if (token === "mcp" || token === "openai") {
      out.add(token);
      continue;
    }
    throw new Error(`Invalid HTTP protocol token: ${token}. Use mcp, openai, or both.`);
  }
  return [...out];
}

function widgetDomainFrom(value: string | undefined): string {
  const raw = value?.trim() || "https://Zykairotis.github.io";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`LEAST_WIDGET_DOMAIN must be a valid origin URL, got: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("LEAST_WIDGET_DOMAIN must use https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("LEAST_WIDGET_DOMAIN must be an origin only, for example https://widgets.example.com.");
  }
  return parsed.origin;
}

function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function loadConfig(argv = process.argv.slice(2)): LeastConfig {
  const args = parseArgs(argv);

  const rootFromArgs = typeof args.root === "string" ? args.root : undefined;
  const root = rootFromArgs ?? process.env.LEAST_ROOT ?? process.cwd();
  const defaultRoot = toRealDir(root);

  const allowRootArgs = Array.isArray(args["allow-root"])
    ? args["allow-root"]
    : typeof args["allow-root"] === "string"
      ? [args["allow-root"]]
      : [];
  const envAllowedRoots = splitRoots(process.env.LEAST_ALLOWED_ROOTS);

  const allowHome = process.env.LEAST_ALLOW_HOME === "1" || args["allow-home"] === true;
  const requestedAllowed = [defaultRoot, ...allowRootArgs, ...envAllowedRoots, ...(allowHome ? [os.homedir()] : [])];
  const allowedRoots = [...new Set(requestedAllowed.map(toRealDir))];

  const portArg = typeof args.port === "string" ? args.port : undefined;
  const hostArg = typeof args.host === "string" ? args.host : undefined;
  const bashArg = typeof args.bash === "string" ? args.bash : undefined;
  const writeArg = typeof args.write === "string" ? args.write : undefined;
  const toolModeArg = typeof args["tool-mode"] === "string" ? args["tool-mode"] : undefined;
  const toolsetArg = typeof args.toolset === "string" ? args.toolset : undefined;
  const concurrencyArg = typeof args.concurrency === "string" ? args.concurrency : undefined;
  const lockLeaseMsArg = typeof args["lock-lease-ms"] === "string" ? args["lock-lease-ms"] : undefined;
  const shellBackendArg = typeof args["shell-backend"] === "string" ? args["shell-backend"] : undefined;
  const widgetDomainArg = typeof args["widget-domain"] === "string" ? args["widget-domain"] : undefined;
  const extraBlockedGlobs = splitList(process.env.LEAST_BLOCKED_GLOBS, ",");
  const host = hostArg ?? process.env.LEAST_HOST ?? process.env.HOST ?? "127.0.0.1";
  const authToken = process.env.LEAST_HTTP_TOKEN;
  const httpProtocolsArg = typeof args["http-protocols"] === "string" ? args["http-protocols"] : undefined;
  const grokOAuth = process.env.LEAST_GROK_OAUTH === "1" || args["grok-oauth"] === true;
  const dualClient = process.env.LEAST_DUAL_CLIENT === "1" || args["dual-client"] === true;
  const dashboardEnabled = args.dashboard === true || process.env.LEAST_DASHBOARD === "1";
  const dashboardHostArg = typeof args["dashboard-host"] === "string" ? args["dashboard-host"] : undefined;
  const dashboardPortArg = typeof args["dashboard-port"] === "string" ? args["dashboard-port"] : undefined;
  const dashboardOpen = args["dashboard-open"] === true || process.env.LEAST_DASHBOARD_OPEN === "1";
  const dashboardToken = typeof args["dashboard-token"] === "string"
    ? args["dashboard-token"]
    : process.env.LEAST_DASHBOARD_TOKEN
      ? process.env.LEAST_DASHBOARD_TOKEN
      : undefined;
  const dashboardDbPathArg = typeof args["dashboard-db-path"] === "string" ? args["dashboard-db-path"] : undefined;

  const grokOAuthClientIdArg = typeof args["grok-oauth-client-id"] === "string" ? args["grok-oauth-client-id"] : undefined;
  const allowNoToken = boolFrom(process.env.LEAST_ALLOW_NO_HTTP_TOKEN, false);
  const requireHttpToken =
    boolFrom(process.env.LEAST_REQUIRE_HTTP_TOKEN, false) ||
    boolFrom(process.env.LEAST_TUNNEL_MODE, false) ||
    (!isLoopbackHost(host) && !allowNoToken);
  const loadedSettings = loadSettings({ workspaceRoot: defaultRoot });
  const yoloMode = (args.yolo === true || args["dangerously-allow-all"] === true ||
    process.env.LEAST_YOLO === "1" || process.env.LEAST_DANGEROUSLY_ALLOW_ALL === "1");


  return {
    defaultRoot,
    allowedRoots,
    host,
    port: numberFrom(portArg ?? process.env.LEAST_PORT ?? process.env.PORT, 8787, 1, 65535),
    widgetDomain: widgetDomainFrom(widgetDomainArg ?? process.env.LEAST_WIDGET_DOMAIN),
    authToken,
    requireHttpToken,
    bashMode: bashModeFrom(bashArg ?? process.env.LEAST_BASH_MODE),
    writeMode: writeModeFrom(writeArg ?? process.env.LEAST_WRITE_MODE),
    toolMode: toolModeFrom(toolModeArg ?? process.env.LEAST_TOOL_MODE),
    toolset: toolsetFrom(toolsetArg ?? process.env.LEAST_TOOLSET),
    inheritEnv: process.env.LEAST_INHERIT_ENV === "1",
    maxReadBytes: numberFrom(process.env.LEAST_MAX_READ_BYTES, 180_000, 4_000, 2_000_000),
    maxWriteBytes: numberFrom(process.env.LEAST_MAX_WRITE_BYTES, 1_000_000, 1_000, 10_000_000),
    maxOutputBytes: numberFrom(process.env.LEAST_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000),
    maxSearchResults: numberFrom(process.env.LEAST_MAX_SEARCH_RESULTS, 200, 5, 2_000),
    maxHttpSessions: numberFrom(process.env.LEAST_MAX_HTTP_SESSIONS, 64, 1, 512),
    httpProtocols: httpProtocolsFrom(process.env.LEAST_HTTP_PROTOCOLS, httpProtocolsArg),
    grokOAuth,
    grokOAuthClientId: grokOAuthClientIdArg ?? process.env.LEAST_GROK_OAUTH_CLIENT_ID ?? "least-grok",
    dualClient,
    httpSessionTtlMs: numberFrom(process.env.LEAST_HTTP_SESSION_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000),
    blockedGlobs: [...DEFAULT_BLOCKED_GLOBS, ...extraBlockedGlobs],
    contextDir: process.env.LEAST_CONTEXT_DIR ?? ".ai-bridge",
    dashboardEnabled,
    dashboardHost: dashboardHostArg ?? process.env.LEAST_DASHBOARD_HOST ?? "127.0.0.1",
    dashboardPort: numberFrom(dashboardPortArg ?? process.env.LEAST_DASHBOARD_PORT, 8922, 1, 65535),
    dashboardOpen,
    dashboardToken,
    dashboardMaxEvents: numberFrom(process.env.LEAST_DASHBOARD_MAX_EVENTS, 5_000, 100, 100_000),
    dashboardSampleMs: numberFrom(process.env.LEAST_DASHBOARD_SAMPLE_MS, 1_000, 100, 60_000),
    dashboardDbPath: dashboardDbPathArg ?? process.env.LEAST_DASHBOARD_DB_PATH ?? path.join(defaultRoot, ".least", "dashboard.db"),
    concurrencyMode: concurrencyModeFrom(concurrencyArg ?? process.env.LEAST_CONCURRENCY_MODE),
    lockLeaseMs: numberFrom(lockLeaseMsArg ?? process.env.LEAST_LOCK_LEASE_MS, 120_000, 5_000, 3_600_000),
    shellBackend: shellBackendFrom(shellBackendArg ?? process.env.LEAST_SHELL_BACKEND),
    warmup: warmupFrom(process.env.LEAST_WARMUP),
    // raw: no compaction; compact: only per-kind enabled outputs; compressed: compact all eligible large outputs
    outputMode: (process.env.LEAST_OUTPUT_MODE === "raw" || process.env.LEAST_OUTPUT_MODE === "compact" || process.env.LEAST_OUTPUT_MODE === "compressed"
      ? process.env.LEAST_OUTPUT_MODE
      : "compact") as OutputMode,
    outputStore: boolFrom(process.env.LEAST_OUTPUT_STORE, true),
    outputStoreTtlMs: numberFrom(process.env.LEAST_OUTPUT_STORE_TTL_MS, 86_400_000, 60_000, 7 * 86_400_000),
    outputStoreMaxItemBytes: numberFrom(process.env.LEAST_OUTPUT_STORE_MAX_ITEM_BYTES, 5_242_880, 10_000, 20_000_000),
    compactSearch: boolFrom(process.env.LEAST_COMPACT_SEARCH, true),
    compactGitDiff: boolFrom(process.env.LEAST_COMPACT_GIT_DIFF, true),
    compactShell: boolFrom(process.env.LEAST_COMPACT_SHELL, true),
    projectMemory: boolFrom(process.env.LEAST_PROJECT_MEMORY, false),
    settings: loadedSettings,
    yoloMode,
  };
}
