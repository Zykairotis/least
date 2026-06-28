import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, type YAMLMap, type YAMLSeq, type Scalar, isMap, isSeq, isScalar } from "yaml";
import type { LeastSettings } from "./settingsSchema.js";
import type { LoadedSettings } from "./settings.js";

// ── Types ───────────────────────────────────────────────────────

export interface SkillManifestSource {
  id: string;
  path: string;
  resolvedPath: string;
  trust: "workspace" | "user" | "local" | "external";
  enabled: boolean;
}

export interface SkillVisibilityOverride {
  visibility: "on" | "name-only" | "user-invocable-only" | "off";
}

export interface SkillManifest {
  version: number;
  sources: SkillManifestSource[];
  overrides: Record<string, SkillVisibilityOverride>;
}

export interface SkillManifestResult {
  manifest: SkillManifest | null;
  roots: string[];
  warnings: string[];
  overrides: Record<string, SkillVisibilityOverride>;
}

// ── Parsing ─────────────────────────────────────────────────────

function yamlValue(node: unknown): unknown {
  if (isScalar(node)) return (node as Scalar).value;
  if (isMap(node)) {
    const obj: Record<string, unknown> = {};
    for (const { key, value } of (node as YAMLMap).items) {
      obj[String(key)] = yamlValue(value);
    }
    return obj;
  }
  if (isSeq(node)) {
    return (node as YAMLSeq).items.map((item) => yamlValue(item));
  }
  return node;
}

