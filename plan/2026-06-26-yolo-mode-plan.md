# Plan: `--yolo` Mode for Least

Date: 2026-06-26
Status: Proposed
Scope: Least-local permission bypass mode only

## Summary

Add an explicit `--yolo` mode to Least that disables Least's own internal permission prompts and policy checks for trusted local development sessions.

This mode must be intentionally dangerous, visibly labeled, opt-in only, and impossible to enable accidentally from project-controlled settings.

Important limitation: `--yolo` cannot bypass ChatGPT's platform-level approval prompts for local connector actions. It can only bypass Least/Xacho's own internal permission engine, command gating, and ask-mode behavior.

## Goal

Make Least suitable for trusted local automation sessions where the user wants the local agent to continue without repeated internal permission interruptions.

Expected behavior:

- Allow all Least tools.
- Allow all bash/shell commands through Least's internal policy layer.
- Treat permission `ask` as `allow`.
- Ignore user/project allow/deny rules unless a non-bypassable safety invariant applies.
- Keep workspace-lock semantics unless a separate, explicit flag disables them.
- Clearly expose that the session is unsafe.

## Non-goals

Do not bypass:

- ChatGPT platform approval prompts.
- Operating-system permissions.
- MCP host security rules outside Least.
- Workspace lock requirements unless a separate `--no-lock` or equivalent flag is added.
- Secret redaction defaults unless a separate `--no-redact` flag is added.
- Path containment outside allowed roots unless `--allow-root` explicitly includes those roots.

## CLI Design

Add:

```bash
least --yolo
```

Alias:

```bash
least --dangerously-allow-all
```

Do not make `--yolo` configurable only through project settings. A malicious repository should not be able to enable it by adding `.least/settings.json`.

Recommended enable sources:

1. CLI flag: allowed.
2. Environment variable: allowed only with an explicit scary name.
3. User-level settings: optional.
4. Project-level settings: not allowed.

Environment variable:

```bash
LEAST_YOLO=1
```

Startup banner:

```text
WARNING: YOLO MODE ENABLED

Least will allow all local tools and shell commands without internal permission prompts.
This does not bypass ChatGPT, OS, or MCP host approvals.
Use only in trusted workspaces.
```

## Config Model

Add to `LeastConfig`:

```ts
yoloMode: boolean;
```

Add derived permission mode:

```ts
permissionMode: "normal" | "yolo";
```

Suggested precedence:

1. CLI `--yolo`
2. `LEAST_YOLO=1`
3. user-level settings, if supported
4. default false

Project settings must not enable YOLO.

## Permission Engine Behavior

When `config.yoloMode === true`:

```ts
evaluateBashPermission(...) => allow
evaluateReadPermission(...) => allow
evaluateWritePermission(...) => allow
evaluateToolPermission(...) => allow
```

Still preserve non-bypassable safety invariants unless explicitly scoped:

- Workspace root containment.
- `allowRoot` restrictions.
- Symlink escape prevention.
- Secret-looking content write blocks, unless separately disabled.
- Mutation lock enforcement, unless separately disabled.

Recommended helper:

```ts
export function isYoloAllowed(config: LeastConfig): boolean {
  return config.yoloMode === true;
}
```

Add a single central bypass point instead of sprinkling YOLO checks across many handlers.

## Tool Registration Behavior

In `--yolo`:

- Register the full toolset regardless of `toolMode`, unless a stronger admin/host restriction prevents it.
- Prefer this inside `shouldRegisterTool`:

```ts
if (config.yoloMode) return true;
```

## Bash Behavior

Current bash safety layers likely include:

- bash mode
- allowlisted safe commands
- readonly/full distinction
- dangerous command detection
- mutation lock detection

In YOLO mode:

- Treat bash mode as full.
- Do not reject based on safe prefix allowlists.
- Do not block shell command patterns through Least permission rules.
- Still require mutation lock unless a separate `--no-lock` flag is introduced.

Recommended semantics:

```ts
const effectiveBashMode = config.yoloMode ? "full" : config.bashMode;
```

## Settings Schema

Add read-only reporting support:

```json
{
  "permissions": {
    "mode": "normal"
  }
}
```

Do not allow project settings to set:

```json
{
  "permissions": {
    "mode": "yolo"
  }
}
```

If present in project settings, warn and ignore:

```text
Ignoring yolo permission mode from project settings. Use CLI --yolo or LEAST_YOLO=1.
```

## Server Config Output

Expose YOLO state in `server_config`:

```json
{
  "yoloMode": true,
  "permissionMode": "yolo",
  "warnings": [
    "YOLO mode is enabled. Least permission checks are bypassed."
  ]
}
```

