import fs from "node:fs/promises";
import path from "node:path";
import type { LeastConfig } from "./config.js";
import { makeUnifiedDiffMaybeOffloaded } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import { hasSecretValue } from "./redact.js";

type PatchAction =
  | { type: "add"; file: string; lines: string[] }
  | { type: "delete"; file: string }
  | { type: "update"; file: string; moveTo?: string; lines: string[] };

export interface ApplyPatchResult {
  changedFiles: string[];
  additions: number;
  deletions: number;
  diff: string;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function parsePatch(patch: string): PatchAction[] {
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

  for (const raw of patchLines) {
    if (raw.startsWith("@@")) continue;
    const op = raw[0];
    const content = raw.slice(1);
    if (op === " ") {
      while (cursor < source.length && source[cursor] !== content) {
        output.push(source[cursor] as string);
        cursor += 1;
      }
      if (source[cursor] !== content) {
        throw new LeastError(`Patch context not found: ${content}`);
      }
      output.push(content);
      cursor += 1;
      continue;
    }
    if (op === "-") {
      while (cursor < source.length && source[cursor] !== content) {
        output.push(source[cursor] as string);
        cursor += 1;
      }
      if (source[cursor] !== content) {
        throw new LeastError(`Patch removal not found: ${content}`);
      }
      cursor += 1;
      continue;
    }
    if (op === "+") {
      output.push(content);
      continue;
    }
    if (raw === "*** End of File") continue;
    throw new LeastError(`Unsupported patch line: ${raw}`);
  }

  while (cursor < source.length) {
    output.push(source[cursor] as string);
    cursor += 1;
  }
  return joinLines(output);
}

export async function applyWorkspacePatch(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string,
  options: { checkOnly?: boolean } = {}
): Promise<ApplyPatchResult> {
  const actions = parsePatch(patch);
  const changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;
  const diffs: string[] = [];

  for (const action of actions) {
    if (action.type === "add") {
      const resolved = guard.resolve(workspace, action.file, { forWrite: true });
      const content = joinLines(action.lines);
      if (Buffer.byteLength(content, "utf8") > config.maxWriteBytes) {
        throw new LeastError(`Patched file too large: ${action.file}`);
      }
      if (hasSecretValue(content)) throw new LeastError("Secret-looking content is blocked from patch write.");
      const diff = await makeUnifiedDiffMaybeOffloaded("", content, resolved.relPath);
      additions += diff.additions;
      deletions += diff.deletions;
      diffs.push(diff.diff);
      changedFiles.push(resolved.relPath);
      if (!options.checkOnly) {
        await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
        await fs.writeFile(resolved.absPath, content, "utf8");
      }
      continue;
    }
    if (action.type === "delete") {
      const resolved = guard.resolve(workspace, action.file, { forWrite: true });
      const before = await fs.readFile(resolved.absPath, "utf8");
      const diff = await makeUnifiedDiffMaybeOffloaded(before, "", resolved.relPath);
      additions += diff.additions;
      deletions += diff.deletions;
      diffs.push(diff.diff);
      changedFiles.push(resolved.relPath);
      if (!options.checkOnly) {
        await fs.unlink(resolved.absPath);
      }
      continue;
    }
    const resolved = guard.resolve(workspace, action.file, { forWrite: true });
    const before = await fs.readFile(resolved.absPath, "utf8");
    const after = applyUpdateToText(before, action.lines);
    if (Buffer.byteLength(after, "utf8") > config.maxWriteBytes) {
      throw new LeastError(`Patched file too large: ${action.file}`);
    }
    if (hasSecretValue(after)) throw new LeastError("Secret-looking content is blocked from patch edit.");
    const targetPath = action.moveTo ? guard.resolve(workspace, action.moveTo, { forWrite: true }) : resolved;
    const diff = await makeUnifiedDiffMaybeOffloaded(before, after, targetPath.relPath);
    additions += diff.additions;
    deletions += diff.deletions;
    diffs.push(diff.diff);
    changedFiles.push(targetPath.relPath);
    if (!options.checkOnly) {
      if (action.moveTo && targetPath.absPath !== resolved.absPath) {
        await fs.mkdir(path.dirname(targetPath.absPath), { recursive: true });
        await fs.writeFile(targetPath.absPath, after, "utf8");
        await fs.unlink(resolved.absPath);
      } else {
        await fs.writeFile(resolved.absPath, after, "utf8");
      }
    }
  }

  return {
    changedFiles,
    additions,
    deletions,
    diff: diffs.join("\n\n")
  };
}
