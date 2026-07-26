import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "./guard.js";
import type { LeastConfig } from "./config.js";
import { collectManifestRoots } from "./skillManifest.js";
import { discoverAgentSupport, type AgentDiscoverySummary } from "./agentDiscovery.js";

export interface SkillInventoryItem {
  name: string;
  description: string | undefined;
  source: "workspace" | "user" | "plugin" | "external" | "other";
  path: string;
}

interface SkillInventoryRecord extends SkillInventoryItem {
  absPath: string;
}

interface CachedSkillDiscovery {
  records: SkillInventoryRecord[];
  expiresAt: number;
}

export interface LoadedSkill {
  skill: SkillInventoryItem;
  text: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface McpServerInventoryItem {
  name: string;
  source: string;
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}

const skillDiscoveryCache = new Map<string, CachedSkillDiscovery>();
const SKILL_DISCOVERY_TTL_MS = 30_000;

async function safeReadText(file: string, maxBytes = 16_000): Promise<string> {
  try {
    const stat = await fs.promises.stat(file);
    const len = Math.min(stat.size, maxBytes);
    const fd = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, 0);
      return buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return "";
  }
}

async function readTextWithStats(file: string, maxBytes: number): Promise<{ text: string; bytes: number; totalBytes: number; truncated: boolean }> {
  const stat = await fs.promises.stat(file);
  const totalBytes = stat.size;
  const truncated = totalBytes > maxBytes;
  const text = await safeReadText(file, maxBytes);
  return { text, bytes: Buffer.byteLength(text, "utf8"), totalBytes, truncated };
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function displayPath(absPath: string, workspaceRoot: string): string {
  const home = os.homedir();
  if (absPath === workspaceRoot) return "$WORKSPACE";
  if (absPath.startsWith(workspaceRoot + path.sep)) {
    return `$WORKSPACE/${path.relative(workspaceRoot, absPath).split(path.sep).join("/")}`;
  }
  if (absPath === home) return "~";
  if (absPath.startsWith(home + path.sep)) {
    return `~/${path.relative(home, absPath).split(path.sep).join("/")}`;
  }
  return absPath;
}

function normalizeRequestedSkillPath(value: string | undefined, workspaceRoot: string): string | undefined {
  const requested = value?.trim();
  if (!requested) return undefined;
  if (requested.startsWith("$WORKSPACE/")) return requested;
  if (requested === "$WORKSPACE") return requested;
  if (requested.startsWith("~/")) return displayPath(path.join(os.homedir(), requested.slice(2)), workspaceRoot);
  const windowsAbs = /^[A-Za-z]:[\\/]/.test(requested);
  const abs = path.isAbsolute(requested) || windowsAbs ? path.normalize(requested) : path.resolve(workspaceRoot, requested);
  return displayPath(abs, workspaceRoot);
}

function skillSource(skillPath: string, workspaceRoot: string): SkillInventoryItem["source"] {
  if (skillPath.startsWith(`${workspaceRoot}${path.sep}`)) return "workspace";
  if (skillPath.includes(`${path.sep}.codex${path.sep}plugins${path.sep}`)) return "plugin";
  if (skillPath.startsWith(`${os.homedir()}${path.sep}`)) return "user";
  return "other";
}

function skillSourceRank(source: SkillInventoryItem["source"]): number {
  if (source === "workspace") return 0;
  if (source === "user") return 1;
  if (source === "plugin") return 2;
  return 3;
}

function compareSkills(a: SkillInventoryItem, b: SkillInventoryItem): number {
  return (
    skillSourceRank(a.source) - skillSourceRank(b.source) ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path)
  );
}

function publicSkill(record: SkillInventoryRecord): SkillInventoryItem {
  return {
    name: record.name,
    description: record.description,
    source: record.source,
    path: record.path
  };
}

function frontmatterValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

async function findSkillFiles(root: string, maxDepth: number, out: string[], maxItems: number): Promise<void> {
  if (out.length >= maxItems || maxDepth < 0) return;
  const entries = await safeReaddir(root);
  for (const entry of entries) {
    if (out.length >= maxItems) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(abs);
      continue;
    }
    if (entry.isDirectory()) {
      await findSkillFiles(abs, maxDepth - 1, out, maxItems);
    }
  }
}

