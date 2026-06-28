import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentJobRecord } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import { persistAgentJobSnapshot } from "./dashboardStore.js";

const AGENT_RUNS_DIR = path.join(".ai-bridge", "agent-runs");

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfter(baseIso: string, ms: number): string {
  return new Date(new Date(baseIso).getTime() + ms).toISOString();
}

function slugPart(input: unknown, fallback: string): string {
  const normalized = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || fallback;
}

export function makeAgentTaskId(title: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `least-agent-${stamp}-${slugPart(title, "task")}`.slice(0, 96);
}

export function makeAgentJobId(taskId: string): string {
  const hash = createHash("sha256").update(`${taskId}:${randomUUID()}`).digest("hex").slice(0, 10);
  return `agent_${slugPart(taskId, "task")}_${hash}`.slice(0, 120);
}

export function makeAgentRequestHash(input: {
  agent: string;
  repository: string;
  title: string;
  prompt: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

export function agentRunsDir(workspace: Pick<Workspace, "root">): string {
  return path.join(workspace.root, AGENT_RUNS_DIR);
}

export function agentJobDir(workspace: Pick<Workspace, "root">, jobId: string): string {
  return path.join(agentRunsDir(workspace), slugPart(jobId, "job"));
}

export function agentJobPath(workspace: Pick<Workspace, "root">, jobId: string): string {
  return path.join(agentJobDir(workspace, jobId), "status.json");
}

export function agentPromptPath(workspace: Pick<Workspace, "root">, jobId: string): string {
  return path.join(agentJobDir(workspace, jobId), "prompt.md");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmpPath, filePath);
}

export async function createAgentJob(input: {
  workspace: Workspace;
  taskId: string;
  agent: string;
  repository: string;
  title: string;
  prompt: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  idempotencyKey?: string;
}): Promise<AgentJobRecord> {
  const jobId = makeAgentJobId(input.taskId);
  const promptFile = agentPromptPath(input.workspace, jobId);
  await fsp.mkdir(path.dirname(promptFile), { recursive: true });
  await fsp.writeFile(promptFile, input.prompt, { mode: 0o600 });
  const timestamp = nowIso();
  const record: AgentJobRecord = {
    jobId,
    taskId: input.taskId,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceId: input.workspace.id,
    workspaceRoot: input.workspace.root,
    agent: input.agent,
    repository: input.repository,
    title: input.title,
    promptFile,
    state: "accepted",
    idempotencyKey: input.idempotencyKey,
    requestHash: makeAgentRequestHash({
      agent: input.agent,
      repository: input.repository,
      title: input.title,
      prompt: input.prompt
    }),
    launch: {
      phase: "accepted",
      acceptedAt: timestamp,
      lastUpdateAt: timestamp
    },
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
    watchdog: {
      deadlineAt: isoAfter(timestamp, input.timeoutMs),
      idleDeadlineAt: isoAfter(timestamp, input.idleTimeoutMs),
      lastActivityAt: timestamp
    }
  };
  await writeAgentJob(input.workspace, record);
  return record;
}

export async function writeAgentJob(workspace: Pick<Workspace, "root">, record: AgentJobRecord): Promise<AgentJobRecord> {
  const updatedAt = nowIso();
  const next = {
    ...record,
    updatedAt,
    ...(record.launch
      ? {
          launch: {
            ...record.launch,
            lastUpdateAt: updatedAt
          }
        }
      : {})
  };
  await writeJsonAtomic(agentJobPath(workspace, next.jobId), next);
  persistAgentJobSnapshot(next);
  return next;
}

function parseJobRecord(raw: string, filePath: string): AgentJobRecord {
  try {
    const parsed = JSON.parse(raw) as AgentJobRecord;
    if (!parsed || typeof parsed !== "object" || typeof parsed.jobId !== "string" || typeof parsed.taskId !== "string") {
      throw new Error("missing jobId/taskId");
    }
    return parsed;
  } catch (error) {
    throw new LeastError(`Invalid agent job file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readAgentJob(workspace: Pick<Workspace, "root">, jobId: string): Promise<AgentJobRecord> {
  const filePath = agentJobPath(workspace, jobId);
  try {
    return parseJobRecord(await fsp.readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LeastError(`Agent job not found: ${jobId}`);
    }
    throw error;
  }
}

export async function listAgentJobs(workspace: Pick<Workspace, "root">): Promise<AgentJobRecord[]> {
  const root = agentRunsDir(workspace);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: AgentJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, "status.json");
    try {
      jobs.push(parseJobRecord(await fsp.readFile(filePath, "utf8"), filePath));
    } catch {
      // Ignore corrupt or partial records during listing; direct read surfaces them.
    }
  }
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function findAgentJobByTask(workspace: Pick<Workspace, "root">, taskId: string): Promise<AgentJobRecord | undefined> {
  for (const record of await listAgentJobs(workspace)) {
    if (record.taskId === taskId) return record;
  }
  return undefined;
}

export async function findAgentJobByIdempotencyKey(workspace: Pick<Workspace, "root">, idempotencyKey: string): Promise<AgentJobRecord | undefined> {
  for (const record of await listAgentJobs(workspace)) {
    if (record.idempotencyKey === idempotencyKey) return record;
  }
  return undefined;
}

export async function resolveAgentJob(workspace: Pick<Workspace, "root">, input: { jobId?: string; taskId?: string }): Promise<AgentJobRecord> {
  if (input.jobId) return await readAgentJob(workspace, input.jobId);
  if (input.taskId) {
    const found = await findAgentJobByTask(workspace, input.taskId);
    if (found) return found;
    throw new LeastError(`Agent job not found for task_id: ${input.taskId}`);
  }
  throw new LeastError("agent tools require job_id or task_id.");
}

export async function removeAgentJob(workspace: Pick<Workspace, "root">, jobId: string): Promise<void> {
  const dir = agentJobDir(workspace, jobId);
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function listAgentRunEntries(workspace: Pick<Workspace, "root">): Promise<Array<{ dirName: string; job?: AgentJobRecord; orphan: boolean }>> {
  const root = agentRunsDir(workspace);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: Array<{ dirName: string; job?: AgentJobRecord; orphan: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, "status.json");
    try {
      const job = parseJobRecord(await fsp.readFile(filePath, "utf8"), filePath);
      results.push({ dirName: entry.name, job, orphan: false });
    } catch {
      results.push({ dirName: entry.name, orphan: true });
    }
  }
  return results;
}
