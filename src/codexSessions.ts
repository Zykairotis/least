import { type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LeastConfig } from "./config.js";
import { isSubpath, LeastError } from "./guard.js";

export interface CodexSessionMeta {
  session_id: string;
  title?: string;
  project_dir?: string;
  created_at?: number;
  last_active_at?: number;
  source_path: string;
  resume_command: string;
}

export interface CodexSessionMessage { role: string; content: string; ts?: number }

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BLOCK_BYTES = 64 * 1024;

function roots(config: LeastConfig): string[] {
  return [path.join(config.codexDir, "sessions"), path.join(config.codexDir, "archived_sessions")];
}

function ensureMode(config: LeastConfig, read = false): void {
  if (config.codexSessions === "off") throw new LeastError("Codex sessions disabled. Set LEAST_CODEX_SESSIONS=metadata or read.");
  if (read && config.codexSessions !== "read") throw new LeastError("Codex transcript reads disabled. Set LEAST_CODEX_SESSIONS=read.");
}

async function collectJsonl(root: string, output: string[], depth = 0): Promise<void> {
  if (depth > 6 || output.length >= 3000) return;
  let entries: Dirent[];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= 3000) return;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await collectJsonl(target, output, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "").filter(Boolean).join("\n");
}

function parse(line: string): any | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

