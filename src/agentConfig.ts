import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./guard.js";

export type LocalAgentProvider = "claude" | "codex" | "pi" | "grok" | "custom";
export type PromptTransport = "stdin" | "positional" | "prompt-file" | "native-background" | "interactive" | "unknown";
export type WritePolicy = "read-only" | "worktree" | "full-access-forbidden";

export interface LocalAgentProfile {
  provider?: LocalAgentProvider;
  groundcrewProfile?: string;
  cmd?: string;
  command?: string | string[];
  promptVia?: PromptTransport;
  defaultTimeoutMs?: number;
  idleTimeoutMs?: number;
  writePolicy?: WritePolicy;
  enabled?: boolean;
  notes?: string;
  source?: "builtin" | "local";
  requiredExecutables?: string[];
  smokeArgs?: string[];
  dangerousFlags?: string[];
}

export interface LocalAgentConfig {
  groundcrew?: {
    configPath?: string;
    workspaceKind?: "tmux" | "cmux" | "zellij" | "auto";
    runner?: "safehouse" | "srt" | "sdx" | "none" | "auto";
  };
  terminal?: {
    preferredBackend?: "zellij" | "tmux" | "logs" | "auto";
    zellijSessionPrefix?: string;
    logFallback?: boolean;
    wslDistro?: string;
    runZellijInWsl?: boolean;
  };
  agents?: Record<string, LocalAgentProfile>;
}

export interface LocalAgentConfigLoadResult {
  found: boolean;
  path?: string;
  config: LocalAgentConfig;
  warnings: string[];
  errors: string[];
  builtin_agents: string[];
  local_agents: string[];
}

const CANDIDATE_CONFIG_PATHS = [
  path.join(".least", "agents.local.jsonc"),
  "agents.local.jsonc"
];

export const BUILTIN_LOCAL_AGENT_PROFILES: Record<string, LocalAgentProfile> = {
  "claude-code": {
    provider: "claude",
    groundcrewProfile: "claude-code",
    cmd: "claude --permission-mode auto",
    promptVia: "positional",
    defaultTimeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    writePolicy: "worktree",
    enabled: true,
    source: "builtin",
    requiredExecutables: ["claude"],
    smokeArgs: ["--version"],
    dangerousFlags: ["--dangerously-skip-permissions"],
    notes: "Built-in known profile for Claude Code CLI."
  },
  "codex-host": {
    provider: "codex",
    groundcrewProfile: "codex-host",
    cmd: "codex exec --json --sandbox workspace-write",
    promptVia: "positional",
    defaultTimeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    writePolicy: "worktree",
    enabled: true,
    source: "builtin",
    requiredExecutables: ["codex"],
    smokeArgs: ["--version"],
    dangerousFlags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo"],
    notes: "Safer host Codex profile using workspace-write sandbox."
  },
  "codex-wsl": {
    provider: "codex",
    groundcrewProfile: "codex-wsl",
    command: ["scripts/least-codex-wsl.sh"],
    promptVia: "prompt-file",
    defaultTimeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    writePolicy: "worktree",
    enabled: true,
    source: "builtin",
    requiredExecutables: ["wsl"],
    smokeArgs: ["-l", "-v"],
    dangerousFlags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo"],
    notes: "Built-in wrapper profile for Codex inside WSL."
  },
  "grok-build": {
    provider: "grok",
    groundcrewProfile: "grok-build",
    command: ["scripts/least-grok-headless.cmd"],
    promptVia: "positional",
    defaultTimeoutMs: 7_200_000,
    idleTimeoutMs: 1_200_000,
    writePolicy: "worktree",
    enabled: true,
    source: "builtin",
    requiredExecutables: ["grok"],
    smokeArgs: ["--version"],
    dangerousFlags: ["--always-approve"],
    notes: "Built-in known profile for xAI Grok Build CLI headless mode."
  },
  "oh-my-pi": {
    provider: "pi",
    groundcrewProfile: "oh-my-pi",
    command: ["scripts/least-omp-headless.cmd"],
    promptVia: "positional",
    defaultTimeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    writePolicy: "worktree",
    enabled: true,
    source: "builtin",
    requiredExecutables: ["omp"],
    smokeArgs: ["--version"],
    dangerousFlags: ["--auto-approve", "--yolo", "--approval-mode yolo", "--approval-mode=yolo"],
    notes: "Built-in known profile for Oh My Pi; installed CLI binary is omp."
  }
};

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandValue(profile: LocalAgentProfile): string | string[] | undefined {
  return profile.command ?? profile.cmd;
}

function commandText(profile: LocalAgentProfile): string {
  const command = commandValue(profile);
  return Array.isArray(command) ? command.join(" ") : command ?? "";
}

