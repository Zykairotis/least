# Least Settings, Skills Manifest, and Hooks Plan

Date: 2026-06-26
Workspace: `X:\least`
Branch observed: `rebrand-to-least`
Scope: Add a Least-native configuration, permission, external skill-source, and hook system inspired by Claude Code settings, permissions, skills, and hooks.
Status: Planning only. This document does not implement code.

---

## 1. Executive summary

Least can support a Claude Code-like `settings.json`, a linked `skills.yaml`, and a hook system, but it should not attempt a direct clone. Claude Code owns the full agent runtime, terminal permission UI, prompt lifecycle, and tool loop. Least currently owns the local server/tool boundary, workspace path guard, bash execution policy, skill discovery, MCP/OpenAI tool registration, and local workspace operations. The correct implementation is therefore a Least-native policy layer at the server/tool boundary.

The recommended feature set is:

1. Layered Least settings files.
2. Central permission evaluator for tools, bash commands, file reads, and mutations.
3. A `skills.yaml` manifest referenced from settings, used to opt into external skill roots.
4. Tool-boundary hooks for events Least actually controls.
5. Validation, diagnostics, and smoke tests that prove policy enforcement is outside the model.

The first version should be conservative. It should support `allow`, `deny`, and limited `ask` decisions, but should not promise a native interactive approval UI unless the host client supports it. It should support tool and bash hooks, but not Claude Code lifecycle hooks that require ownership of the whole agent loop.

---

## 2. Current Least baseline

Current relevant implementation areas:

- `src/config.ts`
  - Loads configuration mostly from CLI args and `LEAST_*` environment variables.
  - Controls root/allowed roots, bash mode, write mode, tool mode, toolset, blocked globs, HTTP auth, concurrency, output shaping, project memory, and limits.

- `src/bashOps.ts`
  - Implements current bash safety policy.
  - Uses fixed safe/readonly allowlists and blocked regexes.
  - Supports `LEAST_BASH_MODE=off|safe|readonly|full`.
  - Exposes `bashRequiresMutationLock()` for lease-mode workspace locking.

- `src/guard.ts`
  - Enforces workspace-root containment.
  - Blocks sensitive paths using `blockedGlobs`.
  - Protects symlink escapes.
  - Guards reads and writes.

- `src/capabilitiesOps.ts`
  - Discovers skills from fixed roots:
    - `<workspace>/.codex/skills`
    - `<workspace>/.agents/skills`
    - `<workspace>/skills`
    - `~/.codex/skills`
    - `~/.agents/skills`
    - `~/.codex/plugins/cache`
  - Loads only `SKILL.md` files.
  - Has no declarative external manifest yet.

- `src/server.ts`
  - Registers MCP/OpenAI tools.
  - Wraps tool calls with timeout and telemetry.
  - Contains good central insertion points for permissions and hooks.
  - Bash path already goes through a local handler that can run specific `PreBash` and `PostBash` hooks.

- `src/toolRegistry.ts`
  - Holds local tool records and invocation.
  - Can become a clean central wrapper point if hook/permission logic is generalized.

This baseline is suitable for the feature. The main missing pieces are a settings loader, schema, central permission engine, skills manifest parser, hook runner, and integration tests.

---

## 3. Non-goals

Do not implement these in v1:

1. Full Claude Code compatibility.
   - Least should be inspired by Claude Code, not syntax-bound to it everywhere.

2. Host-native permission dialogs.
   - Least can return `permission_required`, but cannot force ChatGPT or another MCP client to render Claude's approval UI.

3. Full prompt/session lifecycle hooks.
   - Least cannot reliably support `UserPromptSubmit`, `SessionEnd`, `Stop`, `PreCompact`, or `MessageDisplay` because those are host/agent-loop events.

4. Arbitrary plugin execution.
   - External skills are instruction files, not executable plugins.
   - Hooks may execute commands, but only after explicit trust and policy checks.

