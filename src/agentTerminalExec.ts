import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Workspace } from "./guard.js";
import { loadEffectiveLocalAgentConfig } from "./agentConfig.js";

const execFileAsync = promisify(execFile);

export interface TerminalExecResolution {
  command: "zellij" | "tmux";
  viaWsl: boolean;
  wslDistro?: string;
}

export interface TerminalExecOptions {
  wslDistro?: string;
  preferWslOnWindows?: boolean;
}

export interface TerminalBackendRuntime {
  platform: NodeJS.Platform;
  wslAvailable: boolean;
  zellij?: TerminalExecResolution;
  tmux?: TerminalExecResolution;
}

let wslAvailability: boolean | undefined;
const resolutionCache = new Map<string, TerminalExecResolution | undefined>();

export function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

function repoRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function mergePathEntries(entries: string[]): string {
  return [...new Set(entries.flatMap((value) => value.split(path.delimiter)).map((value) => value.trim()).filter(Boolean))]
    .join(path.delimiter);
}

function nativeWindowsZellijDir(): string | undefined {
  if (!isWindowsPlatform()) return undefined;
  const localAppData = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  if (!localAppData) return undefined;
  const installDir = path.join(localAppData, "Zellij");
  return fs.existsSync(path.join(installDir, "zellij.exe")) ? installDir : undefined;
}

function groundcrewShimDir(): string | undefined {
  const shimDir = path.join(repoRootDir(), "scripts", "groundcrew-bin");
  return fs.existsSync(shimDir) ? shimDir : undefined;
}

function refreshWindowsTerminalPath(options: { includeGroundcrewShims: boolean }): void {
  if (!isWindowsPlatform()) return;
  const parts = [process.env.PATH ?? "", process.env.Path ?? "", process.env.path ?? ""];
  const nativeZellij = nativeWindowsZellijDir();
  if (nativeZellij) parts.unshift(nativeZellij);
  if (options.includeGroundcrewShims) {
    const shimDir = groundcrewShimDir();
    if (shimDir) parts.push(shimDir);
  }
  process.env.PATH = mergePathEntries(parts);
}

/** Groundcrew's zellij tabs still need a POSIX `sh`, but native Windows zellij should win when available. */
export function refreshGroundcrewPathForLaunch(): void {
  refreshWindowsTerminalPath({ includeGroundcrewShims: true });
}

export function wslStatusAvailable(): boolean {
  if (!isWindowsPlatform()) return false;
  if (wslAvailability !== undefined) return wslAvailability;
  const result = spawnSync("wsl.exe", ["--status"], { encoding: "utf8", windowsHide: true });
  wslAvailability = result.status === 0 || result.status === 50;
  return wslAvailability;
}

export function resetTerminalExecCache(): void {
  resolutionCache.clear();
  wslAvailability = undefined;
}

function cacheKey(command: "zellij" | "tmux", options: TerminalExecOptions): string {
  return `${command}:${options.wslDistro ?? ""}:${options.preferWslOnWindows ?? "default"}`;
}

async function tryExecFile(command: string, args: string[], timeout = 5_000): Promise<string> {
  refreshWindowsTerminalPath({ includeGroundcrewShims: false });
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout,
    maxBuffer: 200_000,
    windowsHide: true
  });
  return (stdout || stderr).trim();
}

