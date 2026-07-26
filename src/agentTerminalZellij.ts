import type { AgentJobRecord, AgentTerminalMetadata } from "./agentTypes.js";
import type { AgentTerminalSession, TerminalBackendDetection, TerminalTailResult } from "./agentTerminalTypes.js";
import {
  describeTerminalExec,
  execTerminalFile,
  formatTerminalCliCommand,
  getTerminalExec,
  type TerminalExecOptions,
  type TerminalExecResolution
} from "./agentTerminalExec.js";

interface ZellijPane {
  id?: string;
  title?: string;
  command?: string;
  cwd?: string;
  tabId?: number;
  tabName?: string;
  exited?: boolean;
  exitStatus?: number | null;
  raw: Record<string, unknown>;
}

let execOptions: TerminalExecOptions = {};

export function configureZellijTerminalExec(options: TerminalExecOptions): void {
  execOptions = options;
}

function clampLines(value: unknown): number {
  const n = Number(value ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(20, Math.min(2000, Math.floor(n)));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asPaneId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\\/g, "/").toLowerCase();
}

function parseZellijPane(value: unknown): ZellijPane | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const tab = asRecord(record.tab) ?? asRecord(record.tab_info);
  const rawExit = record.exit_status ?? record.exitStatus;
  return {
    id: asPaneId(record.id ?? record.pane_id ?? record.paneId ?? record.terminal_id),
    title: asString(record.title ?? record.name ?? record.pane_title),
    command: asString(record.command ?? record.command_line ?? record.running_command ?? record.terminal_command ?? record.pane_command),
    cwd: asString(record.cwd ?? record.current_dir ?? record.current_working_directory ?? record.pane_cwd),
    tabId: asNumber(record.tab_id ?? record.tabId ?? tab?.id),
    tabName: asString(record.tab_name ?? record.tabName ?? tab?.name),
    exited: asBoolean(record.exited ?? record.is_exited),
    exitStatus: rawExit === null ? null : asNumber(rawExit),
    raw: record
  };
}

function flattenPaneJson(value: unknown): ZellijPane[] {
  if (Array.isArray(value)) return value.map(parseZellijPane).filter((pane): pane is ZellijPane => Boolean(pane));
  const record = asRecord(value);
  if (!record) return [];
  const direct = record.panes ?? record.items ?? record.terminals;
  if (Array.isArray(direct)) return flattenPaneJson(direct);
  const nested: ZellijPane[] = [];
  for (const item of Object.values(record)) {
    if (Array.isArray(item)) nested.push(...flattenPaneJson(item));
  }
  return nested;
}

async function zellijResolution(): Promise<TerminalExecResolution | undefined> {
  return await getTerminalExec("zellij", execOptions);
}

async function zellij(args: string[], timeout = 7_000): Promise<string> {
  const resolution = await zellijResolution();
  if (!resolution) throw new Error("zellij is not available");
  return await execTerminalFile(resolution, args, { timeout });
}

export async function detectZellijBackend(): Promise<TerminalBackendDetection> {
  try {
    const resolution = await zellijResolution();
    if (!resolution) {
      return {
        backend: "zellij",
        available: false,
        detail: "zellij was not found on PATH (native or WSL)",
        warnings: []
      };
    }
    const stdout = await zellij(["--version"], 5_000);
    const via = describeTerminalExec(resolution);
    return {
      backend: "zellij",
      available: true,
      version: stdout.trim(),
      detail: via ? `via ${via}` : undefined,
      warnings: [],
      capabilities: {
        attach: true,
        watch: true,
        listSessions: true,
        listPanesJson: true,
        dumpScreen: true,
        subscribe: true
      }
    };
  } catch (error) {
    return {
      backend: "zellij",
      available: false,
      detail: error instanceof Error ? error.message : String(error),
      warnings: []
    };
  }
}