export function parseSkillManifest(
  filePath: string,
  settings: LoadedSettings | null,
  workspaceRoot: string
): SkillManifestResult {
  const warnings: string[] = [];
  const manifestPath = resolveManifestPath(filePath, settings, workspaceRoot);

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return { manifest: null, roots: [], warnings: [`Skill manifest not found: ${filePath}`], overrides: {} };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    warnings.push(`Cannot read skill manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { manifest: null, roots: [], warnings, overrides: {} };
  }

  let parsed: unknown;
  try {
    parsed = yamlValue(parseYaml(raw));
  } catch (err) {
    warnings.push(`Invalid YAML in skill manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { manifest: null, roots: [], warnings, overrides: {} };
  }

  if (typeof parsed !== "object" || parsed === null) {
    warnings.push(`Skill manifest ${manifestPath} is not an object`);
    return { manifest: null, roots: [], warnings, overrides: {} };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate version
  if (obj.version !== 1) {
    warnings.push(`Skill manifest ${manifestPath}: expected version 1, got ${String(obj.version)}`);
    return { manifest: null, roots: [], warnings, overrides: {} };
  }

  // Parse sources
  const sources: SkillManifestSource[] = [];
  const rawSources = obj.sources;
  const allowExternal = settings?.effective?.skills?.allowExternalSources ?? false;
  const localAllowExternal = settings?.effective?.skills?.allowExternalSources;

  if (Array.isArray(rawSources)) {
    for (const src of rawSources) {
      if (typeof src !== "object" || src === null) {
        warnings.push(`Skill manifest ${manifestPath}: invalid source entry`);
        continue;
      }
      const s = src as Record<string, unknown>;
      const id = String(s.id ?? "unknown");
      const srcPath = String(s.path ?? "");
      const trust = String(s.trust ?? "workspace");
      const enabled = s.enabled !== false;

      if (!srcPath) {
        warnings.push(`Skill manifest ${manifestPath}: source "${id}" has no path`);
        continue;
      }

      const resolvedPath = resolveSourcePath(srcPath, trust, workspaceRoot);
      const trustType = classifyTrust(srcPath, trust, resolvedPath, workspaceRoot);

      // Check external trust
      if (trustType === "external" && !allowExternal) {
        if (localAllowExternal) {
          // must have explicit allowExternalSources=true in user or local settings
          warnings.push(`Skill manifest ${manifestPath}: external source "${id}" at ${resolvedPath} skipped — allowExternalSources not set`);
          continue;
        }
        warnings.push(`Skill manifest ${manifestPath}: external source "${id}" at ${resolvedPath} skipped — allowExternalSources not set`);
        continue;
      }

      sources.push({
        id,
        path: srcPath,
        resolvedPath,
        trust: trustType,
        enabled
      });
    }
  }

  // Parse overrides
  const overrides: Record<string, SkillVisibilityOverride> = {};
  if (obj.overrides && typeof obj.overrides === "object") {
    const rawOverrides = obj.overrides as Record<string, unknown>;
    for (const [skillName, overrideVal] of Object.entries(rawOverrides)) {
      if (typeof overrideVal === "object" && overrideVal !== null) {
        const ov = overrideVal as Record<string, unknown>;
        const visibility = String(ov.visibility ?? "on") as SkillVisibilityOverride["visibility"];
        if (["on", "name-only", "user-invocable-only", "off"].includes(visibility)) {
          overrides[skillName] = { visibility };
        }
      }
    }
  }

  // Build roots
  const roots: string[] = [];
  const resolvedRoots = new Set<string>();
  for (const source of sources) {
    if (!source.enabled) continue;
    if (resolvedRoots.has(source.resolvedPath)) {
      warnings.push(`Skill manifest ${manifestPath}: duplicate root "${source.resolvedPath}"`);
      continue;
    }
    if (fs.existsSync(source.resolvedPath)) {
      roots.push(source.resolvedPath);
      resolvedRoots.add(source.resolvedPath);
    }
  }

  const manifest: SkillManifest = {
    version: 1,
    sources,
    overrides
  };

  return { manifest, roots, warnings, overrides };
}

function resolveManifestPath(
  filePath: string,
  settings: LoadedSettings | null,
  workspaceRoot: string
): string | undefined {
  // Already absolute
  if (path.isAbsolute(filePath)) return filePath;
  // ~/ means home-relative
  if (filePath.startsWith("~")) return path.join(os.homedir(), filePath.slice(1));
  // Workspace-relative
  return path.resolve(workspaceRoot, filePath);
}

function resolveSourcePath(srcPath: string, trust: string, workspaceRoot: string): string {
  if (path.isAbsolute(srcPath)) return path.resolve(srcPath);
  if (srcPath.startsWith("~")) return path.join(os.homedir(), srcPath.slice(1));
  // workspace-relative
  return path.resolve(workspaceRoot, srcPath);
}

function classifyTrust(
  srcPath: string,
  trust: string,
  resolvedPath: string,
  workspaceRoot: string
): SkillManifestSource["trust"] {
  if (trust === "local" || trust === "user" || trust === "workspace" || trust === "external") {
    return trust as SkillManifestSource["trust"];
  }
  // Auto-classify
  if (resolvedPath.startsWith(workspaceRoot + path.sep)) return "workspace";
  if (resolvedPath.startsWith(os.homedir() + path.sep)) return "user";
  return "external";
}

/** Collect all manifest-derived skill roots from settings. */
export function collectManifestRoots(
  settings: LoadedSettings | null,
  workspaceRoot: string
): { roots: string[]; overrides: Record<string, SkillVisibilityOverride>; warnings: string[] } {
  const skillSettings = settings?.effective?.skills;
  if (!skillSettings) return { roots: [], overrides: {}, warnings: [] };

  const allRoots: string[] = [];
  const allOverrides: Record<string, SkillVisibilityOverride> = {};
  const allWarnings: string[] = [];

  // Collect manifest paths
  const manifestPaths: string[] = [];
  if (skillSettings.manifest) manifestPaths.push(skillSettings.manifest);
  if (skillSettings.manifests) manifestPaths.push(...skillSettings.manifests);

  for (const mp of manifestPaths) {
    const result = parseSkillManifest(mp, settings, workspaceRoot);
    allRoots.push(...result.roots);
    if (result.overrides) Object.assign(allOverrides, result.overrides);
    allWarnings.push(...result.warnings);
  }

  return { roots: [...new Set(allRoots)], overrides: allOverrides, warnings: allWarnings };
}
