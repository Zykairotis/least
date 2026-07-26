import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "./guard.js";
import { loadEffectiveLocalAgentConfig } from "./agentConfig.js";

export const DIRECT_AGENT_TOOL_NAMES = [
  "agent_list",
  "agent_doctor",
  "agent_terminal_doctor",
  "agent_sessions",
  "agent_attach_hint",
  "agent_plan",
  "agent_start",
  "agent_status",
  "agent_watchdog",
  "agent_tail",
  "agent_result",
  "agent_cancel",
  "agent_resume",
  "agent_cleanup"
] as const;

export interface AgentDiscoverySummary {
  available: boolean;
  enabledProfiles: string[];
  configPath?: string;
  directTools: string[];
  cliBridgeDoctor: string;
  cliBridgeStartExample: string;
  note?: string;
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellBridge(root: string, inner: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '${psQuote(root)}'; ${inner}"`;
}

function shellBridge(root: string, inner: string): string {
  return `cd ${shQuote(root)} && ${inner}`;
}

function leastInstallRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function cliDoctorCommand(root: string): string {
  const leastRoot = leastInstallRoot();
  return process.platform === "win32"
    ? powershellBridge(leastRoot, `npm run agent:cli -- doctor --root '${psQuote(root)}'`)
    : shellBridge(leastRoot, `npm run agent:cli -- doctor --root ${shQuote(root)}`);
}

function cliStartExample(root: string, repository: string, agent: string): string {
  const leastRoot = leastInstallRoot();
  const prompt = "Inspect the repository and produce a short summary only. Do not modify files.";
  const inner = process.platform === "win32"
    ? `npm run agent:cli -- start --root '${psQuote(root)}' --agent ${agent} --repository ${repository} --prompt '${psQuote(prompt)}'`
    : `npm run agent:cli -- start --root ${shQuote(root)} --agent ${agent} --repository ${repository} --prompt ${shQuote(prompt)}`;
  return process.platform === "win32" ? powershellBridge(leastRoot, inner) : shellBridge(leastRoot, inner);
}

export async function discoverAgentSupport(workspace: Pick<Workspace, "root">): Promise<AgentDiscoverySummary> {
  const local = await loadEffectiveLocalAgentConfig(workspace);
  const enabledProfiles = Object.entries(local.config.agents ?? {})
    .filter(([, profile]) => profile.enabled !== false)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  const repository = path.basename(workspace.root) || "workspace";
  const preferredAgent = enabledProfiles.includes("oh-my-pi")
    ? "oh-my-pi"
    : enabledProfiles.includes("grok-build")
      ? "grok-build"
      : enabledProfiles[0] ?? "oh-my-pi";
  const available = enabledProfiles.length > 0;
  return {
    available,
    enabledProfiles,
    configPath: local.path,
    directTools: [...DIRECT_AGENT_TOOL_NAMES],
    cliBridgeDoctor: cliDoctorCommand(workspace.root),
    cliBridgeStartExample: cliStartExample(workspace.root, repository, preferredAgent),
    note: available
      ? "Prefer direct agent_* tools first. If they are not visible in the client manifest, use the Least agent CLI bridge below."
      : "No enabled local agent profiles were discovered."
  };
}
