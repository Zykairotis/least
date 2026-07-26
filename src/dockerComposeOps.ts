import path from "node:path";
import fs from "node:fs";
import type { LeastConfig, DockerComposeToolsConfig } from "./config.js";
import { LeastError, isSubpath, type Workspace } from "./guard.js";
import { runCappedProcess } from "./processRunner.js";
import { redactSensitiveText } from "./redact.js";

export interface ComposeDirInput {
  composeDir?: string;
  projectName?: string;
}

export interface ComposePsInput extends ComposeDirInput {
  format?: "table" | "json";
}

export interface ComposeLogsInput extends ComposeDirInput {
  service: string;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}

export interface ComposeHealthInput extends ComposeDirInput {
  includeLogsForUnhealthy?: boolean;
  logTail?: number;
}

export interface ComposeServiceStatus {
  name: string;
  service: string;
  state: string;
  health?: string;
  ports?: string[];
  status?: string;
}

export interface ComposePsResult {
  services: ComposeServiceStatus[];
  healthy: boolean;
  unhealthy: string[];
  exited: string[];
  raw?: string;
  format: "json" | "table";
}

export interface ComposeLogsResult {
  service: string;
  logs: string;
  truncated: boolean;
  exitCode: number | null;
}

export interface ComposeHealthResult {
  ok: boolean;
  services: ComposeServiceStatus[];
  unhealthy: string[];
  exited: string[];
  warnings: string[];
  logs?: Record<string, string>;
}

const SERVICE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

export function dockerComposeToolsFromConfig(config: LeastConfig): DockerComposeToolsConfig {
  return config.dockerComposeTools;
}

/** Resolve compose dir under workspace root or any allowed root. */
export function resolveComposeDir(
  config: LeastConfig,
  workspace: Workspace,
  composeDir?: string
): string {
  const settings = dockerComposeToolsFromConfig(config);
  const raw = (composeDir?.trim() || settings.defaultComposeDir || "docker").trim();
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace.root, raw);

  const allowedParents = [workspace.root, ...config.allowedRoots];
  const allowed = allowedParents.some((parent) => isSubpath(candidate, parent));
  if (!allowed) {
    throw new LeastError(
      `composeDir is outside workspace and allowed roots: ${candidate}\n` +
        `Allowed:\n${allowedParents.map((p) => `- ${p}`).join("\n")}`
    );
  }
  if (!fs.existsSync(candidate)) {
    throw new LeastError(`composeDir does not exist: ${candidate}`);
  }
  if (!fs.statSync(candidate).isDirectory()) {
    throw new LeastError(`composeDir is not a directory: ${candidate}`);
  }
  return candidate;
}

export function validateServiceName(service: string): string {
  const name = service.trim();
  if (!name || !SERVICE_NAME_RE.test(name)) {
    throw new LeastError(
      `Invalid Docker Compose service name: ${JSON.stringify(service)}. ` +
        "Use only letters, numbers, underscore, dot, and hyphen."
    );
  }
  return name;
}