5. Hidden policy overrides.
   - Project settings must not silently grant powerful permissions or external roots without user/local opt-in where appropriate.

6. Network-fetched skills in v1.
   - Start with local filesystem roots only.
   - Git/npm/URL-based skill sources can be added later with explicit pinning and checksums.

---

## 4. Desired user-facing files

### 4.1 User settings

Suggested path:

```text
~/.least/settings.json
```

Purpose:

- User-wide defaults.
- Global allowed roots.
- User-trusted external skills manifests.
- User-trusted hook command directories.
- Default permission policy.

Example:

```json
{
  "$schema": "https://least.dev/schemas/settings.schema.json",
  "permissions": {
    "defaultMode": "safe",
    "allow": [
      "Bash(npm run build)",
      "Bash(npm run test *)",
      "Read(src/**)",
      "Read(plan/**)"
    ],
    "deny": [
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(git push *)",
      "Read(.env)",
      "Read(**/.env)",
      "Edit(.git/**)"
    ]
  },
  "skills": {
    "allowExternalSources": true,
    "manifests": [
      "~/.least/skills.yaml"
    ]
  },
  "hooks": {
    "enabled": true,
    "allowProjectHooks": false
  }
}
```

### 4.2 Project settings

Suggested path:

```text
<workspace>/.least/settings.json
```

Purpose:

- Team-shared recommendations.
- Project command allowlist.
- Project skill manifest pointer.
- Project hooks that still require local/user trust to execute if they are powerful.

Example:

```json
{
  "$schema": "https://least.dev/schemas/settings.schema.json",
  "permissions": {
    "allow": [
      "Bash(npm run build)",
      "Bash(npm run smoke)",
      "Read(src/**)",
      "Read(scripts/**)",
      "Edit(src/**)",
      "Edit(scripts/**)",
      "Write(plan/**)"
    ],
    "deny": [
      "Bash(git push *)",
      "Bash(npm publish *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Read(.env*)",
      "Read(**/.env*)"
    ]
  },
  "skills": {
    "manifest": ".least/skills.yaml"
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "type": "command",
        "command": ".least/hooks/pre-bash.js",
        "timeoutMs": 3000
      }
    ],
    "PostToolUse": [
      {
        "matcher": "write|edit|multi_edit|apply_patch",
        "type": "command",
        "command": ".least/hooks/audit-mutation.js",
        "timeoutMs": 3000
      }
    ]
  }
}
```

### 4.3 Local project settings

Suggested path:

```text
<workspace>/.least/settings.local.json
```

Purpose:

- User-local project trust decisions.
- Should be gitignored.
- Can approve project hooks or external skill roots.

Example:

```json
{
  "skills": {
    "allowExternalSources": true
  },
  "hooks": {
    "allowProjectHooks": true,
    "trustedHookCommands": [
      ".least/hooks/pre-bash.js",
      ".least/hooks/audit-mutation.js"
    ]
  }
}
```

### 4.4 Skills manifest

Suggested path:

```text
<workspace>/.least/skills.yaml
```

Purpose:

- Declare external skill roots.
- Link skill visibility overrides.
- Keep skill-source control separate from general settings.

Example:

```yaml
version: 1

sources:
  - id: workspace-skills
    path: "skills"
    trust: workspace
    enabled: true

  - id: shared-local
    path: "X:/least-shared-skills"
    trust: local
    enabled: true

  - id: user-global
    path: "~/.least/skills"
    trust: user
    enabled: true

overrides:
  deploy:
    visibility: user-invocable-only
  legacy-context:
    visibility: name-only
  unsafe-prod:
    visibility: off
```

---

## 5. Settings precedence

Recommended precedence:

```text
CLI args
> workspace local settings: <workspace>/.least/settings.local.json
> workspace shared settings: <workspace>/.least/settings.json
> user settings: ~/.least/settings.json
> environment variables
> built-in defaults
```

Rationale:

