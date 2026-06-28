import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";

export type ProjectMemoryKind = "architecture" | "command" | "decision" | "warning" | "workflow" | "file_map";
export type ProjectMemorySource = "manual" | "handoff" | "tool" | "agent";

export interface ProjectMemoryRecord {
  id: string;
  kind: ProjectMemoryKind;
  text: string;
  source: ProjectMemorySource;
  confidence: number;
  paths?: string[];
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}

function memoryPath(workspace: Workspace): string {
  return path.join(workspace.root, ".least", "memory", "project-memory.jsonl");
}

async function readAllLines(workspace: Workspace): Promise<ProjectMemoryRecord[]> {
  const file = memoryPath(workspace);
  if (!fs.existsSync(file)) return [];
  const raw = await fsp.readFile(file, "utf8");
  const out: ProjectMemoryRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ProjectMemoryRecord);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function collapseRecords(records: ProjectMemoryRecord[]): ProjectMemoryRecord[] {
  const latestById = new Map<string, ProjectMemoryRecord>();
  for (const record of records) {
    const existing = latestById.get(record.id);
    if (!existing || record.updatedAt.localeCompare(existing.updatedAt) >= 0) {
      latestById.set(record.id, record);
    }
  }

  const supersededIds = new Set<string>();
  for (const record of latestById.values()) {
    if (record.supersededBy) supersededIds.add(record.id);
  }

  return [...latestById.values()]
    .filter((record) => !record.supersededBy && !supersededIds.has(record.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readRecords(workspace: Workspace): Promise<ProjectMemoryRecord[]> {
  return collapseRecords(await readAllLines(workspace));
}

function normalizeText(text: string): string {
  const redacted = redactSensitiveText(text.trim());
  if (hasSecretValue(redacted)) throw new Error("Refusing to store secret-looking project memory text.");
  return redacted;
}

export async function searchProjectMemory(
  workspace: Workspace,
  query: string,
  options: { kind?: ProjectMemoryKind; maxResults?: number } = {}
): Promise<ProjectMemoryRecord[]> {
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 2);
  const records = await readRecords(workspace);
  const scored = records
    .filter((record) => (options.kind ? record.kind === options.kind : true))
    .map((record) => {
      const hay = `${record.text} ${(record.paths ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (hay.includes(token)) score += 1;
      return { record, score };
    })
    .filter((item) => item.score > 0 || !tokens.length)
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
  return scored.slice(0, options.maxResults ?? 8).map((item) => item.record);
}

export async function saveProjectMemory(
  workspace: Workspace,
  input: {
    kind: ProjectMemoryKind;
    text: string;
    source?: ProjectMemorySource;
    confidence?: number;
    paths?: string[];
  }
): Promise<ProjectMemoryRecord> {
  const text = normalizeText(input.text);
  const existing = await readRecords(workspace);
  const duplicate = existing.find((record) => record.kind === input.kind && record.text === text);
  if (duplicate) return duplicate;
  const now = new Date().toISOString();
  const record: ProjectMemoryRecord = {
    id: randomUUID(),
    kind: input.kind,
    text,
    source: input.source ?? "tool",
    confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)),
    paths: input.paths,
    createdAt: now,
    updatedAt: now
  };
  const file = memoryPath(workspace);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function updateProjectMemory(
  workspace: Workspace,
  id: string,
  text: string,
  supersede = false
): Promise<ProjectMemoryRecord> {
  const records = await readRecords(workspace);
  const existing = records.find((record) => record.id === id);
  if (!existing) throw new Error(`Project memory record not found: ${id}`);
  const file = memoryPath(workspace);
  const now = new Date().toISOString();

  if (supersede) {
    const replacement = await saveProjectMemory(workspace, {
      kind: existing.kind,
      text,
      source: existing.source,
      confidence: existing.confidence,
      paths: existing.paths
    });
    const superseded: ProjectMemoryRecord = { ...existing, supersededBy: replacement.id, updatedAt: now };
    await fsp.appendFile(file, `${JSON.stringify(superseded)}\n`, "utf8");
    return replacement;
  }

  const updated: ProjectMemoryRecord = {
    ...existing,
    text: normalizeText(text),
    updatedAt: now
  };
  await fsp.appendFile(file, `${JSON.stringify(updated)}\n`, "utf8");
  return updated;
}

export async function memoryPathsForContext(config: LeastConfig, workspace: Workspace, task: string): Promise<string[]> {
  if (!config.projectMemory) return [];
  const hits = await searchProjectMemory(workspace, task, { maxResults: 6 });
  return [...new Set(hits.flatMap((record) => record.paths ?? []))];
}