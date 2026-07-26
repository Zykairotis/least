import fsp from "node:fs/promises";
import path from "node:path";
import type { LeastConfig } from "./config.js";
import { mapWithConcurrency } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { listWorkspaceFiles } from "./filesOps.js";
import { offloadedProjectMapSymbols, shouldOffloadProjectMap } from "./workerOps.js";
import { readTextWithSnapshot } from "./fileSnapshotCache.js";

export type ProjectSymbolKind = "function" | "class" | "type" | "interface" | "const" | "route" | "import";

export interface ProjectSymbol {
  name: string;
  kind: ProjectSymbolKind;
  path: string;
  line?: number;
}

export interface ProjectRelationship {
  from: string;
  to: string;
  kind: "imports" | "tests";
  confidence: "strong";
}

export interface ProjectImpact {
  changedPaths: string[];
  affectedAreas: string[];
  dependentFiles: Array<{ path: string; reasons: string[] }>;
  relatedTests: Array<{ path: string; reasons: string[] }>;
  riskSignals: Array<{ id: string; paths: string[] }>;
  recommendedCommands: string[];
  truncated: boolean;
}

export interface ProjectMapResult {
  text: string;
  files: string[];
  symbols: ProjectSymbol[];
  relationships: ProjectRelationship[];
  entrypoints: string[];
  projectTypes: string[];
  impact?: ProjectImpact;
  packageContext?: Record<string, unknown>;
  cached: boolean;
}

export interface ProjectMapOptions {
  refresh?: boolean;
  globs?: string[];
  includeImports?: boolean;
  includeExports?: boolean;
  includeTests?: boolean;
  changedPaths?: string[];
}

interface CachedProjectMap {
  key: string;
  createdAt: number;
  value: ProjectMapResult;
  dirtyPaths: Set<string>;
}

const cache = new Map<string, CachedProjectMap>();
const PROJECT_MAP_READ_CONCURRENCY = 8;

function cacheKey(workspace: Workspace, options: ProjectMapOptions): string {
  return `${workspace.id}:${JSON.stringify({
    globs: options.globs ?? [],
    includeImports: options.includeImports !== false,
    includeExports: options.includeExports !== false,
    includeTests: options.includeTests !== false,
    changedPaths: [...(options.changedPaths ?? [])].sort()
  })}`;
}