- CLI args are explicit for the current process and should win.
- Local project settings represent user trust decisions for one workspace.
- Shared project settings represent team recommendations.
- User settings represent defaults.
- Env remains backward-compatible.
- Defaults keep Least safe out of the box.

Important compatibility requirement:

- Existing `LEAST_*` env behavior must keep working when no settings file exists.
- Existing users should not need to create any settings file.

Potential alternative:

```text
CLI args > env > local > project > user > defaults
```

This gives env higher priority, but makes settings less predictable. Prefer CLI-only override above local settings and keep env as fallback unless a strong compatibility reason appears.

---

## 6. Settings schema

Add a zod schema in `src/settingsSchema.ts`.

Suggested top-level shape:

```ts
type LeastSettings = {
  permissions?: PermissionSettings;
  skills?: SkillSettings;
  hooks?: HookSettings;
  paths?: PathSettings;
  tools?: ToolSettings;
  output?: OutputSettings;
};
```

Suggested permission shape:

```ts
type PermissionSettings = {
  defaultMode?: "off" | "readonly" | "safe" | "full";
  allow?: string[];
  ask?: string[];
  deny?: string[];
  additionalDirectories?: string[];
};
```

Suggested skill shape:

```ts
type SkillSettings = {
  manifest?: string;
  manifests?: string[];
  allowExternalSources?: boolean;
  maxSkills?: number;
  defaultVisibility?: "on" | "name-only" | "user-invocable-only" | "off";
};
```

Suggested hook shape:

```ts
type HookSettings = {
  enabled?: boolean;
  allowProjectHooks?: boolean;
  trustedHookCommands?: string[];
  PreToolUse?: HookSpec[];
  PostToolUse?: HookSpec[];
  ToolError?: HookSpec[];
  WorkspaceOpen?: HookSpec[];
  ConfigLoad?: HookSpec[];
  ConfigChange?: HookSpec[];
  PreBash?: HookSpec[];
  PostBash?: HookSpec[];
  PreRead?: HookSpec[];
  PostRead?: HookSpec[];
  PreWrite?: HookSpec[];
  PostWrite?: HookSpec[];
  PreEdit?: HookSpec[];
  PostEdit?: HookSpec[];
};
```

Suggested hook spec:

```ts
type HookSpec = {
  matcher?: string;
  type: "command";
  command: string;
  timeoutMs?: number;
  runIn?: "workspace" | "settings";
};
```

---

## 7. Permission rule model

### 7.1 Rule syntax

Support this syntax in v1:

```text
Bash(npm run build)
Bash(npm run test *)
Bash(git status)
Bash(git diff *)
Read(src/**)
Read(plan/**)
Edit(src/**)
Write(plan/**)
Tool(show_changes)
Tool(read_many)
```

Avoid supporting complex shell parsing in v1. Use Least's current `compact(command)` normalization and simple glob matching.

### 7.2 Decision order

Evaluation order:

```text
deny > ask > allow > fallback mode
```

Decision type:

```ts
type PermissionDecision =
  | { decision: "allow"; reason?: string; matchedRule?: string }
  | { decision: "ask"; reason: string; matchedRule?: string }
  | { decision: "deny"; reason: string; matchedRule?: string };
```

### 7.3 Ask behavior

Since Least cannot force all clients to show a native permission modal, v1 should emulate ask as a structured error:

```json
{
  "permission_required": true,
  "tool": "bash",
  "reason": "Matched ask rule: Bash(npm run deploy *)",
  "approval_hint": "Add a more specific allow rule to .least/settings.local.json or rerun after explicit approval if the client supports approvals."
}
```

If a future client supports explicit permission responses, add an approval token flow.

### 7.4 Fallback behavior

If no rule matches:

- Bash uses existing `LEAST_BASH_MODE` / `permissions.defaultMode` behavior.
- Write/edit uses existing `LEAST_WRITE_MODE` behavior.
- Read uses current path guard and blocked globs.
- Tool calls remain allowed unless blocked by `Tool(...)` rules.

