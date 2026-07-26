import { z } from "zod";

// ── Permission settings ──────────────────────────────────────────

export const PermissionSettingsSchema = z.object({
  defaultMode: z.enum(["off", "readonly", "safe", "full"]).optional(),
  allow: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  additionalDirectories: z.array(z.string()).optional(),
});
export type PermissionSettings = z.infer<typeof PermissionSettingsSchema>;

// ── Skill settings ───────────────────────────────────────────────

export const SkillSettingsSchema = z.object({
  manifest: z.string().optional(),
  manifests: z.array(z.string()).optional(),
  allowExternalSources: z.boolean().optional(),
  maxSkills: z.number().int().min(1).max(500).optional(),
  defaultVisibility: z.enum(["on", "name-only", "user-invocable-only", "off"]).optional(),
});
export type SkillSettings = z.infer<typeof SkillSettingsSchema>;

// ── Hook spec ────────────────────────────────────────────────────

export const HookSpecSchema = z.object({
  matcher: z.string().optional(),
  type: z.literal("command"),
  command: z.string(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  runIn: z.enum(["workspace", "settings"]).optional(),
});
export type HookSpec = z.infer<typeof HookSpecSchema>;

// ── Hook settings ────────────────────────────────────────────────

export const HookSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  allowProjectHooks: z.boolean().optional(),
  trustedHookCommands: z.array(z.string()).optional(),
  failureMode: z.enum(["safe", "permissive"]).optional(),
  PreToolUse: z.array(HookSpecSchema).optional(),
  PostToolUse: z.array(HookSpecSchema).optional(),
  ToolError: z.array(HookSpecSchema).optional(),
  WorkspaceOpen: z.array(HookSpecSchema).optional(),
  ConfigLoad: z.array(HookSpecSchema).optional(),
  ConfigChange: z.array(HookSpecSchema).optional(),
  PreBash: z.array(HookSpecSchema).optional(),
  PostBash: z.array(HookSpecSchema).optional(),
  PreRead: z.array(HookSpecSchema).optional(),
  PostRead: z.array(HookSpecSchema).optional(),
  PreWrite: z.array(HookSpecSchema).optional(),
  PostWrite: z.array(HookSpecSchema).optional(),
  PreEdit: z.array(HookSpecSchema).optional(),
  PostEdit: z.array(HookSpecSchema).optional(),
  LockAcquired: z.array(HookSpecSchema).optional(),
  LockReleased: z.array(HookSpecSchema).optional(),
});
export type HookSettings = z.infer<typeof HookSettingsSchema>;

// ── Path settings ────────────────────────────────────────────────

export const PathSettingsSchema = z.object({
  additionalBlockedGlobs: z.array(z.string()).optional(),
  allowedExternalDirs: z.array(z.string()).optional(),
});
export type PathSettings = z.infer<typeof PathSettingsSchema>;

// ── Tool settings ────────────────────────────────────────────────

export const ToolSettingsSchema = z.object({
  defaultTimeoutMs: z.number().int().min(100).max(300_000).optional(),
  maxOutputBytes: z.number().int().min(1_000).max(10_000_000).optional(),
});
export type ToolSettings = z.infer<typeof ToolSettingsSchema>;

export const WorkflowSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  allowed: z.array(z.string()).optional(),
  defaultDryRun: z.boolean().optional(),
  maxStepsDefault: z.number().int().min(1).max(50).optional(),
  maxStepsHardLimit: z.number().int().min(1).max(200).optional(),
  requireConfirmationForBulk: z.boolean().optional(),
  stateDir: z.string().optional(),
  localMcpAllowlist: z.record(z.object({
    enabled: z.boolean().optional(),
    tools: z.array(z.string()).optional(),
  })).optional(),
});
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;

// ── Output settings ──────────────────────────────────────────────

export const OutputSettingsSchema = z.object({
  mode: z.enum(["raw", "compact", "compressed"]).optional(),
  store: z.boolean().optional(),
  storeTtlMs: z.number().int().min(60_000).max(7 * 86_400_000).optional(),
});
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;

// ── Local HTTP tools ─────────────────────────────────────────────

export const HttpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  allowedHosts: z.array(z.string()).optional(),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).optional(),
  allowExternal: z.boolean().optional(),
  maxBodyBytes: z.number().int().min(1_000).max(20_000_000).optional(),
  defaultTimeoutMs: z.number().int().min(100).max(600_000).optional(),
  allowRedirects: z.boolean().optional(),
});
export type HttpSettings = z.infer<typeof HttpSettingsSchema>;

// ── Docker Compose tools ─────────────────────────────────────────

export const DockerComposeSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  defaultComposeDir: z.string().optional(),
  maxLogTail: z.number().int().min(1).max(50_000).optional(),
  allowRestart: z.boolean().optional(),
  allowUpDown: z.boolean().optional(),
});
export type DockerComposeSettings = z.infer<typeof DockerComposeSettingsSchema>;

// ── Package script / test tools ──────────────────────────────────

export const PackageScriptSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  allowedManagers: z.array(z.enum(["pnpm", "npm", "yarn"])).optional(),
  defaultTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
});
export type PackageScriptSettings = z.infer<typeof PackageScriptSettingsSchema>;

// ── Top-level settings shape ─────────────────────────────────────

export const LeastSettingsSchema = z.object({
  $schema: z.string().optional(),
  permissions: PermissionSettingsSchema.optional(),
  skills: SkillSettingsSchema.optional(),
  hooks: HookSettingsSchema.optional(),
  paths: PathSettingsSchema.optional(),
  tools: ToolSettingsSchema.optional(),
  workflows: WorkflowSettingsSchema.optional(),
  output: OutputSettingsSchema.optional(),
  http: HttpSettingsSchema.optional(),
  dockerCompose: DockerComposeSettingsSchema.optional(),
  packageScripts: PackageScriptSettingsSchema.optional(),
});
export type LeastSettings = z.infer<typeof LeastSettingsSchema>;
