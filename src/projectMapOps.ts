import fsp from "node:fs/promises";
import path from "node:path";
import type { LeastConfig } from "./config.js";
import { mapWithConcurrency } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { listWorkspaceFiles } from "./filesOps.js";
import { offloadedProjectMapSymbols, shouldOffloadProjectMap } from "./workerOps.js";

export type ProjectSymbolKind = "function" | "class" | "type" | "interface" | "const" | "route" | "import";

export interface ProjectSymbol {
  name: string;
  kind: ProjectSymbolKind;
  path: string;
  line?: number;
}

export interface ProjectMapResult {
  text: string;
  files: string[];
  symbols: ProjectSymbol[];
  packageContext?: Record<string, unknown>;
  cached: boolean;
}

export interface ProjectMapOptions {
  refresh?: boolean;
  globs?: string[];
  includeImports?: boolean;
  includeExports?: boolean;
  includeTests?: boolean;
}

interface CachedProjectMap {
  key: string;
  createdAt: number;
  value: ProjectMapResult;
}

const cache = new Map<string, CachedProjectMap>();
const PROJECT_MAP_READ_CONCURRENCY = 8;

function cacheKey(workspace: Workspace, options: ProjectMapOptions): string {
  return `${workspace.id}:${JSON.stringify({
    globs: options.globs ?? [],
    includeImports: options.includeImports !== false,
    includeExports: options.includeExports !== false,
    includeTests: options.includeTests !== false
  })}`;
}