This minimizes breakage.

---

## 8. Permission engine implementation

Add:

```text
src/permissions.ts
src/permissionRules.ts
```

Core functions:

```ts
export function parsePermissionRule(rule: string): PermissionRule;

export function evaluatePermission(input: {
  settings: EffectiveSettings;
  config: LeastConfig;
  workspace: Workspace;
  toolName: string;
  toolInput: Record<string, unknown>;
  normalizedCommand?: string;
  targetPaths?: string[];
}): PermissionDecision;
```

Integration points:

1. `bash` / `shell`
   - Evaluate `Bash(command)` before lock acquisition and before execution.
   - Denied commands should fail before hooks that could execute arbitrary code.
   - `PreBash` hooks run after static permission allow, unless the hook itself is intended to add additional denial.

2. Read tools
   - `read`, `read_many`, `read_around`, `files`, `search`, `search_context`, `json_query`, `context_pack`, `project_map`, `show_changes`.
   - For broad search/context tools, permission should check requested path scope, not every file result in v1.
   - PathGuard still provides final enforcement.

3. Mutation tools
   - `write`, `edit`, `multi_edit`, `apply_patch`, `handoff_to_agent`, `export_pro_context`.
   - Enforce `Write(...)`/`Edit(...)`/`Tool(...)` permissions before mutation lock renewal.
   - Keep existing lease locks and stale SHA protections.

4. Administrative tools
   - `server_config`, `least_inventory`, `least_gain`, `least_discover`, `workspace_lock_status` should remain read-only but can be covered by `Tool(...)` deny rules.

---

## 9. Skills manifest implementation

Add:

```text
src/skillManifest.ts
```

Responsibilities:

1. Read YAML-like manifest.
2. Validate fields.
3. Resolve `~`, workspace-relative, and absolute paths.
4. Apply trust rules.
5. Return skill roots and visibility overrides.

### 9.1 YAML dependency decision

The project currently does not include a YAML parser. Options:

1. Add `yaml` dependency.
   - Most robust.
   - Slight dependency increase.

2. Implement minimal parser for a constrained manifest.
   - Avoids dependency.
   - Risky and easy to get wrong.

Recommendation: add `yaml` dependency only if acceptable. The manifest feature is YAML by user request, and a hand-written parser is not worth the risk.

If avoiding dependencies is mandatory, use JSONC instead:

```text
.least/skills.jsonc
```

But the requested file is `skills.yaml`, so prefer adding `yaml`.

### 9.2 Trust rules

Rules:

- Workspace-relative source paths are allowed from project settings.
- Home-relative source paths require user settings or local project settings.
- Absolute external paths require explicit `skills.allowExternalSources=true` in user or local settings.
- Non-existing roots are skipped with diagnostics, not fatal by default.
- Symlink escapes should be resolved and classified.
- Blocked paths remain blocked.

### 9.3 Visibility states

Support these skill visibility states:

```text
on
name-only
user-invocable-only
off
```

Meaning:

- `on`: listed and loadable.
- `name-only`: listed by name/description, but full body is not auto-loaded unless explicitly requested.
- `user-invocable-only`: visible only when directly requested by name.
- `off`: hidden and not loadable.

### 9.4 Integration with `capabilitiesOps.ts`

Change `discoverSkillRecords()` to collect roots from:

```text
built-in workspace roots
+ built-in global roots when includeGlobal=true
+ settings-linked skills.yaml sources
```

Add source labels:

```ts
source: "workspace" | "user" | "plugin" | "external" | "other"
```

Current type only has `workspace | user | plugin | other`; add `external`.

Update `least_inventory`, `open_workspace`, and `load_skill` outputs to include manifest-derived paths safely.

---

## 10. Hooks implementation

Add:

```text
src/hooks.ts
```

### 10.1 Supported v1 events

Support events Least controls:

