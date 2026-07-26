import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Workspace } from "./guard.js";
import { agentDefinitionsFromGroundcrewConfig, defaultAgentFromGroundcrewConfig, loadGroundcrewRuntime } from "./agentGroundcrewAdapter.js";
import { executablesForLocalAgent, loadEffectiveLocalAgentConfig, type LocalAgentProfile } from "./agentConfig.js";
import { detectTerminalBackends } from "./agentTerminalBackend.js";
import { describeTerminalExec, resolveTerminalExec } from "./agentTerminalExec.js";
import type { TerminalBackendDetection } from "./agentTerminalTypes.js";

const execFileAsync = promisify(execFile);

export interface AgentDoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface AgentDoctorProfileSummary {
  name: string;
  provider?: string;
  source?: string;
  enabled: boolean;
  groundcrew_profile?: string;
  command?: string | string[];
  prompt_via?: string;
  write_policy?: string;
  required_executables: string[];
  smoke_args?: string[];
}

export interface AgentDoctorResult {
  ok: boolean;
  checks: AgentDoctorCheck[];
  warnings: string[];
  errors: string[];
  local_config?: {
    found: boolean;
    path?: string;
    local_agents: string[];
    builtin_agents: string[];
    effective_agents: string[];
  };
  profiles: AgentDoctorProfileSummary[];
  terminal_backends: TerminalBackendDetection[];
  session_manager?: {
    kind: string;
    executable?: string;
    group?: string;
    worktree?: boolean;
  };
  groundcrew?: {
    available: boolean;
    default_agent?: string;
    agents: string[];
  };
}

