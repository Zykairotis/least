import fsp from "node:fs/promises";
import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import { listFiles } from "./fsOps.js";
import { redactSensitiveText } from "./redact.js";
import { readTextWithSnapshot } from "./fileSnapshotCache.js";

export interface JsonQueryOptions {
  path?: string;
  glob?: string;
  pointer?: string;
  maxResults: number;
}

export interface JsonQueryHit {
  path: string;
  pointer: string;
  value: unknown;
  preview: string;
}

export interface JsonQueryResult {
  text: string;
  hits: JsonQueryHit[];
  truncated: boolean;
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePointer(pointer: string): string[] {
  const trimmed = pointer.trim();
  if (!trimmed || trimmed === "/") return [];
  if (!trimmed.startsWith("/")) {
    throw new LeastError('pointer must be a JSON Pointer starting with "/", for example /dependencies/react.');
  }
  return trimmed.split("/").filter(Boolean).map(decodePointerToken);
}

export function resolveJsonPointer(data: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  let current = data;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    return undefined;
  }
  return current;
}

function previewValue(value: unknown, maxChars = 2000): string {
  let text: string;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = value;
  else text = JSON.stringify(value, null, 2) ?? String(value);
  if (text.length > maxChars) return `${text.slice(0, maxChars)}…`;
  return text;
}

async function candidateJsonFiles(
  guard: PathGuard,
  workspace: Workspace,
  options: JsonQueryOptions
): Promise<string[]> {
  if (options.path) {
    const resolved = guard.resolve(workspace, options.path);
    return [resolved.relPath];
  }
  const files = await listFiles(guard, workspace, {
    root: ".",
    glob: options.glob ?? "**/*.{json,jsonc}",
    includeHidden: false,
    maxFiles: options.maxResults + 1
  });
  return files.filter((rel) => /\.(json|jsonc)$/i.test(rel));
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

export async function queryJsonFiles(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawOptions: Partial<JsonQueryOptions>
): Promise<JsonQueryResult> {
  const pointer = rawOptions.pointer?.toString() ?? "/";
  parsePointer(pointer);
  const options: JsonQueryOptions = {
    path: rawOptions.path,
    glob: rawOptions.glob,
    pointer,
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? 20, 100))
  };

  const candidates = await candidateJsonFiles(guard, workspace, options);
  const hits: JsonQueryHit[] = [];
  let truncated = candidates.length > options.maxResults;

  for (const rel of candidates.slice(0, options.maxResults)) {
    const resolved = guard.resolve(workspace, rel);
    try {
      const stat = await fsp.stat(resolved.absPath);
      if (stat.size > config.maxReadBytes) continue;
      const raw = (await readTextWithSnapshot(resolved.absPath, { maxBytes: config.maxReadBytes })).text;
      const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
      const value = resolveJsonPointer(parsed, pointer);
      if (value === undefined && pointer !== "/") continue;
      hits.push({
        path: rel,
        pointer,
        value,
        preview: redactSensitiveText(previewValue(value))
      });
    } catch {
      // Skip invalid or unreadable JSON files.
    }
  }

  const text =
    hits.length === 0
      ? `No JSON values matched pointer ${pointer}.`
      : hits.map((hit) => `### ${hit.path} @ ${hit.pointer}\n\`\`\`json\n${hit.preview}\n\`\`\``).join("\n\n");
  return { text, hits, truncated };
}