```text
ConfigLoad
ConfigChange
WorkspaceOpen
PreToolUse
PostToolUse
ToolError
PreBash
PostBash
PreRead
PostRead
PreWrite
PostWrite
PreEdit
PostEdit
LockAcquired
LockReleased
```

Do not support these in v1:

```text
UserPromptSubmit
SessionEnd
Stop
PreCompact
PostCompact
MessageDisplay
Prompt expansion hooks
```

### 10.2 Hook execution model

Command hooks:

- Execute a configured local command.
- Pass JSON on stdin.
- Capture JSON or text on stdout.
- Enforce timeout.
- Use redacted event payload.
- Use sanitized environment by default.
- Do not inherit secrets unless explicitly configured later.

Hook input example:

```json
{
  "event": "PreToolUse",
  "toolName": "bash",
  "workspace": {
    "id": "ws_...",
    "root": "X:\\least"
  },
  "toolInput": {
    "command": "npm run build"
  },
  "timestamp": "2026-06-26T00:00:00.000Z"
}
```

PreToolUse hook output:

```json
{
  "decision": "allow"
}
```

Deny output:

```json
{
  "decision": "deny",
  "reason": "Deploy command blocked outside CI."
}
```

Add-context output:

```json
{
  "decision": "allow",
  "context": "Project policy: build commands are allowed."
}
```

### 10.3 Hook trust and path rules

Hooks are executable and therefore more dangerous than skills. Rules:

- Project hooks do not execute unless `hooks.allowProjectHooks=true` in local/user settings.
- Hook command must be workspace-relative or under a trusted hook directory.
- Absolute hook commands require explicit trust.
- Hook commands should be denied if they point into `.git`, `.env`, `node_modules`, cache folders, or external untrusted roots.
- Hook commands should not use shell expansion in v1. Prefer direct `node script.js` style with parsed executable/args later.

### 10.4 Hook failure behavior

Default behavior:

- Pre hooks fail closed for protected operations.
- Post hooks fail open but report diagnostics.
- Config hooks fail open but warn.

Suggested settings:

```json
{
  "hooks": {
    "failureMode": "safe"
  }
}
```

V1 may simply hardcode:

```text
PreToolUse/PreBash/PreWrite/PreEdit: fail closed
PostToolUse/PostBash/PostRead/PostWrite/PostEdit: fail open with warning
```

---

## 11. Tool invocation integration

Current `server.ts` wraps handlers inside `registerCodexTool()`. Add a single pipeline there:

```text
incoming tool call
-> load/effective settings
-> evaluate Tool(...) permission
-> run PreToolUse hooks
-> run specific Pre* hooks
-> run handler
-> run specific Post* hooks
-> run PostToolUse hooks
-> return result
```

For bash:

```text
bash/shell call
-> evaluate Tool(bash)
-> evaluate Bash(command)
-> lock check if mutating
-> PreToolUse
-> PreBash
-> runBash
-> PostBash
-> PostToolUse
-> shape output
```

Need to avoid double execution or hook recursion:

- Hook command execution must not call Least bash tool internally.
- Use a low-level process runner with fixed timeout.
- Do not run hooks around hook execution.

---

## 12. Diagnostics and UX

Add or extend tools:

### 12.1 `server_config`

Include:

```text
settings_files_loaded
settings_files_missing
permissions_enabled
hooks_enabled
skills_manifests_loaded
external_skill_roots_count
```

Never reveal secrets.

### 12.2 New `settings_status` tool

Optional but useful.

Input:

```json
{
  "workspace_id": "...",
  "include_rules": false
}
```

Output:

```text
# Settings Status

Loaded:
- user: ~/.least/settings.json
- project: .least/settings.json
- local: .least/settings.local.json

Permissions:
- allow rules: 8
- ask rules: 1
- deny rules: 6

Skills:
- manifests: 1
- roots: 3
- disabled skills: 2

Hooks:
- enabled: true
- project hooks trusted: false
- active hook specs: 0
```

### 12.3 `doctor`

Extend doctor to validate:

