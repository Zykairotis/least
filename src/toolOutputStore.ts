import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { LeastConfig } from "./config.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";
import type { OutputKind } from "./outputShaper.js";

export interface StoredOutputMeta {
  key: string;
  toolName: string;
  kind: OutputKind;
  createdAt: string;
  rawBytes: number;
  visibleBytes: number;
  ttlMs: number;
}

const KEY_RE = /^sha256:[a-f0-9]{64}$/;

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function hashContent(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function storeRoot(workspaceRoot: string, workspaceId: string): string {
  return path.join(workspaceRoot, ".least", "cache", "tool-output", workspaceId);
}

function metaPath(root: string, key: string): string {
  const safe = key.replace("sha256:", "");
  return path.join(root, `${safe}.json`);
}

function contentPath(root: string, key: string): string {
  const safe = key.replace("sha256:", "");
  return path.join(root, `${safe}.txt`);
}

export function isValidRetrievalKey(key: string): boolean {
  return KEY_RE.test(key);
}

export async function storeToolOutput(
  config: LeastConfig,
  workspaceRoot: string,
  workspaceId: string,
  toolName: string,
  kind: OutputKind,
  rawText: string,
  visibleBytes = 0
): Promise<string | undefined> {
  if (!config.outputStore) return undefined;
  const redacted = redactSensitiveText(rawText);
  if (hasSecretValue(redacted)) return undefined;
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes > config.outputStoreMaxItemBytes) return undefined;

  const key = hashContent(redacted);
  const root = storeRoot(workspaceRoot, workspaceId);
  await fsp.mkdir(root, { recursive: true });
  const txtPath = contentPath(root, key);
  const meta: StoredOutputMeta = {
    key,
    toolName,
    kind,
    createdAt: new Date().toISOString(),
    rawBytes: bytes,
    visibleBytes: Math.max(0, visibleBytes),
    ttlMs: config.outputStoreTtlMs
  };
  const metadataPath = metaPath(root, key);
  const exists = await Promise.all([fsp.access(txtPath).then(() => true, () => false), fsp.access(metadataPath).then(() => true, () => false)]);
  if (!exists[0] || !exists[1]) {
    await Promise.all([
      exists[0] ? Promise.resolve() : fsp.writeFile(txtPath, redacted, "utf8"),
      exists[1] ? Promise.resolve() : fsp.writeFile(metadataPath, JSON.stringify(meta), "utf8")
    ]);
  }
  return key;
}

export interface StoreMutationDiffOptions {
  toolName: string;
  changedPaths?: string[];
  visibleBytes?: number;
}

/**
 * Store a full mutation diff for later retrieval.
 * Redacts secrets, skips when store disabled or content looks secret.
 * Avoids duplicate writes when the same content already exists.
 */
export async function storeMutationDiff(
  config: LeastConfig,
  workspaceRoot: string,
  workspaceId: string,
  diffText: string,
  options: StoreMutationDiffOptions
): Promise<string | undefined> {
  if (!diffText || !diffText.trim()) return undefined;
  // Reject before redaction so secret-looking diffs are not stored at all.
  if (hasSecretValue(diffText)) return undefined;
  const header =
    options.changedPaths && options.changedPaths.length
      ? `# Mutation Diff (${options.toolName})\nPaths: ${options.changedPaths.join(", ")}\n\n`
      : `# Mutation Diff (${options.toolName})\n\n`;
  return storeToolOutput(
    config,
    workspaceRoot,
    workspaceId,
    options.toolName,
    "git_diff",
    header + diffText,
    options.visibleBytes ?? 0
  );
}

async function loadMeta(root: string, key: string): Promise<StoredOutputMeta | undefined> {
  try {
    const raw = await fsp.readFile(metaPath(root, key), "utf8");
    const meta = JSON.parse(raw) as StoredOutputMeta;
    const age = Date.now() - new Date(meta.createdAt).getTime();
    if (age > meta.ttlMs) {
      await fsp.unlink(metaPath(root, key)).catch(() => undefined);
      await fsp.unlink(contentPath(root, key)).catch(() => undefined);
      return undefined;
    }
    return meta;
  } catch {
    return undefined;
  }
}

export interface RetrieveOutputResult {
  key: string;
  content: string;
  rawBytes: number;
  returnedBytes: number;
  truncated: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  meta?: StoredOutputMeta;
}

export async function retrieveStoredOutput(
  config: LeastConfig,
  workspaceRoot: string,
  workspaceId: string,
  key: string,
  options: { startLine?: number; endLine?: number; maxBytes?: number } = {}
): Promise<RetrieveOutputResult> {
  if (!isValidRetrievalKey(key)) {
    throw new Error(`Invalid retrieval key format: ${key}`);
  }
  const root = storeRoot(workspaceRoot, workspaceId);
  const meta = await loadMeta(root, key);
  if (!meta) {
    throw new Error(`Retrieval key not found or expired: ${key}`);
  }
  const absPath = contentPath(root, key);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Stored output missing for key: ${key}`);
  }
  const resolved = path.resolve(absPath);
  if (!isInside(path.resolve(root), resolved)) {
    throw new Error("Retrieval path escapes workspace store");
  }

  const maxBytes = Math.min(options.maxBytes ?? config.maxOutputBytes, config.maxOutputBytes);
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const endLine = options.endLine !== undefined ? Math.max(startLine, Math.floor(options.endLine)) : undefined;

  const lines: string[] = [];
  let totalLines = 0;
  const stream = fs.createReadStream(absPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    totalLines += 1;
    if (totalLines >= startLine && (endLine === undefined || totalLines <= endLine)) {
      lines.push(line);
    }
    if (endLine !== undefined && totalLines > endLine) break;
  }
  reader.close();
  stream.destroy();

  let content = lines.map((line, idx) => `${startLine + idx} | ${line}`).join("\n");
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = content.slice(0, maxBytes) + "\n...[retrieval truncated]";
    truncated = true;
  }
  content = redactSensitiveText(content);
  return {
    key,
    content,
    rawBytes: meta.rawBytes,
    returnedBytes: Buffer.byteLength(content, "utf8"),
    truncated,
    startLine,
    endLine: endLine ?? totalLines,
    totalLines,
    meta
  };
}

export async function cleanupExpiredOutputs(workspaceRoot: string, workspaceId: string): Promise<number> {
  const root = storeRoot(workspaceRoot, workspaceId);
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  const entries = await fsp.readdir(root);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const key = `sha256:${entry.replace(/\.json$/, "")}`;
    const meta = await loadMeta(root, key);
    if (!meta) removed += 1;
  }
  return removed;
}