function parseSymbols(relPath: string, text: string, options: ProjectMapOptions): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    const exportFn = line.match(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (exportFn && options.includeExports !== false) symbols.push({ name: exportFn[1] ?? "unknown", kind: "function", path: relPath, line: lineNo });
    const cls = line.match(/export\s+class\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+)/);
    if (cls) symbols.push({ name: cls[1] ?? cls[2] ?? "unknown", kind: "class", path: relPath, line: lineNo });
    const iface = line.match(/export\s+interface\s+([A-Za-z0-9_]+)/);
    if (iface && options.includeExports !== false) symbols.push({ name: iface[1] ?? "unknown", kind: "interface", path: relPath, line: lineNo });
    const type = line.match(/export\s+type\s+([A-Za-z0-9_]+)/);
    if (type && options.includeExports !== false) symbols.push({ name: type[1] ?? "unknown", kind: "type", path: relPath, line: lineNo });
    const constant = line.match(/export\s+const\s+([A-Za-z0-9_]+)/);
    if (constant && options.includeExports !== false) symbols.push({ name: constant[1] ?? "unknown", kind: "const", path: relPath, line: lineNo });
    const route = line.match(/["'`]\/[A-Za-z0-9/_:-]+["'`]/);
    if (route) symbols.push({ name: route[0].slice(1, -1), kind: "route", path: relPath, line: lineNo });
    const imported = line.match(/import\s+.*?from\s+["'](.+?)["']/);
    if (imported && options.includeImports !== false) symbols.push({ name: imported[1] ?? "unknown", kind: "import", path: relPath, line: lineNo });
  }
  return symbols;
}

export async function buildProjectMap(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ProjectMapOptions = {}
): Promise<ProjectMapResult> {
  const key = cacheKey(workspace, options);
  const cached = cache.get(key);
  if (cached && !options.refresh && Date.now() - cached.createdAt < 10_000) {
    return { ...cached.value, cached: true };
  }
  const defaultGlob = "**/*.{ts,tsx,js,jsx,mjs,cjs,json}";
  const filesListed = await listWorkspaceFiles(config, guard, workspace, {
    glob: options.globs?.length ? undefined : defaultGlob,
    maxResults: 2_000,
    trackedOnly: false,
    includeHidden: false
  });
  let files = filesListed.files;
  if (options.globs?.length) {
    const matched = new Set<string>();
    for (const glob of [...options.globs].sort((a, b) => a.localeCompare(b))) {
      const subset = await listWorkspaceFiles(config, guard, workspace, { glob, maxResults: 2_000, trackedOnly: false, includeHidden: false });
      for (const file of subset.files) matched.add(file);
    }
    files = [...matched].sort((a, b) => a.localeCompare(b));
  }
  if (options.includeTests === false) {
    files = files.filter((file) => !file.includes(".test.") && !file.includes(".spec.") && !file.includes("/__tests__/"));
  }
  files = files.slice(0, 1_000);
  const symbols: ProjectSymbol[] = [];
  const fileResults = await mapWithConcurrency(
    files,
    Math.min(16, Math.max(1, PROJECT_MAP_READ_CONCURRENCY)),
    async (relPath) => {
      const resolved = guard.resolve(workspace, relPath);
      try {
        const stat = await fsp.stat(resolved.absPath);
        if (!stat.isFile() || stat.size > config.maxReadBytes) return undefined;
        const text = await fsp.readFile(resolved.absPath, "utf8");
        return { path: relPath, text, bytes: Buffer.byteLength(text, "utf8") };
      } catch {
        return undefined;
      }
    }
  );
  const fileTexts: Array<{ path: string; text: string }> = [];
  let totalBytes = 0;
  for (const result of fileResults) {
    if (!result) continue;
    fileTexts.push({ path: result.path, text: result.text });
    totalBytes += result.bytes;
  }
  if (shouldOffloadProjectMap(fileTexts.length, totalBytes)) {
    const offloaded = await offloadedProjectMapSymbols(fileTexts, {
      includeImports: options.includeImports !== false,
      includeExports: options.includeExports !== false
    });
    symbols.push(...(offloaded as ProjectSymbol[]));
  } else {
    for (const file of fileTexts) {
      symbols.push(...parseSymbols(file.path, file.text, options));
    }
  }
  symbols.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.kind.localeCompare(right.kind) ||
    left.name.localeCompare(right.name)
  );
  const packageJson = files.find((file) => path.basename(file) === "package.json");
  let packageContext: Record<string, unknown> | undefined;
  if (packageJson) {
    try {
      const resolved = guard.resolve(workspace, packageJson);
      const raw = await fsp.readFile(resolved.absPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      packageContext = {
        name: parsed.name,
        scripts: parsed.scripts,
        dependencies: parsed.dependencies ? Object.keys(parsed.dependencies as Record<string, unknown>).sort((a, b) => a.localeCompare(b)).slice(0, 12) : undefined
      };
    } catch {
      // Ignore invalid package.json.
    }
  }
  const text = [
    "# Project Map",
    "",
    `Files scanned: ${files.length}`,
    `Symbols: ${symbols.length}`,
    "",
    symbols.slice(0, 400).map((symbol) => `${symbol.kind.padEnd(10, " ")} ${symbol.name} ${symbol.path}${symbol.line ? `:${symbol.line}` : ""}`).join("\n") || "No symbols found."
  ].join("\n");
  const value: ProjectMapResult = { text, files, symbols, packageContext, cached: false };
  cache.set(key, { key, createdAt: Date.now(), value });
  return value;
}

function resolveRelativeImport(importerPath: string, specifier: string): string | undefined {
  const normalizedImporter = importerPath.replace(/\\/g, "/");
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  if (!normalizedSpecifier.startsWith("./") && !normalizedSpecifier.startsWith("../")) return undefined;
  const base = path.posix.dirname(normalizedImporter);
  const joined = path.posix.normalize(path.posix.join(base, normalizedSpecifier));
  if (joined.startsWith("..")) return undefined;
  const candidates = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.jsx`, `${joined}/index.ts`, `${joined}/index.tsx`];
  return candidates.find((candidate) => candidate && !candidate.startsWith(".."));
}

export function importNeighborPaths(symbols: ProjectSymbol[], seedPaths: string[], maxNeighbors = 24): string[] {
  const seeds = new Set(seedPaths.map((item) => item.replace(/\\/g, "/")));
  const neighbors = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.kind !== "import") continue;
    const importer = symbol.path.replace(/\\/g, "/");
    if (!seeds.has(importer)) continue;
    const resolved = resolveRelativeImport(importer, symbol.name);
    if (!resolved) continue;
    neighbors.add(resolved);
    if (neighbors.size >= maxNeighbors) break;
  }
  return [...neighbors].slice(0, maxNeighbors);
}

export function invalidateProjectMap(workspaceId?: string): void {
  if (!workspaceId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
  }
}