- Invalid settings JSON.
- Unknown settings keys.
- Skills manifest parse errors.
- Non-existing external skill roots.
- Hook command not found.
- Hook command not trusted.
- Project settings requests external roots but local/user settings do not trust them.

---

## 13. Security model

### 13.1 Core rules

1. Settings are policy, not prompt instructions.
2. Deny rules are enforced outside the model.
3. PathGuard remains final file safety enforcement.
4. External skill roots require explicit trust.
5. Project hooks require explicit trust.
6. Hook execution must not inherit secrets by default.
7. Hook output must be redacted before inclusion in model-visible output.
8. Settings files must not expand environment variables by default.
9. Network sources are out of scope in v1.
10. Do not let a workspace grant itself permission to execute arbitrary hooks outside the workspace.

### 13.2 Dangerous cases to test

- Project adds `.least/settings.json` with external absolute skill root.
- Project adds hook command `curl ...`.
- Project tries hook command `../../evil.js`.
- Project symlinks `.least/hooks/pre.js` outside workspace.
- `skills.yaml` points at `.git` or `.env` path.
- `Read(**)` allow tries to override blocked `.env` deny.
- `allow` and `deny` both match same command.
- User local settings disable project hooks.

Expected behavior:

- Deny wins.
- Blocked globs still apply.
- External roots skipped unless trusted.
- Untrusted hooks do not execute.

---

## 14. Implementation phases

### Phase 1: settings loader and schema

Files:

```text
src/settingsSchema.ts
src/settings.ts
src/config.ts
scripts/settings-smoke.mjs
scripts/smoke.mjs
README.md
config.example.env
```

Tasks:

1. Define zod schemas.
2. Implement JSON/JSONC reading.
3. Resolve settings paths.
4. Merge settings layers deterministically.
5. Add effective settings to `LeastConfig` or a separate `SettingsContext`.
6. Preserve existing env/CLI behavior.
7. Add `server_config` diagnostics.

Acceptance criteria:

- No settings files: behavior unchanged.
- Invalid settings file returns clear error.
- Local settings override project settings.
- CLI args still override settings for known config fields.
- `npm run build` passes.
- Existing smoke suite passes.

### Phase 2: permission engine

Files:

```text
src/permissions.ts
src/permissionRules.ts
src/bashOps.ts
src/server.ts
src/guard.ts
scripts/settings-permissions-unit.mjs
scripts/smoke.mjs
```

Tasks:

1. Parse `Tool(...)`, `Bash(...)`, `Read(...)`, `Write(...)`, `Edit(...)` rules.
2. Implement rule matching with deny/ask/allow order.
3. Wire Bash command evaluation into `runShellTool`.
4. Wire read/write/edit tool permission checks into server handlers.
5. Preserve existing `bashMode` fallback.
6. Add structured `permission_required` output for ask decisions.

Acceptance criteria:

- `deny` blocks even when `allow` also matches.
- `allow` permits command that current safe defaults would otherwise reject only if still not blocked by absolute safety rules.
- `ask` produces structured permission-required response.
- Existing bash safe/readonly/full modes continue to work without settings.
- Mutation lock enforcement remains unchanged.

### Phase 3: `skills.yaml` support

Files:

```text
src/skillManifest.ts
src/capabilitiesOps.ts
src/config.ts or src/settings.ts
scripts/skills-manifest-unit.mjs
scripts/smoke.mjs
README.md
```

Tasks:

1. Add YAML parser dependency if approved.
2. Parse manifest and validate schema.
3. Resolve source paths.
4. Apply trust rules.
5. Merge manifest roots into skill discovery.
6. Apply visibility overrides.
7. Extend `least_inventory` and `load_skill` diagnostics.

Acceptance criteria:

- Workspace manifest loads workspace-relative skill root.
- External absolute source is skipped unless trusted.
- Disabled source is ignored.
- `off` skill is not listed or loadable.
- `name-only` skill is listed without eager body loading.
- Duplicate skill names produce clear disambiguation.

