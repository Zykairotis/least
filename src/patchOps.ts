import fs from "node:fs/promises";
import path from "node:path";
import type { LeastConfig } from "./config.js";
import { computeMutationDiff, type DiffComputeMode } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import { hasSecretValue } from "./redact.js";
import { readTextWithSnapshot } from "./fileSnapshotCache.js";
import { commitFileTransaction, type FileTransactionChange } from "./fileTransaction.js";

export type PatchAction =
  | { type: "add"; file: string; lines: string[] }
  | { type: "delete"; file: string }
  | { type: "update"; file: string; moveTo?: string; lines: string[] };

export interface ApplyPatchResult {
  changedFiles: string[];
  additions: number;
  deletions: number;
  diff: string;
  /** content = only existing file contents; structure = add/delete/move/rename. */
  impact: "content" | "structure";
}

export interface PatchPreviewResult {
  changedFiles: string[];
  additions: number;
  deletions: number;
  preview: Record<string, string>;
  conflicts: string[];
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

export function parsePatch(patch: string): PatchAction[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new LeastError("apply_patch expects patch text starting with *** Begin Patch.");
  }
  const actions: PatchAction[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "*** End Patch") break;
    if (line.startsWith("*** Add File: ")) {
      const file = line.slice("*** Add File: ".length).trim();
      index += 1;
      const added: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const current = lines[index] ?? "";
        if (!current.startsWith("+")) throw new LeastError(`Invalid add file line: ${current}`);
        added.push(current.slice(1));
        index += 1;
      }
      actions.push({ type: "add", file, lines: added });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      actions.push({ type: "delete", file: line.slice("*** Delete File: ".length).trim() });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = line.slice("*** Update File: ".length).trim();
      index += 1;
      let moveTo: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        moveTo = (lines[index] ?? "").slice("*** Move to: ".length).trim();
        index += 1;
      }
      const body: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      actions.push({ type: "update", file, moveTo, lines: body });
      continue;
    }
    throw new LeastError(`Unsupported patch directive: ${line}`);
  }
  return actions;
}

function applyUpdateToText(original: string, patchLines: string[]): string {
  const source = splitLines(original);
  const output: string[] = [];
  let cursor = 0;

  const hunks: string[][] = [];
  let current: string[] = [];
  for (const raw of patchLines) {
    if (raw.startsWith("@@")) {
      if (current.length) hunks.push(current);
      current = [];
      continue;
    }
    if (raw === "*** End of File") continue;
    current.push(raw);
  }
  if (current.length) hunks.push(current);

  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const raw of hunk) {
      const op = raw[0];
      const content = raw.slice(1);
      if (op === " ") {
        oldLines.push(content);
        newLines.push(content);
      } else if (op === "-") {
        oldLines.push(content);
      } else if (op === "+") {
        newLines.push(content);
      } else {
        throw new LeastError(`Unsupported patch line: ${raw}`);
      }
    }

    const matches: number[] = [];
    if (oldLines.length === 0) {
      matches.push(cursor);
    } else {
      for (let start = cursor; start + oldLines.length <= source.length; start += 1) {
        if (oldLines.every((line, index) => source[start + index] === line)) matches.push(start);
      }
    }
    if (matches.length === 0) throw new LeastError("Patch hunk context not found.");
    if (matches.length > 1) throw new LeastError("Patch hunk is ambiguous; add more surrounding context.");

    const start = matches[0]!;
    output.push(...source.slice(cursor, start), ...newLines);
    cursor = start + oldLines.length;
  }

  while (cursor < source.length) {
    output.push(source[cursor] as string);
    cursor += 1;
  }
  return joinLines(output);
}

async function readPatchText(config: LeastConfig, guard: PathGuard, absPath: string): Promise<string> {
  const stat = await guard.assertTextFile(absPath, config.maxWriteBytes);
  return (await readTextWithSnapshot(absPath, { maxBytes: config.maxWriteBytes, knownStat: stat })).text;
}