async function slice(file: string, start: number, length: number): Promise<string> {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function metadata(file: string): Promise<CodexSessionMeta | undefined> {
  const stat = await fsp.stat(file);
  const head = await slice(file, 0, Math.min(stat.size, BLOCK_BYTES));
  const tailStart = Math.max(0, stat.size - BLOCK_BYTES);
  const tail = tailStart ? await slice(file, tailStart, stat.size - tailStart) : head;
  let id = path.basename(file).match(UUID)?.[0];
  let projectDir: string | undefined;
  let createdAt: number | undefined;
  let title: string | undefined;
  for (const line of head.split(/\r?\n/)) {
    const value = parse(line);
    if (!value) continue;
    createdAt ??= timestamp(value.timestamp);
    if (value.type === "session_meta") {
      if (value.payload?.source?.subagent) return undefined;
      id ??= value.payload?.id ?? value.payload?.session_id;
      projectDir ??= value.payload?.cwd ?? value.payload?.project_dir;
    }
    if (!title && value.type === "response_item" && value.payload?.type === "message" && value.payload?.role === "user") {
      const candidate = text(value.payload.content).replace(/\s+/g, " ").trim();
      if (candidate && !candidate.startsWith("<environment_context>")) title = candidate.slice(0, 96);
    }
  }
  if (!id) return undefined;
  let lastActiveAt: number | undefined;
  for (const line of tail.split(/\r?\n/).reverse()) {
    lastActiveAt = timestamp(parse(line)?.timestamp);
    if (lastActiveAt) break;
  }
  return { session_id: String(id), title, project_dir: projectDir, created_at: createdAt, last_active_at: lastActiveAt, source_path: file, resume_command: `codex resume ${id}` };
}

async function allSessions(config: LeastConfig): Promise<CodexSessionMeta[]> {
  const files: string[] = [];
  for (const root of roots(config)) await collectJsonl(root, files);
  const results = await Promise.all(files.map((file) => metadata(file).catch(() => undefined)));
  return results.filter((item): item is CodexSessionMeta => Boolean(item));
}

export async function listCodexSessions(config: LeastConfig, options: { query?: string; maxSessions?: number } = {}) {
  ensureMode(config);
  const query = options.query?.trim().toLowerCase();
  const sessions = (await allSessions(config)).filter((session) => !query || [session.session_id, session.title, session.project_dir, session.source_path].filter(Boolean).join("\n").toLowerCase().includes(query));
  sessions.sort((a, b) => (b.last_active_at ?? b.created_at ?? 0) - (a.last_active_at ?? a.created_at ?? 0));
  const max = Math.max(1, Math.min(options.maxSessions ?? 30, 200));
  return { codex_dir: config.codexDir, roots: roots(config), sessions: sessions.slice(0, max), total_found: sessions.length };
}

async function resolveSource(config: LeastConfig, sessionId?: string, sourcePath?: string): Promise<CodexSessionMeta> {
  ensureMode(config, true);
  const canonicalRoots = await Promise.all(roots(config).map((root) => fsp.realpath(root).catch(() => path.resolve(root))));
  if (sourcePath) {
    const canonical = await fsp.realpath(path.resolve(sourcePath));
    if (!canonicalRoots.some((root) => isSubpath(canonical, root))) throw new LeastError("Codex session source_path outside configured roots.");
    const result = await metadata(canonical);
    if (!result || (sessionId && result.session_id !== sessionId)) throw new LeastError("Codex session metadata mismatch.");
    return result;
  }
  if (!sessionId) throw new LeastError("session_id or source_path required.");
  const result = (await allSessions(config)).find((session) => session.session_id === sessionId);
  if (!result) throw new LeastError(`Codex session not found: ${sessionId}`);
  return result;
}

function message(line: string, excludeToolOutputs: boolean, maxToolBytes: number): CodexSessionMessage | undefined {
  const value = parse(line);
  const payload = value?.type === "response_item" ? value.payload : undefined;
  if (!payload) return undefined;
  let role: string;
  let content: string;
  if (payload.type === "message") { role = String(payload.role ?? "unknown"); content = text(payload.content); }
  else if (payload.type === "function_call") { role = "assistant"; content = `[Tool: ${payload.name ?? "unknown"}]`; }
  else if (payload.type === "function_call_output" && !excludeToolOutputs) { role = "tool"; content = String(payload.output ?? ""); }
  else return undefined;
  if (!content.trim()) return undefined;
  if (Buffer.byteLength(content) > maxToolBytes && role === "tool") content = `${Buffer.from(content).subarray(0, maxToolBytes).toString("utf8")}\n[Tool output truncated]`;
  const ts = timestamp(value.timestamp);
  return { role, content, ...(ts ? { ts } : {}) };
}

export async function readCodexSession(config: LeastConfig, options: { sessionId?: string; sourcePath?: string; direction?: "head" | "tail"; cursor?: number; maxMessages?: number; maxTotalBytes?: number; excludeToolOutputs?: boolean; maxToolOutputBytes?: number } = {}) {
  const session = await resolveSource(config, options.sessionId, options.sourcePath);
  const stat = await fsp.stat(session.source_path);
  const direction = options.direction === "head" ? "head" : "tail";
  const cursor = options.cursor ?? (direction === "tail" ? stat.size : 0);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > stat.size) throw new LeastError("Invalid Codex session byte cursor.");
  const byteLimit = Math.max(4_000, Math.min(options.maxTotalBytes ?? 80_000, 400_000));
  const scanStart = direction === "tail" ? Math.max(0, cursor - Math.max(byteLimit * 8, BLOCK_BYTES)) : cursor;
  const scanEnd = direction === "tail" ? cursor : Math.min(stat.size, cursor + Math.max(byteLimit * 8, BLOCK_BYTES));
  let raw = await slice(session.source_path, scanStart, scanEnd - scanStart);
  if (scanStart > 0) raw = raw.slice(Math.max(0, raw.indexOf("\n") + 1));
  if (scanEnd < stat.size) raw = raw.slice(0, raw.lastIndexOf("\n"));
  const parsed = raw.split(/\r?\n/).map((line) => message(line, options.excludeToolOutputs === true, Math.max(0, Math.min(options.maxToolOutputBytes ?? 20_000, 400_000)))).filter((item): item is CodexSessionMessage => Boolean(item));
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 80, 400));
  const selected = direction === "tail" ? parsed.slice(-maxMessages) : parsed.slice(0, maxMessages);
  let used = 0;
  const messages = selected.filter((item) => { const bytes = Buffer.byteLength(item.content); if (used + bytes > byteLimit) return false; used += bytes; return true; });
  const hasMore = direction === "tail" ? scanStart > 0 || parsed.length > selected.length : scanEnd < stat.size || parsed.length > selected.length;
  const nextCursor = direction === "tail" ? scanStart : scanEnd;
  const transcript = messages.map((item) => `### ${item.role}${item.ts ? ` ${new Date(item.ts).toISOString()}` : ""}\n\n${item.content}`).join("\n\n");
  const output = `# Codex Session\n\nSession: ${session.session_id}\nSource: ${session.source_path}\nDirection: ${direction}\nCursor: ${cursor}\nNext cursor: ${nextCursor}\nResume: ${session.resume_command}\n\n## Transcript\n\n${transcript || "No readable messages."}`;
  return { session, messages, truncated: hasMore, direction, cursor, next_cursor: hasMore ? nextCursor : undefined, has_more: hasMore, source_size_bytes: stat.size, text: output };
}

export function defaultCodexDir(): string { return path.join(os.homedir(), ".codex"); }