### Phase 4: hooks

Files:

```text
src/hooks.ts
src/server.ts
src/toolRegistry.ts
src/processRunner.ts
src/redact.ts
scripts/hooks-unit.mjs
scripts/smoke.mjs
README.md
```

Tasks:

1. Define hook event types and payloads.
2. Implement hook matching.
3. Implement command hook runner.
4. Enforce hook trust rules.
5. Add PreToolUse/PostToolUse wrapper.
6. Add specific PreBash/PostBash and mutation hooks.
7. Add hook diagnostics to `server_config` or `settings_status`.

Acceptance criteria:

- Trusted PreToolUse hook can deny a bash command.
- Trusted PostToolUse hook can append safe context/diagnostics.
- Untrusted project hook does not execute.
- Hook timeout fails closed for pre hooks.
- Hook timeout fails open with warning for post hooks.
- Hook output is redacted.

### Phase 5: docs and examples

Files:

```text
README.md
docs/settings.md
docs/permissions.md
docs/skills.yaml.md
docs/hooks.md
.least/settings.example.json
.least/skills.example.yaml
```

Tasks:

1. Document settings file locations.
2. Document precedence.
3. Document permission syntax.
4. Document ask limitations.
5. Document skills manifest trust model.
6. Document supported hook events.
7. Document unsupported Claude lifecycle hooks.
8. Add migration notes from env variables.

Acceptance criteria:

- A new user can configure allowed commands without reading source.
- A user understands why project hooks require local trust.
- Docs clearly state that Least does not fully clone Claude Code runtime hooks.

---

## 15. Suggested file layout

```text
.least/
  settings.example.json
  skills.example.yaml
  hooks/
    README.md

docs/
  settings.md
  permissions.md
  skills-manifest.md
  hooks.md

src/
  settings.ts
  settingsSchema.ts
  permissions.ts
  permissionRules.ts
  skillManifest.ts
  hooks.ts

scripts/
  settings-loader-unit.mjs
  permissions-unit.mjs
  skills-manifest-unit.mjs
  hooks-unit.mjs
```

---

## 16. Example effective settings merge

User settings:

```json
{
  "permissions": {
    "deny": ["Bash(curl *)"],
    "allow": ["Bash(npm run build)"]
  },
  "hooks": {
    "enabled": true,
    "allowProjectHooks": false
  }
}
```

Project settings:

```json
{
  "permissions": {
    "allow": ["Bash(npm run smoke)"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "type": "command",
        "command": ".least/hooks/pre-bash.js"
      }
    ]
  }
}
```

Local settings:

```json
{
  "hooks": {
    "allowProjectHooks": true,
    "trustedHookCommands": [".least/hooks/pre-bash.js"]
  }
}
```

Effective behavior:

- `curl` remains denied.
- `npm run build` allowed.
- `npm run smoke` allowed.
- Project hook may execute because local settings trusted it.

---

## 17. Testing plan

### 17.1 Settings loader tests

Cases:

1. No settings files.
2. User settings only.
3. Project settings only.
4. User + project + local merge.
5. Invalid JSON.
6. Unknown keys warning/error depending strictness.
7. `~` expansion.
8. Workspace-relative path resolution.

### 17.2 Permission tests

Cases:

1. Deny wins over allow.
2. Ask wins over allow.
3. Allow works.
4. No match falls back to existing bash mode.
5. `Read(.env)` denied.
6. `Edit(src/**)` allowed.
7. `Edit(.git/**)` denied despite broad allow.
8. `Tool(bash)` deny blocks bash regardless of command rule.

### 17.3 Skill manifest tests

Cases:

1. Valid manifest with workspace source.
2. Valid manifest with user source.
3. External source without trust is skipped.
4. External source with trust is loaded.
5. Disabled source ignored.
6. Visibility `off` prevents loading.
7. Duplicate names require disambiguation.
8. Missing manifest produces diagnostic, not crash.

