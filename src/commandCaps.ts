import { spawn } from "node:child_process";

type CapabilityState = boolean | undefined;

let rgAvailable: CapabilityState;
let gitAvailable: CapabilityState;
let pwshAvailable: CapabilityState;
let powershellAvailable: CapabilityState;

function capsLoggingEnabled(): boolean {
  return process.env.LEAST_LOG_TOOL_CALLS === "1" || process.env.LEAST_LOG_REQUESTS === "1";
}

function probeCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function isRipgrepAvailable(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable;
  rgAvailable = await probeCommand("rg", ["--version"]);
  if (capsLoggingEnabled()) {
    console.error(`[LeastCaps] ripgrep: ${rgAvailable ? "available" : "unavailable (node fallback for search)"}`);
  }
  return rgAvailable;
}

export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== undefined) return gitAvailable;
  gitAvailable = await probeCommand("git", ["--version"]);
  if (capsLoggingEnabled()) {
    console.error(`[LeastCaps] git: ${gitAvailable ? "available" : "unavailable"}`);
  }
  return gitAvailable;
}

async function isPwshAvailable(): Promise<boolean> {
  if (pwshAvailable !== undefined) return pwshAvailable;
  pwshAvailable = await probeCommand("pwsh", ["-NoLogo", "-NoProfile", "-Command", "exit 0"]);
  return pwshAvailable;
}

async function isWindowsPowerShellAvailable(): Promise<boolean> {
  if (powershellAvailable !== undefined) return powershellAvailable;
  powershellAvailable = await probeCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "exit 0"]);
  return powershellAvailable;
}

export async function resolvePowerShellCommand(): Promise<string> {
  if (await isPwshAvailable()) return "pwsh";
  if (await isWindowsPowerShellAvailable()) return "powershell.exe";
  return "powershell.exe";
}

export function warmCommandCapabilities(): void {
  void isRipgrepAvailable();
  void isGitAvailable();
  if (process.platform === "win32") {
    void resolvePowerShellCommand();
  }
}