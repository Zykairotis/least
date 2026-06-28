import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeastSettingsSchema, type LeastSettings } from "./settingsSchema.js";

export interface LoadedSettings {
  /** The merged effective settings. */
  effective: LeastSettings;
  /** Files that were loaded successfully. */
  loadedFiles: string[];
  /** Files that were searched but not found (not an error). */
  missingFiles: string[];
  /** Any warning messages emitted during load. */
  warnings: string[];
}

// ── JSONC parsing: strip line and block comments ────────────────

const JSONC_LINE_COMMENT = /\/\/.*$/gm;
const JSONC_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

function parseJsonc(text: string): unknown {
  const cleaned = text.replace(JSONC_LINE_COMMENT, "").replace(JSONC_BLOCK_COMMENT, "");
  return JSON.parse(cleaned);
}

// ── Deep merge (simple two-object, no arrays) ───────────────────

function mergeSettings(a: LeastSettings, b: LeastSettings): LeastSettings {
  const result: LeastSettings = { ...a };

  for (const key of Object.keys(b) as (keyof LeastSettings)[]) {
    const bv = b[key];
    if (bv === undefined) continue;
    const av = a[key];
    if (av === undefined || typeof bv !== "object" || bv === null || Array.isArray(bv)) {
      // Scalar or array → b wins (last writer wins for scalars)
      (result as Record<string, unknown>)[key] = bv;
    } else {
      // Object → shallow merge of top-level fields
      (result as Record<string, unknown>)[key] = { ...(av as Record<string, unknown>), ...(bv as Record<string, unknown>) };
    }
  }
  return result;
}

// ── Path helpers ────────────────────────────────────────────────

function resolveSettingsPath(filePath: string, workspaceRoot: string | undefined): string {
  const expanded = filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
  if (workspaceRoot && !path.isAbsolute(expanded)) {
    return path.resolve(workspaceRoot, expanded);
  }
  return path.resolve(expanded);
}

// ── Safe read ───────────────────────────────────────────────────

interface ReadResult {
  content: LeastSettings | null;
  error: string | null;
}

function tryReadFile(filePath: string, warnOnUnknownKeys: boolean): ReadResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { content: null, error: null };
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return { content: null, error: `${filePath} is empty` };
    }
    const parsed = parseJsonc(raw);
    const result = LeastSettingsSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return { content: null, error: `${filePath}: ${issues}` };
    }
    return { content: result.data, error: null };
  } catch (err) {
    return { content: null, error: `${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Settings paths ──────────────────────────────────────────────

function userSettingsPath(): string {
  return path.join(os.homedir(), ".least", "settings.json");
}

function projectSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".least", "settings.json");
}

function localSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".least", "settings.local.json");
}

// ── Public API ──────────────────────────────────────────────────

export function loadSettings(options: {
  workspaceRoot?: string;
  warnOnUnknownKeys?: boolean;
} = {}): LoadedSettings {
  const { workspaceRoot, warnOnUnknownKeys = true } = options;

  const loadedFiles: string[] = [];
  const missingFiles: string[] = [];
  const warnings: string[] = [];

  let effective: LeastSettings = {};
  const layers: string[] = [];

  // Layer 1: user settings (~/.least/settings.json)
  const userPath = userSettingsPath();
  layers.push(userPath);

  // Layer 2: project settings (<workspace>/.least/settings.json)
  let projPath: string | undefined;
  if (workspaceRoot) {
    projPath = projectSettingsPath(workspaceRoot);
    layers.push(projPath);
  }

  // Layer 3: local settings (<workspace>/.least/settings.local.json)
  let localPath: string | undefined;
  if (workspaceRoot) {
    localPath = localSettingsPath(workspaceRoot);
    layers.push(localPath);
  }

  for (const layerPath of layers) {
    const { content, error } = tryReadFile(layerPath, warnOnUnknownKeys);
    if (error) {
      warnings.push(error);
      continue;
    }
    if (content === null) {
      missingFiles.push(layerPath);
      continue;
    }
    loadedFiles.push(layerPath);
    effective = mergeSettings(effective, content);
  }

  // Resolve path references in settings (expand ~, make relative paths absolute)
  effective = resolveSettingPaths(effective, workspaceRoot);

  return { effective, loadedFiles, missingFiles, warnings };
}

function resolveSettingPaths(settings: LeastSettings, workspaceRoot: string | undefined): LeastSettings {
  const resolve = (p: string) => resolveSettingsPath(p, workspaceRoot);
  const s = { ...settings };

  // Resolve skills manifest paths
  if (s.skills) {
    const sk = { ...s.skills };
    if (sk.manifest) sk.manifest = resolve(sk.manifest);
    if (sk.manifests) sk.manifests = sk.manifests.map(resolve);
    s.skills = sk;
  }

  // Resolve hooks paths — workspace-relative commands resolve within workspace
  if (s.hooks) {
    const hk = { ...s.hooks };
    for (const eventKey of ["PreToolUse", "PostToolUse", "ToolError", "WorkspaceOpen", "ConfigLoad", "ConfigChange", "PreBash", "PostBash", "PreRead", "PostRead", "PreWrite", "PostWrite", "PreEdit", "PostEdit", "LockAcquired", "LockReleased"] as const) {
      const specs = (hk as Record<string, unknown>)[eventKey];
      if (Array.isArray(specs)) {
        (hk as Record<string, unknown>)[eventKey] = specs.map((spec: Record<string, unknown>) => {
          if (typeof spec.command === "string") {
            return { ...spec, command: resolve(spec.command) };
          }
          return spec;
        });
      }
    }
    s.hooks = hk;
  }

  return s;
}

/** Default settings when no files exist. */
export function defaultSettings(): LeastSettings {
  return {};
}

export { userSettingsPath, projectSettingsPath, localSettingsPath };