### 17.4 Hook tests

Cases:

1. Trusted pre hook allow.
2. Trusted pre hook deny.
3. Trusted pre hook ask.
4. Pre hook timeout fails closed.
5. Post hook timeout fails open with warning.
6. Untrusted project hook skipped.
7. Hook output is redacted.
8. Hook cannot recursively invoke hooks.

### 17.5 Regression tests

Run:

```text
npm run build
npm run smoke
```

Also add targeted scripts to smoke:

```text
node scripts/settings-loader-unit.mjs
node scripts/permissions-unit.mjs
node scripts/skills-manifest-unit.mjs
node scripts/hooks-unit.mjs
```

---

## 18. Open design questions

1. Should env variables override settings or only act as fallback?
   - Recommendation: CLI > local > project > user > env > defaults.

2. Should `ask` be implemented in v1?
   - Recommendation: yes, as structured `permission_required`; no native UI promise.

3. Should project settings be allowed to add external skill roots?
   - Recommendation: only workspace-relative by default. External roots need user/local trust.

4. Should hooks use shell strings or executable+args arrays?
   - Recommendation: support string for usability, but internally parse and restrict. Long term, prefer `{ "command": "node", "args": [".least/hooks/x.js"] }`.

5. Should hooks be able to modify tool input?
   - Recommendation: not in v1 except possibly `deny` and `addContext`. Input modification is powerful and can make behavior harder to audit.

6. Should permission rules apply to OpenAI protocol and MCP protocol equally?
   - Recommendation: yes. Policy belongs at Least server boundary, independent of client protocol.

---

## 19. Recommended first PR

Title:

```text
Add layered Least settings loader
```

Scope:

- Add schemas.
- Load user/project/local settings.
- Merge settings.
- Expose diagnostics.
- No permission behavior changes yet except reporting.

Files:

```text
src/settings.ts
src/settingsSchema.ts
src/config.ts
src/server.ts
scripts/settings-loader-unit.mjs
scripts/settings-smoke.mjs
README.md
```

Why first:

- Low behavioral risk.
- Gives foundation for permissions, skills, and hooks.
- Allows diagnostics before enforcement.

---

## 20. Recommended second PR

Title:

```text
Add settings-backed permission rules
```

Scope:

- Add rule parser.
- Add permission evaluator.
- Wire bash/read/write/edit/tool permissions.
- Preserve current fallback behavior.

Files:

```text
src/permissions.ts
src/permissionRules.ts
src/bashOps.ts
src/server.ts
src/guard.ts
scripts/permissions-unit.mjs
scripts/smoke.mjs
README.md
```

---

## 21. Recommended third PR

Title:

```text
Add settings-linked skills.yaml discovery
```

Scope:

- Add manifest parser.
- Add external root trust rules.
- Add visibility overrides.
- Extend skill inventory.

Files:

```text
src/skillManifest.ts
src/capabilitiesOps.ts
src/settingsSchema.ts
scripts/skills-manifest-unit.mjs
docs/skills-manifest.md
```

---

## 22. Recommended fourth PR

Title:

```text
Add Least tool-boundary hooks
```

Scope:

- Add hook runner.
- Add PreToolUse/PostToolUse and Bash/mutation-specific hooks.
- Add hook trust rules.
- Add hook tests and docs.

Files:

```text
src/hooks.ts
src/server.ts
src/toolRegistry.ts
src/processRunner.ts
src/redact.ts
scripts/hooks-unit.mjs
docs/hooks.md
```

---

## 23. Final recommendation

Build this feature, but keep the trust model strict:

```text
settings.json: yes
permissions.allow/ask/deny: yes
skills.yaml linked from settings: yes
external skill roots: yes, only with explicit trust
hooks: yes, only for Least-controlled tool/server events
full Claude Code lifecycle clone: no
```

This gives Least the useful parts of Claude-style configurability while preserving Least's core purpose: a local, auditable, safety-conscious development bridge.