function textBlock(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function commandValue(profile: LocalAgentProfile): string | string[] | undefined {
  return profile.command ?? profile.cmd;
}

async function executableExists(command: string, workspace?: Workspace): Promise<AgentDoctorCheck> {
  const isWin = process.platform === "win32";
  const exe = isWin ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(exe, [command], { timeout: 5_000, maxBuffer: 200_000 });
    return { name: `command:${command}`, ok: true, detail: stdout.trim().split(/\r?\n/)[0] ?? command };
  } catch (error) {
    if (isWin && (command === "tmux" || command === "zellij")) {
      const resolution = await resolveTerminalExec(command, {
        wslDistro: workspace ? (await loadEffectiveLocalAgentConfig(workspace)).config.terminal?.wslDistro : undefined
      });
      if (resolution) {
        const via = describeTerminalExec(resolution);
        return { name: `command:${command}`, ok: true, detail: via ? `${command} via ${via}` : command };
      }
    }
    return { name: `command:${command}`, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function executableSmoke(command: string, args: string[] | undefined): Promise<AgentDoctorCheck | undefined> {
  if (!args?.length) return undefined;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 10_000, maxBuffer: 300_000 });
    const detail = (stdout || stderr).trim().split(/\r?\n/)[0] ?? `${command} ${args.join(" ")}`;
    return { name: `smoke:${command}`, ok: true, detail };
  } catch (error) {
    return { name: `smoke:${command}`, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function groundcrewCheck(): Promise<Pick<AgentDoctorResult, "groundcrew" | "checks" | "warnings" | "errors">> {
  const checks: AgentDoctorCheck[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const runtime = await loadGroundcrewRuntime();
    checks.push({ name: "groundcrew:import", ok: true });
    try {
      const config = await runtime.loadConfig();
      const definitions = agentDefinitionsFromGroundcrewConfig(config);
      const defaultAgent = defaultAgentFromGroundcrewConfig(config);
      const agents = Object.keys(definitions);
      checks.push({ name: "groundcrew:config", ok: true, detail: `${agents.length} agents` });
      if (!defaultAgent) warnings.push("Groundcrew config has no agents.default.");
      if (!agents.length) warnings.push("Groundcrew config has no agents.definitions entries.");
      return {
        checks,
        warnings,
        errors,
        groundcrew: {
          available: true,
          default_agent: defaultAgent,
          agents
        }
      };
    } catch (error) {
      checks.push({ name: "groundcrew:config", ok: false, detail: error instanceof Error ? error.message : String(error) });
      errors.push("Groundcrew is importable but config loading failed.");
      return { checks, warnings, errors, groundcrew: { available: true, agents: [] } };
    }
  } catch (error) {
    checks.push({ name: "groundcrew:import", ok: false, detail: error instanceof Error ? error.message : String(error) });
    errors.push("Groundcrew is not importable from the Least runtime.");
    return { checks, warnings, errors, groundcrew: { available: false, agents: [] } };
  }
}

function profileSummaries(agents: Record<string, LocalAgentProfile> | undefined): AgentDoctorProfileSummary[] {
  return Object.entries(agents ?? {}).map(([name, profile]) => ({
    name,
    provider: profile.provider,
    source: profile.source,
    enabled: profile.enabled !== false,
    groundcrew_profile: profile.groundcrewProfile,
    command: commandValue(profile),
    prompt_via: profile.promptVia,
    write_policy: profile.writePolicy,
    required_executables: executablesForLocalAgent(profile),
    smoke_args: profile.smokeArgs
  }));
}

function localAgentExecutables(agents: Record<string, LocalAgentProfile> | undefined): string[] {
  if (!agents) return [];
  const commands = new Set<string>();
  for (const profile of Object.values(agents)) {
    if (profile.enabled === false) continue;
    for (const command of executablesForLocalAgent(profile)) commands.add(command);
  }
  return [...commands];
}

function enabledProfileNames(agents: Record<string, LocalAgentProfile> | undefined): string[] {
  return Object.entries(agents ?? {})
    .filter(([, profile]) => profile.enabled !== false)
    .map(([name]) => name);
}

function missingGroundcrewProfiles(effectiveProfiles: AgentDoctorProfileSummary[], groundcrewAgents: string[]): string[] {
  const available = new Set(groundcrewAgents);
  return effectiveProfiles
    .filter((profile) => profile.enabled && profile.groundcrew_profile && !available.has(profile.groundcrew_profile))
    .map((profile) => `${profile.name} -> ${profile.groundcrew_profile}`);
}

export async function runAgentDoctor(workspace: Workspace): Promise<{ text: string; structured: AgentDoctorResult }> {
  const checks: AgentDoctorCheck[] = [
    { name: "node:version", ok: true, detail: process.version },
    { name: "platform", ok: true, detail: `${process.platform}/${process.arch}` }
  ];
  const warnings: string[] = [];
  const errors: string[] = [];

  const local = await loadEffectiveLocalAgentConfig(workspace);
  warnings.push(...local.warnings);
  errors.push(...local.errors);
  checks.push({ name: "local-config", ok: !local.found || local.errors.length === 0, detail: local.found ? local.path : "not found; using built-in profiles" });

  const groundcrew = await groundcrewCheck();
  checks.push(...groundcrew.checks);
  warnings.push(...groundcrew.warnings);
  errors.push(...groundcrew.errors);

  const profiles = profileSummaries(local.config.agents);
  const agentDeckEnabled = local.config.sessionManager?.kind === "agent-deck";
  const missingProfiles = agentDeckEnabled ? [] : missingGroundcrewProfiles(profiles, groundcrew.groundcrew?.agents ?? []);
  for (const missing of missingProfiles) {
    warnings.push(`Enabled local profile is not present in Groundcrew config: ${missing}.`);
  }

  const terminalBackends = await detectTerminalBackends(workspace);
  const baseCommands = ["git", "tmux"];
  if (local.config.terminal?.preferredBackend === "zellij") baseCommands.push("zellij");
  if (agentDeckEnabled) baseCommands.push(local.config.sessionManager?.executable?.trim() || "agent-deck");
  if (process.platform === "win32") baseCommands.push("wsl");
  const configuredCommands = localAgentExecutables(local.config.agents);
  const executableChecks = new Map<string, AgentDoctorCheck>();
  for (const command of [...new Set([...baseCommands, ...configuredCommands])]) {
    const check = await executableExists(command, workspace);
    checks.push(check);
    executableChecks.set(command, check);
  }

  for (const profile of Object.values(local.config.agents ?? {})) {
    if (profile.enabled === false) continue;
    const executable = executablesForLocalAgent(profile)[0];
    if (!executable) continue;
    if (executableChecks.get(executable)?.ok !== true) continue;
    const smoke = await executableSmoke(executable, profile.smokeArgs);
    if (smoke) checks.push(smoke);
  }

  const failedRequired = checks.filter((check) =>
    !check.ok && (check.name === "command:git" || check.name === "groundcrew:import" || check.name === "groundcrew:config")
  );
  const enabledNames = enabledProfileNames(local.config.agents);
  const result: AgentDoctorResult = {
    ok: failedRequired.length === 0 && errors.length === 0,
    checks,
    warnings: [...new Set(warnings)],
    errors,
    local_config: {
      found: local.found,
      path: local.path,
      local_agents: local.local_agents,
      builtin_agents: local.builtin_agents,
      effective_agents: Object.keys(local.config.agents ?? {})
    },
    profiles,
    terminal_backends: terminalBackends,
    session_manager: local.config.sessionManager?.kind
      ? {
          kind: local.config.sessionManager.kind,
          executable: local.config.sessionManager.executable,
          group: local.config.sessionManager.group,
          worktree: local.config.sessionManager.worktree
        }
      : undefined,
    groundcrew: groundcrew.groundcrew
  };
  const text = [
    "# Agent Doctor",
    "",
    `OK: ${result.ok}`,
    `Local config: ${local.found ? local.path : "not found; using built-in profiles"}`,
    `Groundcrew: ${result.groundcrew?.available ? "available" : "not available"}`,
    `Session manager: ${result.session_manager?.kind ?? "groundcrew"}`,
    `Enabled local profiles: ${enabledNames.join(", ") || "(none)"}`,
    "",
    "## Terminal Backends",
    "",
    terminalBackends.map((backend) => `- ${backend.available ? "OK" : "FAIL"} ${backend.backend}${backend.version ? ` - ${backend.version}` : ""}${backend.detail ? ` - ${backend.detail}` : ""}`).join("\n"),
    "",
    "## Profiles",
    "",
    profiles.map((profile) => `- ${profile.enabled ? "enabled" : "disabled"} ${profile.name} (${profile.provider ?? "custom"}, ${profile.source ?? "local"}) -> ${profile.required_executables.join(", ") || "no executable"}`).join("\n"),
    "",
    "## Checks",
    "",
    checks.map((check) => `- ${check.ok ? "OK" : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`).join("\n"),
    warnings.length ? `\n## Warnings\n\n${[...new Set(warnings)].map((warning) => `- ${warning}`).join("\n")}` : "",
    errors.length ? `\n## Errors\n\n${errors.map((error) => `- ${error}`).join("\n")}` : "",
    "",
    textBlock("Doctor", result)
  ].filter(Boolean).join("\n");
  return { text, structured: result };
}