async function discoverSkillRecords(
  workspace: Workspace,
  config?: LeastConfig,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryRecord[]> {
  const maxSkills = Math.max(1, Math.min(options.maxSkills ?? 120, 500));
  const cacheKey = JSON.stringify({
    workspaceId: workspace.id,
    includeGlobal: options.includeGlobal !== false,
    maxSkills
  });
  const cached = skillDiscoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.records.map((record) => ({ ...record }));
  }
  const workspaceRoots = [
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, ".agents", "skills"),
    path.join(workspace.root, "skills")
  ].filter((dir) => fs.existsSync(dir));
  const globalRoots = options.includeGlobal
    ? [
        path.join(os.homedir(), ".codex", "skills"),
        path.join(os.homedir(), ".agents", "skills"),
        path.join(os.homedir(), ".codex", "plugins", "cache")
      ]
        .filter((dir) => fs.existsSync(dir))
        .sort((a, b) => a.localeCompare(b))
    : [];
  const roots = [...workspaceRoots, ...globalRoots];

  // Add manifest-derived skill roots from settings
  if (config?.settings) {
    const manifest = collectManifestRoots(config.settings, workspace.root);
    for (const root of manifest.roots) {
      if (fs.existsSync(root) && !roots.includes(root)) {
        roots.push(root);
      }
    }
  }

  const skillFiles: string[] = [];
  for (const root of roots) {
    await findSkillFiles(root, root.includes(`${path.sep}plugins${path.sep}cache`) ? 9 : 3, skillFiles, maxSkills);
    if (skillFiles.length >= maxSkills) break;
  }
  skillFiles.sort((a, b) => a.localeCompare(b));

  const items: SkillInventoryRecord[] = [];
  for (const file of skillFiles.slice(0, maxSkills)) {
    let text = "";
    try {
      text = await safeReadText(file);
    } catch {
      // Keep the skill visible even if the file cannot be read.
    }
    const name = frontmatterValue(text, "name") ?? path.basename(path.dirname(file));
    const description = frontmatterValue(text, "description");
    items.push({
      name,
      description,
      source: skillSource(file, workspace.root),
      path: displayPath(file, workspace.root),
      absPath: file
    });
  }

  const records = unique(items, (item) => `${item.source}:${item.name}:${item.path}`).sort(compareSkills);
  skillDiscoveryCache.set(cacheKey, {
    records: records.map((record) => ({ ...record })),
    expiresAt: Date.now() + SKILL_DISCOVERY_TTL_MS
  });
  return records;
}

export async function discoverSkillInventory(
  workspace: Workspace,
  config?: LeastConfig,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryItem[]> {
  return (await discoverSkillRecords(workspace, config, options)).map(publicSkill);
}

export async function loadSkill(
  workspace: Workspace,
  config: LeastConfig,
  options: {
    name: string;
    source?: SkillInventoryItem["source"];
    path?: string;
    includeGlobal?: boolean;
    maxSkills?: number;
    maxBytes?: number;
  }
): Promise<LoadedSkill> {
  const name = options.name.trim();
  if (!name) throw new Error("Skill name is required.");
  const requestedPath = normalizeRequestedSkillPath(options.path, workspace.root);

  const records = await discoverSkillRecords(workspace, config, {
    includeGlobal: options.includeGlobal !== false,
    maxSkills: options.maxSkills ?? 500
  });
  const requestedPaths = requestedPath ? [requestedPath, `${requestedPath.replace(/\/$/, "")}/SKILL.md`] : [];
  const matches = records.filter(
    (skill) =>
      skill.name === name &&
      (!options.source || skill.source === options.source) &&
      (!requestedPath || requestedPaths.includes(skill.path))
  );
  if (!matches.length) {
    const near = records
      .filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, 8)
      .map((skill) => `${skill.name} [${skill.source}]`)
      .join(", ");
    const suffix = requestedPath ? ` at ${requestedPath}` : "";
    throw new Error(`Skill not found: ${name}${suffix}${near ? `. Similar skills: ${near}` : ""}`);
  }
  if (matches.length > 1) {
    const choices = matches.map((skill) => `${skill.name} [${skill.source}] at ${skill.path}`).join("; ");
    throw new Error(`Multiple skills named ${name} were found. Pass source and path to choose one: ${choices}`);
  }

  const [skill] = matches;
  if (path.basename(skill.absPath) !== "SKILL.md") {
    throw new Error(`Refusing to load non-skill file: ${skill.path}`);
  }
  const maxBytes = Math.max(1_000, Math.min(options.maxBytes ?? 40_000, 100_000));
  const loaded = await readTextWithStats(skill.absPath, maxBytes);
  return {
    skill: publicSkill(skill),
    text: loaded.text,
    bytes: loaded.bytes,
    totalBytes: loaded.totalBytes,
    truncated: loaded.truncated
  };
}