export async function applyWorkspacePatch(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string,
  options: {
    checkOnly?: boolean;
    authorizePath?: (relPath: string) => void;
    /** Control unified-diff generation. Default: full. */
    diffMode?: DiffComputeMode;
    maxDiffChars?: number;
  } = {}
): Promise<ApplyPatchResult> {
  const actions = parsePatch(patch);
  const changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;
  const storageParts: string[] = [];
  let impact: "content" | "structure" = "content";
  const diffMode: DiffComputeMode = options.diffMode ?? "full";

  const changes: FileTransactionChange[] = [];
  const occupiedTargets = new Set<string>();
  for (const action of actions) {
    if (action.type === "add") {
      impact = "structure";
      const resolved = guard.resolve(workspace, action.file, { forWrite: true });
      options.authorizePath?.(resolved.relPath);
      if (occupiedTargets.has(resolved.absPath)) throw new LeastError(`Patch targets file more than once: ${action.file}`);
      occupiedTargets.add(resolved.absPath);
      if (await fs.access(resolved.absPath).then(() => true, () => false)) throw new LeastError(`Refusing to overwrite existing file: ${action.file}`);
      const content = joinLines(action.lines);
      if (Buffer.byteLength(content, "utf8") > config.maxWriteBytes) {
        throw new LeastError(`Patched file too large: ${action.file}`);
      }
      if (hasSecretValue(content)) throw new LeastError("Secret-looking content is blocked from patch write.");
      const diff = await computeMutationDiff("", content, resolved.relPath, diffMode, options.maxDiffChars, {
        storageMaxChars: config.outputStoreMaxItemBytes
      });
      additions += diff.additions ?? 0;
      deletions += diff.deletions ?? 0;
      if (diff.storageDiff) storageParts.push(diff.storageDiff);
      changedFiles.push(resolved.relPath);
      changes.push({ type: "write", absPath: resolved.absPath, content, mustNotExist: true });
      continue;
    }
    if (action.type === "delete") {
      impact = "structure";
      const resolved = guard.resolve(workspace, action.file, { forWrite: true });
      options.authorizePath?.(resolved.relPath);
      if (occupiedTargets.has(resolved.absPath)) throw new LeastError(`Patch targets file more than once: ${action.file}`);
      occupiedTargets.add(resolved.absPath);
      const before = await readPatchText(config, guard, resolved.absPath);
      const diff = await computeMutationDiff(before, "", resolved.relPath, diffMode, options.maxDiffChars, {
        storageMaxChars: config.outputStoreMaxItemBytes
      });
      additions += diff.additions ?? 0;
      deletions += diff.deletions ?? 0;
      if (diff.storageDiff) storageParts.push(diff.storageDiff);
      changedFiles.push(resolved.relPath);
      changes.push({ type: "delete", absPath: resolved.absPath });
      continue;
    }
    const resolved = guard.resolve(workspace, action.file, { forWrite: true });
    options.authorizePath?.(resolved.relPath);
    const before = await readPatchText(config, guard, resolved.absPath);
    const after = applyUpdateToText(before, action.lines);
    if (Buffer.byteLength(after, "utf8") > config.maxWriteBytes) {
      throw new LeastError(`Patched file too large: ${action.file}`);
    }
    if (hasSecretValue(after)) throw new LeastError("Secret-looking content is blocked from patch edit.");
    const targetPath = action.moveTo ? guard.resolve(workspace, action.moveTo, { forWrite: true }) : resolved;
    options.authorizePath?.(targetPath.relPath);
    if (occupiedTargets.has(targetPath.absPath)) throw new LeastError(`Patch targets file more than once: ${targetPath.relPath}`);
    occupiedTargets.add(targetPath.absPath);
    if (action.moveTo && targetPath.absPath !== resolved.absPath && await fs.access(targetPath.absPath).then(() => true, () => false)) {
      throw new LeastError(`Refusing to overwrite existing move destination: ${targetPath.relPath}`);
    }
    if (action.moveTo && targetPath.absPath !== resolved.absPath) {
      impact = "structure";
    }
    const diff = await computeMutationDiff(before, after, targetPath.relPath, diffMode, options.maxDiffChars, {
      storageMaxChars: config.outputStoreMaxItemBytes
    });
    additions += diff.additions ?? 0;
    deletions += diff.deletions ?? 0;
    if (diff.storageDiff) storageParts.push(diff.storageDiff);
    changedFiles.push(targetPath.relPath);
    changes.push({ type: "write", absPath: targetPath.absPath, content: after, mustNotExist: Boolean(action.moveTo && targetPath.absPath !== resolved.absPath) });
    if (action.moveTo && targetPath.absPath !== resolved.absPath) {
      changes.push({ type: "delete", absPath: resolved.absPath });
    }
  }

  if (!options.checkOnly) await commitFileTransaction(changes);

  return {
    changedFiles,
    additions,
    deletions,
    // Prefer storage-complete combined diff for retrieval.
    diff: storageParts.join("\n\n"),
    impact
  };
}

export async function previewWorkspacePatch(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): Promise<PatchPreviewResult> {
  const actions = parsePatch(patch);
  const changedFiles: string[] = [];
  const preview: Record<string, string> = {};
  const conflicts: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const action of actions) {
    try {
      if (action.type === "add") {
        const resolved = guard.resolve(workspace, action.file, { forWrite: true });
        const content = joinLines(action.lines);
        if (Buffer.byteLength(content, "utf8") > config.maxWriteBytes) throw new LeastError(`Patched file too large: ${action.file}`);
        if (hasSecretValue(content)) throw new LeastError("Secret-looking content is blocked from patch preview.");
        const diff = await computeMutationDiff("", content, resolved.relPath, "full");
        additions += diff.additions ?? 0;
        deletions += diff.deletions ?? 0;
        changedFiles.push(resolved.relPath);
        preview[resolved.relPath] = content;
        continue;
      }
      if (action.type === "delete") {
        const resolved = guard.resolve(workspace, action.file, { forWrite: true });
        const before = await readPatchText(config, guard, resolved.absPath);
        const diff = await computeMutationDiff(before, "", resolved.relPath, "full");
        additions += diff.additions ?? 0;
        deletions += diff.deletions ?? 0;
        changedFiles.push(resolved.relPath);
        preview[resolved.relPath] = "";
        continue;
      }
      const resolved = guard.resolve(workspace, action.file, { forWrite: true });
      const before = await readPatchText(config, guard, resolved.absPath);
      const after = applyUpdateToText(before, action.lines);
      if (Buffer.byteLength(after, "utf8") > config.maxWriteBytes) throw new LeastError(`Patched file too large: ${action.file}`);
      if (hasSecretValue(after)) throw new LeastError("Secret-looking content is blocked from patch preview.");
      const targetPath = action.moveTo ? guard.resolve(workspace, action.moveTo, { forWrite: true }) : resolved;
      const diff = await computeMutationDiff(before, after, targetPath.relPath, "full");
      additions += diff.additions ?? 0;
      deletions += diff.deletions ?? 0;
      changedFiles.push(targetPath.relPath);
      preview[targetPath.relPath] = after;
    } catch (error) {
      conflicts.push(`${action.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { changedFiles, additions, deletions, preview, conflicts };
}
