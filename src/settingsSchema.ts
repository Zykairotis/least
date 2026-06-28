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

// ── Output settings ──────────────────────────────────────────────

export const OutputSettingsSchema = z.object({
  mode: z.enum(["raw", "compact", "compressed"]).optional(),
  store: z.boolean().optional(),
  storeTtlMs: z.number().int().min(60_000).max(7 * 86_400_000).optional(),
});
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;

// ── Top-level settings shape ─────────────────────────────────────

export const LeastSettingsSchema = z.object({
  $schema: z.string().optional(),
  permissions: PermissionSettingsSchema.optional(),
  skills: SkillSettingsSchema.optional(),
  hooks: HookSettingsSchema.optional(),
  paths: PathSettingsSchema.optional(),
  tools: ToolSettingsSchema.optional(),
  output: OutputSettingsSchema.optional(),
});
export type LeastSettings = z.infer<typeof LeastSettingsSchema>;