export function clampLogTail(tail: number | undefined, settings: DockerComposeToolsConfig): number {
  const max = settings.maxLogTail;
  const value = tail ?? 200;
  if (!Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function projectArgs(projectName?: string): string[] {
  if (!projectName?.trim()) return [];
  const name = projectName.trim();
  if (!SERVICE_NAME_RE.test(name)) {
    throw new LeastError(`Invalid projectName: ${JSON.stringify(projectName)}`);
  }
  return ["-p", name];
}

async function runDocker(
  config: LeastConfig,
  cwd: string,
  args: string[],
  options: { allowNonZeroExit?: boolean; maxOutputBytes?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number | null; truncated: boolean }> {
  try {
    const result = await runCappedProcess({
      command: "docker",
      args,
      cwd,
      maxOutputBytes: options.maxOutputBytes ?? config.maxOutputBytes,
      allowNonZeroExit: options.allowNonZeroExit ?? true,
      backend: "docker-compose"
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      truncated: result.truncated
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LeastError(`docker compose failed: ${message}`);
  }
}

export async function composeServices(
  config: LeastConfig,
  workspace: Workspace,
  input: ComposeDirInput = {}
): Promise<{ services: string[]; composeDir: string }> {
  const settings = dockerComposeToolsFromConfig(config);
  if (!settings.enabled) {
    throw new LeastError("Docker Compose tools are disabled. Enable with --docker-compose-tools.");
  }
  const composeDir = resolveComposeDir(config, workspace, input.composeDir);
  const result = await runDocker(config, composeDir, ["compose", ...projectArgs(input.projectName), "config", "--services"]);
  if (result.code && result.code !== 0) {
    throw new LeastError(result.stderr.trim() || result.stdout.trim() || "docker compose config --services failed");
  }
  const services = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { services, composeDir };
}

export function parseJsonPsLines(stdout: string): ComposeServiceStatus[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const services: ComposeServiceStatus[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const name = String(row.Name ?? row.name ?? row.Service ?? row.service ?? "unknown");
      const service = String(row.Service ?? row.service ?? name);
      const state = String(row.State ?? row.state ?? row.Status ?? row.status ?? "unknown").toLowerCase();
      const healthRaw = row.Health ?? row.health;
      const health = healthRaw === undefined || healthRaw === "" ? undefined : String(healthRaw).toLowerCase();
      const portsRaw = row.Publishers ?? row.Ports ?? row.ports;
      let ports: string[] | undefined;
      if (Array.isArray(portsRaw)) {
        ports = portsRaw.map((p) => (typeof p === "string" ? p : JSON.stringify(p)));
      } else if (typeof portsRaw === "string" && portsRaw.trim()) {
        ports = [portsRaw];
      }
      services.push({
        name,
        service,
        state,
        health,
        ports,
        status: typeof row.Status === "string" ? row.Status : undefined
      });
    } catch {
      // skip non-json lines
    }
  }
  return services;
}

export function parseTablePs(stdout: string): ComposeServiceStatus[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length < 2) return [];
  // Skip header; best-effort: NAME / SERVICE / STATUS columns vary by docker version.
  const services: ComposeServiceStatus[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length < 2) continue;
    const name = parts[0];
    const service = parts[1] ?? parts[0];
    const status = parts[parts.length - 1] ?? "unknown";
    const state = /up|running/i.test(status) ? "running" : /exit/i.test(status) ? "exited" : status.toLowerCase();
    const healthMatch = status.match(/\((healthy|unhealthy|starting|health: starting)\)/i);
    services.push({
      name,
      service,
      state,
      health: healthMatch ? healthMatch[1].toLowerCase().replace("health: ", "") : undefined,
      status
    });
  }
  return services;
}

export function summarizeComposeServices(services: ComposeServiceStatus[]): {
  healthy: boolean;
  unhealthy: string[];
  exited: string[];
} {
  const unhealthy: string[] = [];
  const exited: string[] = [];
  for (const svc of services) {
    if (svc.state.includes("exit") || svc.state === "dead" || svc.state === "created") {
      if (svc.state.includes("exit") || svc.state === "dead") exited.push(svc.service || svc.name);
    }
    if (svc.health === "unhealthy") {
      unhealthy.push(svc.service || svc.name);
    }
  }
  const healthy = unhealthy.length === 0 && exited.length === 0;
  return { healthy, unhealthy, exited };
}

export async function composePs(
  config: LeastConfig,
  workspace: Workspace,
  input: ComposePsInput = {}
): Promise<ComposePsResult> {
  const settings = dockerComposeToolsFromConfig(config);
  if (!settings.enabled) {
    throw new LeastError("Docker Compose tools are disabled. Enable with --docker-compose-tools.");
  }
  const composeDir = resolveComposeDir(config, workspace, input.composeDir);
  const format = input.format ?? "json";
  const baseArgs = ["compose", ...projectArgs(input.projectName), "ps"];

  if (format === "json") {
    const jsonResult = await runDocker(config, composeDir, [...baseArgs, "--format", "json"]);
    if (!jsonResult.code || jsonResult.code === 0) {
      const services = parseJsonPsLines(jsonResult.stdout);
      if (services.length > 0 || !jsonResult.stdout.trim()) {
        const summary = summarizeComposeServices(services);
        return { services, ...summary, format: "json", raw: jsonResult.stdout };
      }
    }
    // fallback table
  }

  const tableResult = await runDocker(config, composeDir, baseArgs);
  if (tableResult.code && tableResult.code !== 0) {
    throw new LeastError(tableResult.stderr.trim() || tableResult.stdout.trim() || "docker compose ps failed");
  }
  const services = parseTablePs(tableResult.stdout);
  const summary = summarizeComposeServices(services);
  return { services, ...summary, format: "table", raw: tableResult.stdout };
}

export async function composeLogs(
  config: LeastConfig,
  workspace: Workspace,
  input: ComposeLogsInput
): Promise<ComposeLogsResult> {
  const settings = dockerComposeToolsFromConfig(config);
  if (!settings.enabled) {
    throw new LeastError("Docker Compose tools are disabled. Enable with --docker-compose-tools.");
  }
  const service = validateServiceName(input.service);
  const composeDir = resolveComposeDir(config, workspace, input.composeDir);
  const listed = await composeServices(config, workspace, input);
  if (!listed.services.includes(service)) {
    throw new LeastError(
      `Unknown compose service: ${service}. Available: ${listed.services.join(", ") || "(none)"}`
    );
  }
  const tail = clampLogTail(input.tail, settings);
  const args = ["compose", ...projectArgs(input.projectName), "logs", "--no-color", "--tail", String(tail)];
  if (input.timestamps) args.push("--timestamps");
  if (input.since?.trim()) {
    const since = input.since.trim();
    if (/[\r\n\0]/.test(since) || since.length > 64) {
      throw new LeastError("Invalid since value.");
    }
    args.push("--since", since);
  }
  args.push(service);

  const result = await runDocker(config, composeDir, args, { maxOutputBytes: Math.min(config.maxOutputBytes * 4, 2_000_000) });
  const logs = redactSensitiveText((result.stdout || result.stderr || "").trimEnd());
  return {
    service,
    logs,
    truncated: result.truncated,
    exitCode: result.code
  };
}

export async function composeHealth(
  config: LeastConfig,
  workspace: Workspace,
  input: ComposeHealthInput = {}
): Promise<ComposeHealthResult> {
  const ps = await composePs(config, workspace, { composeDir: input.composeDir, projectName: input.projectName, format: "json" });
  const warnings: string[] = [];
  for (const svc of ps.services) {
    if (!svc.health && /running|up/.test(svc.state)) {
      warnings.push(`${svc.service || svc.name} has no healthcheck`);
    }
  }

  let logs: Record<string, string> | undefined;
  if (input.includeLogsForUnhealthy) {
    const targets = [...new Set([...ps.unhealthy, ...ps.exited])];
    if (targets.length) {
      logs = {};
      for (const service of targets) {
        try {
          const entry = await composeLogs(config, workspace, {
            composeDir: input.composeDir,
            projectName: input.projectName,
            service,
            tail: input.logTail ?? 80
          });
          logs[service] = entry.logs;
        } catch (error) {
          logs[service] = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  return {
    ok: ps.healthy,
    services: ps.services,
    unhealthy: ps.unhealthy,
    exited: ps.exited,
    warnings,
    logs
  };
}

export function formatComposePsText(result: ComposePsResult): string {
  const lines = [
    "# Docker Compose PS",
    "",
    `Healthy: ${result.healthy}`,
    `Format: ${result.format}`,
    `Services: ${result.services.length}`,
    result.unhealthy.length ? `Unhealthy: ${result.unhealthy.join(", ")}` : "",
    result.exited.length ? `Exited: ${result.exited.join(", ")}` : "",
    "",
    "## services",
    ""
  ].filter(Boolean);
  for (const svc of result.services) {
    lines.push(
      `- ${svc.service || svc.name}: state=${svc.state}` +
        (svc.health ? ` health=${svc.health}` : "") +
        (svc.ports?.length ? ` ports=${svc.ports.join(",")}` : "")
    );
  }
  return lines.join("\n");
}

export function formatComposeHealthText(result: ComposeHealthResult): string {
  const lines = [
    "# Docker Compose Health",
    "",
    `OK: ${result.ok}`,
    result.unhealthy.length ? `Unhealthy: ${result.unhealthy.join(", ")}` : "Unhealthy: (none)",
    result.exited.length ? `Exited: ${result.exited.join(", ")}` : "Exited: (none)",
    result.warnings.length ? `Warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}` : "",
    "",
    "## services",
    ""
  ].filter((line) => line !== "");
  for (const svc of result.services) {
    lines.push(`- ${svc.service || svc.name}: ${svc.state}${svc.health ? ` (${svc.health})` : ""}`);
  }
  if (result.logs) {
    lines.push("", "## logs (unhealthy/exited)", "");
    for (const [service, logText] of Object.entries(result.logs)) {
      lines.push(`### ${service}`, "```text", logText || "(empty)", "```", "");
    }
  }
  return lines.join("\n");
}