async function nativeCommandExists(command: string): Promise<boolean> {
  refreshWindowsTerminalPath({ includeGroundcrewShims: false });
  const probe = isWindowsPlatform() ? "where" : "which";
  try {
    await execFileAsync(probe, [command], { timeout: 5_000, maxBuffer: 200_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function listWslDistros(): Promise<string[]> {
  if (!wslStatusAvailable()) return [];
  try {
    const stdout = await tryExecFile("wsl.exe", ["-l", "-q"], 5_000);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function wslCommandExists(command: string, distro?: string): Promise<boolean> {
  if (!wslStatusAvailable()) return false;
  const args = distro
    ? ["-d", distro, "-e", "sh", "-lc", `command -v ${command}`]
    : ["-e", "sh", "-lc", `command -v ${command}`];
  try {
    const stdout = await tryExecFile("wsl.exe", args, 5_000);
    return stdout.length > 0;
  } catch {
    return false;
  }
}

export async function resolveTerminalExec(
  command: "zellij" | "tmux",
  options: TerminalExecOptions = {}
): Promise<TerminalExecResolution | undefined> {
  const key = cacheKey(command, options);
  if (resolutionCache.has(key)) return resolutionCache.get(key);

  const preferWsl = options.preferWslOnWindows === true;
  let resolved: TerminalExecResolution | undefined;

  if (!preferWsl || !isWindowsPlatform()) {
    if (await nativeCommandExists(command)) {
      resolved = { command, viaWsl: false };
    }
  }

  if (!resolved && isWindowsPlatform() && wslStatusAvailable()) {
    const distro = options.wslDistro?.trim();
    if (distro) {
      if (await wslCommandExists(command, distro)) {
        resolved = { command, viaWsl: true, wslDistro: distro };
      }
    } else if (await wslCommandExists(command)) {
      resolved = { command, viaWsl: true };
    } else {
      for (const candidate of await listWslDistros()) {
        if (await wslCommandExists(command, candidate)) {
          resolved = { command, viaWsl: true, wslDistro: candidate };
          break;
        }
      }
    }
  }

  if (!resolved && (await nativeCommandExists(command))) {
    resolved = { command, viaWsl: false };
  }

  resolutionCache.set(key, resolved);
  return resolved;
}

export async function terminalExecOptionsFromWorkspace(workspace?: Pick<Workspace, "root">): Promise<TerminalExecOptions> {
  if (!workspace) return {};
  const local = await loadEffectiveLocalAgentConfig(workspace);
  const terminal = local.config.terminal;
  const preferWslOnWindows = terminal?.runZellijInWsl === true;
  return {
    wslDistro: terminal?.wslDistro,
    preferWslOnWindows
  };
}

export async function getTerminalExec(
  command: "zellij" | "tmux",
  options: TerminalExecOptions = {}
): Promise<TerminalExecResolution | undefined> {
  return await resolveTerminalExec(command, options);
}

export async function execTerminalFile(
  resolution: TerminalExecResolution,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {}
): Promise<string> {
  const timeout = options.timeout ?? 7_000;
  const maxBuffer = options.maxBuffer ?? 4_000_000;
  if (resolution.viaWsl) {
    const wslArgs = resolution.wslDistro
      ? ["-d", resolution.wslDistro, resolution.command, ...args]
      : [resolution.command, ...args];
    const { stdout } = await execFileAsync("wsl.exe", wslArgs, { timeout, maxBuffer, windowsHide: true });
    return stdout;
  }
  const { stdout } = await execFileAsync(resolution.command, args, { timeout, maxBuffer, windowsHide: true });
  return stdout;
}

export function formatTerminalCliCommand(
  resolution: Pick<TerminalExecResolution, "viaWsl" | "wslDistro"> | undefined,
  cliCommand: string
): string {
  if (!resolution?.viaWsl) return cliCommand;
  const prefix = resolution.wslDistro ? `wsl -d ${resolution.wslDistro}` : "wsl";
  return `${prefix} ${cliCommand}`;
}

export function describeTerminalExec(resolution: TerminalExecResolution | undefined): string | undefined {
  if (!resolution) return undefined;
  if (!resolution.viaWsl) return "native";
  return resolution.wslDistro ? `wsl:${resolution.wslDistro}` : "wsl";
}

export async function probeTerminalBackendRuntime(workspace?: Pick<Workspace, "root">): Promise<TerminalBackendRuntime> {
  const options = await terminalExecOptionsFromWorkspace(workspace);
  const [zellij, tmux] = await Promise.all([
    resolveTerminalExec("zellij", options),
    resolveTerminalExec("tmux", options)
  ]);
  return {
    platform: process.platform,
    wslAvailable: wslStatusAvailable(),
    zellij,
    tmux
  };
}
