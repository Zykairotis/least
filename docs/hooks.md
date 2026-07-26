# Least Hooks

Hooks are event-driven scripts that Least executes at specific points in the tool lifecycle. They allow custom policy enforcement, auditing, and context injection.

## Supported events

| Event | Timing | Fail behavior |
|-------|--------|--------------|
| `PreToolUse` | Before any tool call | Fail closed |
| `PostToolUse` | After any tool call | Fail open |
| `ToolError` | When a tool returns an error | Fail open |
| `PreBash` / `PostBash` | Before/after bash execution | Pre: closed, Post: open |
| `PreRead` / `PostRead` | Before/after file reads | Pre: closed, Post: open |
| `PreWrite` / `PostWrite` | Before/after file writes | Pre: closed, Post: open |
| `PreEdit` / `PostEdit` | Before/after file edits | Pre: closed, Post: open |
| `WorkspaceOpen` | When a workspace is opened | Fail open |
| `ConfigLoad` / `ConfigChange` | When settings are loaded/changed | Fail open |
| `LockAcquired` / `LockReleased` | When a workspace lock is acquired/released | Fail open |

## Hook spec

```jsonc
{
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
        "matcher": "write|edit",
        "type": "command",
        "command": ".least/hooks/audit-mutation.js",
        "timeoutMs": 3000
      }
    ]
  }
}
```

## Agent tool hooks

Agent tools use the same generic tool lifecycle hooks. Matchers can target specific tools such as:

```text
agent_start
agent_status
agent_tail
agent_result
agent_sessions
agent_attach_hint
agent_terminal_doctor
```

A `PreToolUse` hook with matcher `agent_start` can enforce which local agent profiles are allowed. A `PostToolUse` hook with matcher `agent_tail` can audit terminal-output access.

## Hook input

Each hook receives a JSON payload on stdin:

```json
{
  "event": "PreToolUse",
  "toolName": "bash",
  "toolInput": { "command": "npm run build" },
  "workspace": { "id": "ws_...", "root": "/path/to/workspace" },
  "timestamp": "2026-06-26T00:00:00.000Z"
}
```

## Hook output

Allow:
```json
{ "decision": "allow" }
```

Deny:
```json
{ "decision": "deny", "reason": "Deploy command blocked outside CI." }
```

Add context:
```json
{ "decision": "allow", "context": "Project policy: build commands are allowed." }
```

## Trust model

- **Project hooks** (workspace-relative commands) require `hooks.allowProjectHooks: true` in local/user settings.
- **Hook commands** can be restricted to a `trustedHookCommands` list.
- Absolute hooks outside the workspace require explicit trust.
- Hook commands in blocked paths (`.git`, `node_modules`, `.env`) are denied.
- Pre-hooks fail **closed** (deny on timeout). Post-hooks fail **open** (warn on timeout).
- Hook output is **redacted** for secrets before being returned.

## Unsupported events

These Claude Code lifecycle hooks are not supported by Least:

- `UserPromptSubmit`, `SessionEnd`, `Stop`, `PreCompact`, `PostCompact`, `MessageDisplay`, prompt expansion hooks.