function firstCommandToken(command: string | string[] | undefined): string | undefined {
  if (Array.isArray(command)) return command[0];
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^"([^"]+)"|'([^']+)'|(\S+)/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function hasUnsafeShellSyntax(command: string | string[] | undefined): boolean {
  if (Array.isArray(command)) return false;
  if (typeof command !== "string") return false;
  return /(?:\|\||&&|;|`|\$\(|>\s*|<\s*)/.test(command);
}

function hasDangerousFlag(profile: LocalAgentProfile): string | undefined {
  const haystack = commandText(profile);
  return profile.dangerousFlags?.find((flag) => haystack.includes(flag));
}

export function localAgentConfigCandidates(workspace: Pick<Workspace, "root">): string[] {
  return CANDIDATE_CONFIG_PATHS.map((candidate) => path.join(workspace.root, candidate));
}

function builtinAgents(): Record<string, LocalAgentProfile> {
  return Object.fromEntries(
    Object.entries(BUILTIN_LOCAL_AGENT_PROFILES).map(([name, profile]) => [name, { ...profile }])
  );
}

export function mergeLocalAgentConfig(localConfig: LocalAgentConfig): LocalAgentConfig {
  const localAgents = Object.fromEntries(
    Object.entries(localConfig.agents ?? {}).map(([name, profile]) => [name, { ...profile, source: "local" as const }])
  );
  return {
    ...localConfig,
    agents: {
      ...builtinAgents(),
      ...localAgents
    }
  };
}

function emptyLoadResult(found: boolean, config: LocalAgentConfig, extra?: Partial<LocalAgentConfigLoadResult>): LocalAgentConfigLoadResult {
  return {
    found,
    config,
    warnings: [],
    errors: [],
    builtin_agents: Object.keys(BUILTIN_LOCAL_AGENT_PROFILES),
    local_agents: [],
    ...extra
  };
}

export async function loadLocalAgentConfig(workspace: Pick<Workspace, "root">): Promise<LocalAgentConfigLoadResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const candidate of localAgentConfigCandidates(workspace)) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
      if (!isRecord(parsed)) {
        return emptyLoadResult(true, {}, { path: candidate, warnings, errors: ["Agent config root must be an object."] });
      }
      const config = parsed as LocalAgentConfig;
      const localAgents = Object.keys(config.agents ?? {});
      return emptyLoadResult(true, config, {
        path: candidate,
        local_agents: localAgents,
        warnings: [...warnings, ...validateLocalAgentConfig(config)],
        errors
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        return emptyLoadResult(true, {}, { path: candidate, warnings, errors: [`Invalid JSON/JSONC: ${error.message}`] });
      }
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return emptyLoadResult(false, {}, { errors });
}

export async function loadEffectiveLocalAgentConfig(workspace: Pick<Workspace, "root">): Promise<LocalAgentConfigLoadResult> {
  const loaded = await loadLocalAgentConfig(workspace);
  if (loaded.errors.length) return loaded;
  const config = mergeLocalAgentConfig(loaded.config);
  return {
    ...loaded,
    config,
    warnings: [...loaded.warnings, ...validateLocalAgentConfig(config)]
  };
}

export function validateLocalAgentConfig(config: LocalAgentConfig): string[] {
  const warnings: string[] = [];
  if (!config.agents || !isRecord(config.agents)) {
    return warnings;
  }
  for (const [name, profile] of Object.entries(config.agents)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      warnings.push(`Agent ${name} should use only letters, numbers, dots, underscores, and hyphens.`);
    }
    const command = commandValue(profile);
    const token = firstCommandToken(command);
    if (profile.enabled !== false && !token) {
      warnings.push(`Agent ${name} is enabled but has no cmd/command.`);
    }
    if (profile.enabled !== false && hasUnsafeShellSyntax(command)) {
      warnings.push(`Agent ${name} command contains shell control syntax. Prefer a wrapper script and an argv-style command array.`);
    }
    const dangerousFlag = hasDangerousFlag(profile);
    if (profile.enabled !== false && dangerousFlag) {
      warnings.push(`Agent ${name} command contains high-risk flag ${dangerousFlag}; do not use it as a default profile.`);
    }
  }
  return [...new Set(warnings)];
}

export function findLocalAgentProfile(config: LocalAgentConfig, name: string | undefined): LocalAgentProfile | undefined {
  if (!name || !config.agents) return undefined;
  return config.agents[name];
}

export function executableForLocalAgent(profile: LocalAgentProfile): string | undefined {
  return profile.requiredExecutables?.[0] ?? firstCommandToken(commandValue(profile));
}

export function executablesForLocalAgent(profile: LocalAgentProfile): string[] {
  const executable = executableForLocalAgent(profile);
  return [...new Set([...(profile.requiredExecutables ?? []), ...(executable ? [executable] : [])])];
}

export function validateLocalAgentLaunch(config: LocalAgentConfig, agentName: string | undefined): string[] {
  const warnings: string[] = [];
  const profile = findLocalAgentProfile(config, agentName);
  if (!profile) return warnings;
  if (profile.enabled === false) {
    warnings.push(`Local agent profile ${agentName} is disabled.`);
  }
  if (hasUnsafeShellSyntax(commandValue(profile))) {
    warnings.push(`Local agent profile ${agentName} command uses shell control syntax; prefer a wrapper script.`);
  }
  const dangerousFlag = hasDangerousFlag(profile);
  if (dangerousFlag) {
    warnings.push(`Local agent profile ${agentName} command includes high-risk flag ${dangerousFlag}.`);
  }
  return warnings;
}