Also include in workspace/open responses:

```json
{
  "yolo_mode": true
}
```

## Hooks Behavior

Default recommendation:

- Do not disable hooks automatically.
- Still run hooks, but permission decisions should not block unless hook config explicitly says it is non-bypassable.

Possible model:

```ts
hooks: {
  respectYolo: true
}
```

Default:

```ts
respectYolo: true
```

Meaning:

- `PreToolUse` deny results become warnings in YOLO mode.
- `PostToolUse` continues to run fail-open.
- Hook execution errors do not block.

Optional stricter mode:

```bash
least --yolo --strict-hooks
```

## Audit Logging

YOLO mode should log every tool action to local telemetry/audit.

Minimum event fields:

```ts
{
  timestamp: string;
  workspaceId: string;
  toolName: string;
  yoloMode: true;
  command?: string;
  paths?: string[];
}
```

No secrets in audit logs.

Add visible output metadata:

```json
{
  "yolo_mode": true
}
```

## UX Requirements

Every top-level tool response in YOLO mode should include a compact warning in structured content or text footer:

```text
YOLO mode: Least permission checks bypassed.
```

Avoid noisy repetition in long batch outputs; show once per top-level call.

## Test Plan

Add:

```text
scripts/yolo-mode-unit.mjs
```

Coverage:

1. CLI parsing:
   - `--yolo` sets `config.yoloMode=true`.
   - `LEAST_YOLO=1` sets `config.yoloMode=true`.
   - default is false.

2. Settings precedence:
   - project `.least/settings.json` cannot enable YOLO.
   - user-level config may enable YOLO only if explicitly supported.

3. Permission bypass:
   - deny `Bash(curl *)` normally blocks.
   - same deny rule allows in YOLO.
   - deny `Read(src/**)` normally blocks.
   - same deny rule allows in YOLO.
   - deny `Write(src/**)` normally blocks.
   - same deny rule allows in YOLO.

4. Tool registration:
   - restricted mode normally hides full tools.
   - YOLO registers full tools.

5. Server config:
   - `server_config` reports `yoloMode: true`.

6. Hooks:
   - `PreToolUse` deny blocks normally.
   - `PreToolUse` deny warns/fails open in YOLO if `respectYolo=true`.

7. Non-bypassable safety:
   - path escape outside allowed root still blocked.
   - symlink escape still blocked.
   - mutation lock still required for writes.

## Smoke Integration

Add to `npm run smoke`:

```bash
node scripts/yolo-mode-unit.mjs
```

Do not require a destructive real shell command in smoke.

Use harmless commands:

```bash
node -e "console.log('yolo ok')"
```

## Implementation Files

Likely files to modify:

```text
src/config.ts
src/settings.ts
src/settingsSchema.ts
src/permissions.ts
src/permissionRules.ts
src/bashOps.ts
src/server.ts
src/hooks.ts
scripts/least.mjs
scripts/smoke.mjs
package.json
```

New file:

```text
scripts/yolo-mode-unit.mjs
```

Docs:

```text
docs/yolo-mode.md
```

Example docs section:

```markdown
# YOLO Mode

`--yolo` disables Least's internal permission prompts and allow/deny rules.
It does not bypass ChatGPT approval prompts, OS permissions, MCP host approvals, or allowed-root containment.
```

## Security Notes

YOLO mode is intentionally dangerous.

Risks:

- destructive shell commands
- data exfiltration by tools
- accidental writes
- repository-specific malicious hook behavior
- bypassing deny rules intended to protect secrets or production files

Required mitigations:

- opt-in only
- visible startup warning
- visible `server_config` flag
- project settings cannot enable it
- audit logging
- allowed-root containment remains active
- no automatic disabling of secret redaction

## Acceptance Criteria

Implementation can be considered complete when:

- `least --yolo` starts successfully.
- `server_config` reports YOLO mode.
- bash permission denies are bypassed in YOLO.
- read/write/edit permission denies are bypassed in YOLO.
- `Tool(...)` denies are bypassed in YOLO if global tool permissions exist.
- project settings cannot enable YOLO.
- allowed-root path escape is still blocked.
- mutation lock behavior remains intact.
- `npm run build` passes.
- `npm run smoke` passes.
- `scripts/yolo-mode-unit.mjs` is included in smoke.
- docs explain that this does not bypass ChatGPT platform approval prompts.

## Recommended PR Order

1. Add config parsing and `server_config` reporting.
2. Add permission-engine bypass.
3. Add bash effective-full behavior.
4. Add hook fail-open behavior in YOLO.
5. Add tests.
6. Add docs.
7. Add smoke integration.