function parseTomlMcpServers(text: string, source: string): McpServerInventoryItem[] {
  const out: McpServerInventoryItem[] = [];
  const re = /^\s*\[(?:mcp_servers|mcpServers)\.("?)([^"\].]+)\1\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({ name: match[2], source });
  }
  return out;
}

function parseJsonMcpServers(text: string, source: string): McpServerInventoryItem[] {
  try {
    const parsed = JSON.parse(text);
    const servers = parsed?.mcpServers;
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
      return Object.keys(servers).map((name) => ({ name, source }));
    }
  } catch {
    // Not JSON.
  }
  return [];
}

export async function discoverMcpServers(workspace: Workspace): Promise<McpServerInventoryItem[]> {
  const candidates = [
    { file: path.join(os.homedir(), ".codex", "config.toml"), kind: "toml" },
    { file: path.join(workspace.root, ".mcp.json"), kind: "json" },
    { file: path.join(workspace.root, ".cursor", "mcp.json"), kind: "json" },
    { file: path.join(os.homedir(), ".cursor", "mcp.json"), kind: "json" }
  ];
  const servers: McpServerInventoryItem[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) continue;
    let text = "";
    try {
      text = await safeReadText(candidate.file, 200_000);
    } catch {
      continue;
    }
    const source = displayPath(candidate.file, workspace.root);
    servers.push(...(candidate.kind === "toml" ? parseTomlMcpServers(text, source) : parseJsonMcpServers(text, source)));
  }
  return unique(servers, (server) => `${server.source}:${server.name}`).sort((a, b) => a.name.localeCompare(b.name));
}

export async function leastInventory(
  config: LeastConfig,
  workspace: Workspace,
  options: { includeGlobalSkills?: boolean; includeMcpServers?: boolean; maxSkills?: number } = {}
): Promise<{
  mode: string;
  skills: SkillInventoryItem[];
  mcpServers: McpServerInventoryItem[];
  agentSupport: AgentDiscoverySummary;
  text: string;
}> {
  const skills = await discoverSkillInventory(workspace, config, {
    includeGlobal: options.includeGlobalSkills !== false,
    maxSkills: options.maxSkills
  });
  const mcpServers = options.includeMcpServers !== false ? await discoverMcpServers(workspace) : [];
  const agentSupport = await discoverAgentSupport(workspace);
  const skillList = skills.slice(0, 40).map((s) => `  - ${s.name}${s.description ? `: ${s.description}` : ""} [${s.source}]`).join("\n");
  const mcpList = mcpServers.slice(0, 20).map((s) => `  - ${s.name} [${s.source}]`).join("\n");
  const text = [
    `# Least Inventory\n\nSkills (${skills.length}):`,
    skillList || "  (none)",
    mcpServers.length ? `\nMCP Servers (${mcpServers.length}):\n${mcpList}` : "\nMCP Servers: (none)",
    agentSupport.available
      ? `\nLocal Agents (${agentSupport.enabledProfiles.length}):\n  - enabled: ${agentSupport.enabledProfiles.join(", ")}\n  - direct tools: ${agentSupport.directTools.join(", ")}\n  - use direct agent_* tools first when visible\n  - fallback doctor: ${agentSupport.cliBridgeDoctor}\n  - fallback start: ${agentSupport.cliBridgeStartExample}`
      : "\nLocal Agents: (none enabled)",
    "\nUse load_skill to inspect a skill body."
  ].join("\n");
  return { mode: "active", skills, mcpServers, agentSupport, text };
}