function resolveImport(importer: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const stem = joined.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/, "");
  const candidates = [
    joined,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].flatMap((extension) => [`${joined}${extension}`, `${stem}${extension}`]),
    ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"].flatMap((name) => [`${joined}/${name}`, `${stem}/${name}`])
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function buildRelationships(files: string[], symbols: ProjectSymbol[]): ProjectRelationship[] {
  const fileSet = new Set(files);
  const seen = new Set<string>();
  const relationships: ProjectRelationship[] = [];
  for (const symbol of symbols) {
    if (symbol.kind !== "import") continue;
    const target = resolveImport(symbol.path, symbol.name, fileSet);
    if (!target) continue;
    const kind = /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(test|spec)\./i.test(symbol.path) ? "tests" : "imports";
    const key = `${symbol.path}\0${target}\0${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push({ from: symbol.path, to: target, kind, confidence: "strong" });
  }
  return relationships;
}

function projectTypes(files: string[]): string[] {
  const markers: Array<[string, string]> = [
    ["package.json", "node"], ["tsconfig.json", "typescript"], ["pyproject.toml", "python"],
    ["Cargo.toml", "rust"], ["go.mod", "go"], ["pom.xml", "java"], ["Package.swift", "swift"]
  ];
  return markers.filter(([marker]) => files.some((file) => file === marker || file.endsWith(`/${marker}`))).map(([, type]) => type);
}

function entrypoints(files: string[]): string[] {
  return files.filter((file) => /(^|\/)(index|main|server|app|cli)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(file)).slice(0, 100);
}

function riskSignals(changedPaths: string[]): Array<{ id: string; paths: string[] }> {
  const patterns: Array<[string, RegExp]> = [
    ["public-api", /(^|\/)(api|routes?|public)(\/|\.|$)|\.d\.ts$/i],
    ["authentication", /auth|login|session|token|oauth/i],
    ["storage", /database|storage|repository|sqlite|postgres|redis/i],
    ["migration", /migration|schema/i],
    ["build", /package\.json|lock|tsconfig|vite|webpack|Dockerfile|\.github\/workflows/i],
    ["configuration", /(^|\/)(config|settings|\.env)(\.|\/|$)/i]
  ];
  return patterns.map(([id, pattern]) => ({ id, paths: changedPaths.filter((file) => pattern.test(file)) })).filter((item) => item.paths.length);
}

function recommendedCommands(packageContext: Record<string, unknown> | undefined, types: string[]): string[] {
  const scripts = packageContext?.scripts && typeof packageContext.scripts === "object" ? packageContext.scripts as Record<string, unknown> : {};
  const commands = ["test", "typecheck", "lint", "build"].filter((name) => typeof scripts[name] === "string").map((name) => name === "test" ? "npm test" : `npm run ${name}`);
  if (types.includes("go")) commands.push("go test ./...");
  if (types.includes("rust")) commands.push("cargo test");
  if (types.includes("python")) commands.push("python3 -m pytest");
  return commands;
}

function analyzeImpact(changedPaths: string[], files: string[], relationships: ProjectRelationship[], packageContext: Record<string, unknown> | undefined, types: string[], limit: number): ProjectImpact {
  const normalized = [...new Set(changedPaths.map((item) => item.replace(/\\/g, "/")))].filter((item) => files.includes(item));
  const changed = new Set(normalized);
  const reasons = new Map<string, Set<string>>();
  let frontier = [...normalized];
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const relationship of relationships) {
      if (!frontier.includes(relationship.to) || changed.has(relationship.from)) continue;
      changed.add(relationship.from);
      next.push(relationship.from);
      const current = reasons.get(relationship.from) ?? new Set<string>();
      current.add(`${relationship.kind} ${relationship.to}`);
      reasons.set(relationship.from, current);
    }
    frontier = next;
  }
  const impacted = [...reasons.entries()].map(([file, why]) => ({ path: file, reasons: [...why] }));
  const tests = impacted.filter((item) => relationships.some((edge) => edge.from === item.path && edge.kind === "tests"));
  const dependents = impacted.filter((item) => !tests.includes(item));
  const truncated = dependents.length > limit || tests.length > limit;
  return {
    changedPaths: normalized,
    affectedAreas: [...new Set(normalized.map((file) => file.includes("/") ? file.split("/")[0]! : "."))].sort(),
    dependentFiles: dependents.slice(0, limit),
    relatedTests: tests.slice(0, limit),
    riskSignals: riskSignals(normalized),
    recommendedCommands: recommendedCommands(packageContext, types),
    truncated
  };
}

function renderProjectMap(value: Omit<ProjectMapResult, "text" | "cached">): string {
  return [
    "# Project Map", "", `Files scanned: ${value.files.length}`, `Symbols: ${value.symbols.length}`,
    `Relationships: ${value.relationships.length}`, `Project types: ${value.projectTypes.join(", ") || "unknown"}`,
    `Entrypoints: ${value.entrypoints.join(", ") || "none detected"}`,
    ...(value.impact ? ["", "## Change Impact", `Changed: ${value.impact.changedPaths.join(", ") || "none"}`, `Dependents: ${value.impact.dependentFiles.length}`, `Related tests: ${value.impact.relatedTests.length}`, `Risk signals: ${value.impact.riskSignals.map((item) => item.id).join(", ") || "none"}`, `Recommended: ${value.impact.recommendedCommands.join("; ") || "none detected"}`] : []),
    "", "## Symbols", value.symbols.slice(0, 400).map((symbol) => `${symbol.kind.padEnd(10, " ")} ${symbol.name} ${symbol.path}${symbol.line ? `:${symbol.line}` : ""}`).join("\n") || "No symbols found."
  ].join("\n");
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
  if (cached?.dirtyPaths.size && !options.refresh) {
    for (const relPath of cached.dirtyPaths) {
      cached.value.symbols = cached.value.symbols.filter((symbol) => symbol.path !== relPath);
      const resolved = guard.resolve(workspace, relPath);
      try {
        const text = (await readTextWithSnapshot(resolved.absPath, { maxBytes: config.maxReadBytes })).text;
        cached.value.symbols.push(...parseSymbols(relPath, text, options));
        if (!cached.value.files.includes(relPath)) cached.value.files.push(relPath);
      } catch {
        cached.value.files = cached.value.files.filter((file) => file !== relPath);
      }
    }
    cached.value.files.sort((a, b) => a.localeCompare(b));
    cached.value.symbols.sort((left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
    cached.value.relationships = buildRelationships(cached.value.files, cached.value.symbols);
    cached.value.impact = options.changedPaths?.length ? analyzeImpact(options.changedPaths, cached.value.files, cached.value.relationships, cached.value.packageContext, cached.value.projectTypes, config.maxSearchResults) : undefined;
    cached.value.text = renderProjectMap(cached.value);
    cached.dirtyPaths.clear();
    cached.createdAt = Date.now();
  }
  // Keep project map warm longer; mutations invalidate selectively via invalidateProjectMap.
  if (cached && !options.refresh && Date.now() - cached.createdAt < 60_000) {
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
        const text = (await readTextWithSnapshot(resolved.absPath, { maxBytes: config.maxReadBytes })).text;
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
      const raw = (await readTextWithSnapshot(resolved.absPath, { maxBytes: config.maxReadBytes })).text;
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
  const relationships = buildRelationships(files, symbols);
  const detectedTypes = projectTypes(files);
  const detectedEntrypoints = entrypoints(files);
  const impact = options.changedPaths?.length ? analyzeImpact(options.changedPaths, files, relationships, packageContext, detectedTypes, config.maxSearchResults) : undefined;
  const partial = { files, symbols, relationships, entrypoints: detectedEntrypoints, projectTypes: detectedTypes, packageContext, impact };
  const value: ProjectMapResult = { ...partial, text: renderProjectMap(partial), cached: false };
  cache.set(key, { key, createdAt: Date.now(), value, dirtyPaths: new Set() });
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

export function invalidateProjectMap(workspaceId?: string, changedPaths?: string[]): void {
  if (!workspaceId) {
    cache.clear();
    return;
  }
  for (const [key, entry] of [...cache]) {
    if (!key.startsWith(`${workspaceId}:`)) continue;
    if (!changedPaths?.length) {
      cache.delete(key);
      continue;
    }
    for (const changedPath of changedPaths) entry.dirtyPaths.add(changedPath.replace(/\\/g, "/"));
  }
}