export async function listZellijSessions(): Promise<string[]> {
  const stdout = await zellij(["list-sessions"], 7_000);
  return stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

export async function listZellijPanes(sessionName: string): Promise<ZellijPane[]> {
  const stdout = await zellij(["--session", sessionName, "action", "list-panes", "--json"], 7_000);
  try {
    return flattenPaneJson(JSON.parse(stdout));
  } catch {
    return [];
  }
}

function zellijSessionCandidates(job: AgentJobRecord): string[] {
  const sessionName = job.terminal?.sessionName;
  const workspaceName = job.groundcrew?.workspaceName;
  const candidates = [
    sessionName,
    workspaceName,
    job.taskId,
    `groundcrew:${job.taskId}`,
    `least-agent-${job.jobId}`,
    `least-agent-${job.taskId}`
  ];
  return [...new Set(candidates.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function scorePane(job: AgentJobRecord, pane: ZellijPane, sessionName: string): number {
  const worktree = normalizePath(job.groundcrew?.worktreeDir);
  const cwd = normalizePath(pane.cwd);
  const haystack = [sessionName, pane.title, pane.command, pane.cwd].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  if (pane.tabName === job.groundcrew?.workspaceName) score += 120;
  if (pane.tabName === job.taskId) score += 100;
  if (job.terminal?.paneId && pane.id === job.terminal.paneId) score += 100;
  if (worktree && cwd && cwd === worktree) score += 50;
  if (worktree && cwd && (cwd.startsWith(worktree) || worktree.startsWith(cwd))) score += 25;
  if (haystack.includes(job.taskId.toLowerCase())) score += 20;
  if (haystack.includes(job.jobId.toLowerCase())) score += 20;
  if (haystack.includes(job.agent.toLowerCase())) score += 10;
  return score;
}

async function findBestPane(job: AgentJobRecord): Promise<{ sessionName: string; pane: ZellijPane; attempted: string[] } | undefined> {
  const candidates = new Set(zellijSessionCandidates(job));
  try {
    for (const session of await listZellijSessions()) candidates.add(session);
  } catch {
    // Listing sessions is best effort. Candidate names from the job are still useful.
  }

  let best: { sessionName: string; pane: ZellijPane; score: number; attempted: string[] } | undefined;
  const attempted: string[] = [];
  for (const sessionName of candidates) {
    attempted.push(sessionName);
    let panes: ZellijPane[];
    try {
      panes = await listZellijPanes(sessionName);
    } catch {
      continue;
    }
    for (const pane of panes) {
      const score = scorePane(job, pane, sessionName);
      if (!best || score > best.score) best = { sessionName, pane, score, attempted };
    }
  }

  if (!best || !best.pane.id || best.score <= 0) return undefined;
  return { sessionName: best.sessionName, pane: best.pane, attempted };
}

export function zellijAttachCommand(sessionName: string, resolution?: TerminalExecResolution): string {
  return formatTerminalCliCommand(resolution, `zellij attach ${sessionName}`);
}

export function zellijWatchCommand(sessionName: string, resolution?: TerminalExecResolution): string {
  return formatTerminalCliCommand(resolution, `zellij watch ${sessionName}`);
}

export function zellijTailCommand(sessionName: string, paneId: string, resolution?: TerminalExecResolution): string {
  return formatTerminalCliCommand(
    resolution,
    `zellij --session ${sessionName} action dump-screen --pane-id ${paneId} --full`
  );
}

export async function inferZellijMetadata(job: AgentJobRecord): Promise<AgentTerminalMetadata | undefined> {
  const resolution = await zellijResolution();
  const match = await findBestPane(job);
  if (!match?.pane.id) return undefined;
  return {
    backend: "zellij",
    sessionName: match.sessionName,
    paneId: match.pane.id,
    tabId: match.pane.tabId,
    tabName: match.pane.tabName,
    paneTitle: match.pane.title,
    paneCommand: match.pane.command,
    paneCwd: match.pane.cwd,
    exited: match.pane.exited,
    exitStatus: match.pane.exitStatus,
    attachCommand: zellijAttachCommand(match.sessionName, resolution),
    watchCommand: zellijWatchCommand(match.sessionName, resolution),
    tailCommand: zellijTailCommand(match.sessionName, match.pane.id, resolution),
    inferred: true
  };
}

async function dumpZellijScreen(sessionName: string, paneId: string): Promise<string> {
  return await zellij(["--session", sessionName, "action", "dump-screen", "--pane-id", paneId, "--full"], 7_000);
}

export async function tailZellijJob(job: AgentJobRecord, linesInput?: number): Promise<TerminalTailResult> {
  const lines = clampLines(linesInput);
  const attempted = zellijSessionCandidates(job);
  const resolution = await zellijResolution();
  const sessionName = job.terminal?.backend === "zellij" ? job.terminal.sessionName : undefined;
  const paneId = job.terminal?.backend === "zellij" ? job.terminal.paneId : undefined;

  try {
    const metadata = sessionName && paneId ? job.terminal : await inferZellijMetadata(job);
    if (!metadata?.sessionName || !metadata.paneId) {
      return {
        job_id: job.jobId,
        task_id: job.taskId,
        source: "none",
        text: "",
        lines,
        truncated: false,
        attempted_targets: attempted,
        error: "No matching Zellij session/pane was found for this job."
      };
    }
    const raw = await dumpZellijScreen(metadata.sessionName, metadata.paneId);
    const all = raw.split(/\r?\n/);
    const text = all.length > lines ? all.slice(-lines).join("\n") : raw;
    return {
      job_id: job.jobId,
      task_id: job.taskId,
      source: "zellij",
      text,
      lines,
      truncated: all.length > lines,
      target: `${metadata.sessionName}:${metadata.paneId}`,
      session_name: metadata.sessionName,
      pane_id: metadata.paneId,
      attempted_targets: attempted,
      attach_hint: zellijAttachCommand(metadata.sessionName, resolution),
      watch_hint: zellijWatchCommand(metadata.sessionName, resolution),
      tail_hint: zellijTailCommand(metadata.sessionName, metadata.paneId, resolution)
    };
  } catch (error) {
    return {
      job_id: job.jobId,
      task_id: job.taskId,
      source: "none",
      text: "",
      lines,
      truncated: false,
      attempted_targets: attempted,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function listZellijTerminalSessions(): Promise<AgentTerminalSession[]> {
  const resolution = await zellijResolution();
  const sessions: AgentTerminalSession[] = [];
  for (const sessionName of await listZellijSessions()) {
    let panes: ZellijPane[] = [];
    try {
      panes = await listZellijPanes(sessionName);
    } catch {
      // Keep the session attachable even when pane introspection fails.
    }
    if (!panes.length) {
      sessions.push({
        backend: "zellij",
        sessionName,
        attachCommand: zellijAttachCommand(sessionName, resolution),
        watchCommand: zellijWatchCommand(sessionName, resolution),
        source: "discovered"
      });
      continue;
    }
    for (const pane of panes) {
      sessions.push({
        backend: "zellij",
        sessionName,
        paneId: pane.id,
        tabId: pane.tabId,
        tabName: pane.tabName,
        title: pane.title,
        command: pane.command,
        cwd: pane.cwd,
        exited: pane.exited,
        exitStatus: pane.exitStatus,
        attachCommand: zellijAttachCommand(sessionName, resolution),
        watchCommand: zellijWatchCommand(sessionName, resolution),
        tailCommand: pane.id ? zellijTailCommand(sessionName, pane.id, resolution) : undefined,
        source: "discovered"
      });
    }
  }
  return sessions;
}
