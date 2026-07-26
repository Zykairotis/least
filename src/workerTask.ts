import { parentPort } from "node:worker_threads";

type WorkerTask =
  | {
      kind: "unifiedDiff";
      oldText: string;
      newText: string;
      relPath: string;
      maxChars: number;
    }
  | {
      kind: "projectMapChunk";
      files: Array<{ path: string; text: string }>;
      includeImports: boolean;
      includeExports: boolean;
    };

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function makeUnifiedDiff(oldText: string, newText: string, relPath: string, maxChars = 60_000) {
  if (oldText === newText) {
    return { diff: `No changes in ${relPath}.`, additions: 0, deletions: 0, changed: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const coreOldStart = prefix;
  const coreOldEnd = oldLines.length - suffix;
  const coreNewStart = prefix;
  const coreNewEnd = newLines.length - suffix;
  const context = 3;
  const oldStart = Math.max(0, coreOldStart - context);
  const oldEnd = Math.min(oldLines.length, coreOldEnd + context);
  const newStart = Math.max(0, coreNewStart - context);
  const newEnd = Math.min(newLines.length, coreNewEnd + context);

  const additions = Math.max(0, coreNewEnd - coreNewStart);
  const deletions = Math.max(0, coreOldEnd - coreOldStart);
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`];

  for (let i = oldStart; i < coreOldStart; i += 1) out.push(` ${oldLines[i]}`);
  for (let i = coreOldStart; i < coreOldEnd; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = coreNewStart; i < coreNewEnd; i += 1) out.push(`+${newLines[i]}`);
  for (let i = coreOldEnd; i < oldEnd; i += 1) out.push(` ${oldLines[i]}`);

  let diff = out.join("\n");
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars) + `\n...[diff truncated to ${maxChars} chars]`;
  }
  return { diff, additions, deletions, changed: true };
}

function parseSymbols(
  relPath: string,
  text: string,
  options: { includeImports: boolean; includeExports: boolean }
): Array<{ name: string; kind: string; path: string; line?: number }> {
  const symbols: Array<{ name: string; kind: string; path: string; line?: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    const exportFn = line.match(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (exportFn && options.includeExports) symbols.push({ name: exportFn[1] ?? "unknown", kind: "function", path: relPath, line: lineNo });
    const cls = line.match(/export\s+class\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+)/);
    if (cls) symbols.push({ name: cls[1] ?? cls[2] ?? "unknown", kind: "class", path: relPath, line: lineNo });
    const iface = line.match(/export\s+interface\s+([A-Za-z0-9_]+)/);
    if (iface && options.includeExports) symbols.push({ name: iface[1] ?? "unknown", kind: "interface", path: relPath, line: lineNo });
    const type = line.match(/export\s+type\s+([A-Za-z0-9_]+)/);
    if (type && options.includeExports) symbols.push({ name: type[1] ?? "unknown", kind: "type", path: relPath, line: lineNo });
    const constant = line.match(/export\s+const\s+([A-Za-z0-9_]+)/);
    if (constant && options.includeExports) symbols.push({ name: constant[1] ?? "unknown", kind: "const", path: relPath, line: lineNo });
    const route = line.match(/["'`]\/[A-Za-z0-9/_:-]+["'`]/);
    if (route) symbols.push({ name: route[0].slice(1, -1), kind: "route", path: relPath, line: lineNo });
    const imported = line.match(/import\s+.*?from\s+["'](.+?)["']/);
    if (imported && options.includeImports) symbols.push({ name: imported[1] ?? "unknown", kind: "import", path: relPath, line: lineNo });
  }
  return symbols;
}

if (!parentPort) {
  throw new Error("workerTask requires a parent port.");
}

parentPort.on("message", (message: WorkerTask) => {
  try {
    if (message.kind === "unifiedDiff") {
      parentPort?.postMessage(makeUnifiedDiff(message.oldText, message.newText, message.relPath, message.maxChars));
      return;
    }
    if (message.kind === "projectMapChunk") {
      const symbols = message.files.flatMap((file) =>
        parseSymbols(file.path, file.text, {
          includeImports: message.includeImports,
          includeExports: message.includeExports
        })
      );
      parentPort?.postMessage(symbols);
      return;
    }
    throw new Error(`Unknown worker task: ${(message as { kind?: string }).kind ?? "unknown"}`);
  } catch (error) {
    parentPort?.postMessage({ __workerError: error instanceof Error ? error.message : String(error) });
  }
});
