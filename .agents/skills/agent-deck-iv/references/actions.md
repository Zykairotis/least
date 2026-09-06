# Agent Deck IV action catalog

Use this reference to select the narrowest operation that satisfies the request. Prefer normalized wrapper actions; use `raw` only for unsupported Agent Deck features.

## Discovery and inventory

| Wrapper action | Agent Deck mapping | Purpose |
| --- | --- | --- |
| `doctor` | version, help, status, profile list | Verify installation and machine-readable surfaces. |
| `version` | `version` | Return installed version. |
| `capabilities` | help inspection | Detect supported top-level and session commands. |
| `profiles` | `profile list --json` | List profiles and default profile. |
| `groups` | `group list --json` | List groups and status totals. |
| `sessions` | `list --json` | List persistent sessions. |
| `summary` | `status --json` | Return aggregate session state. |
| `show` | `session show <id> --json` | Read normalized session metadata. |
| `current` | `session current --json` | Detect current Agent Deck session when supported. |
| `ui-doctor` | `skill source list` + `skill list` | Verify that the containing skill directory is registered and that `agent-deck-iv` is visible to the Skills Manager. |
| `register-source` | `skill source add <name> <path>` | Register a skill directory after explicit confirmation. |
| `unregister-source` | `skill source remove <name>` | Remove a configured skill source after explicit confirmation. |

## Agent Deck UI semantics

- Skills appear in the Skills Manager only when their containing directory is a registered source.
- Skills can be attached only to Claude, Gemini, Codex, or Pi sessions in the tested Agent Deck interface.
- A skill cannot be opened or deleted as a session card. Attach or detach it from a supported session.
- Open, stop, archive, and remove operations apply to sessions.
- Stop a running or idle session before removal when Agent Deck requires it.
- `attach` requires an interactive terminal. In non-interactive execution, the wrapper returns the exact attach command instead of attempting to take over the terminal.

## Launch

`launch` maps to `agent-deck launch` and accepts:

- project path
- raw verified command through `--cmd`
- generated IV name through `--iv`
- skill root for IV discovery
- title and group
- parent session
- prompt or prompt file
- model
- idle timeout
- optional MCP and skill attachments
- optional worktree branch, new-branch flag, and location
- optional title lock and transition notification suppression

When `--iv` is used, load `<skill-root>/<iv>/references/tool-profile.json`, reject `unavailable`, and launch `<iv>/scripts/tool.py run`.

## Hierarchy and interaction

| Wrapper action | Agent Deck mapping | Purpose |
| --- | --- | --- |
| `children` | `session children <id> --json` | List child sessions and completion state. |
| `set-parent` | `session set-parent <child> <parent>` | Link an existing session as a child. |
| `unset-parent` | `session unset-parent <child>` | Remove the parent link. |
| `send` | `session send <id> <message>` | Send a follow-up instruction. |
| `output` | `session output <id> --json` | Retrieve the most recent response. |
| `attach` | `session attach <id>` | Attach interactively, replacing the wrapper process. |
| `focus` | `session focus <id>` | Focus the session in a running TUI. |

## Lifecycle

| Wrapper action | Agent Deck mapping | Safety |
| --- | --- | --- |
| `start` | `session start <id>` | Reversible mutation. |
| `stop` | `session stop <id>` | Stops process; preserves record and files. |
| `restart` | `session restart <id>` | Reversible but can interrupt work. |
| `revive` | `session revive --name <id>` | Attempts control-channel recovery. |
| `fork` | `session fork <id>` | Creates another session with supported context. |
| `archive` | `session archive <id>` | Stops and hides while retaining storage. |
| `unarchive` | `session unarchive <id>` | Restores archived record. |
| `remove` | `session remove <id>` | Destructive; requires confirmation. |

## Groups

| Wrapper action | Agent Deck mapping | Safety |
| --- | --- | --- |
| `create-group` | `group create <name>` | Creates organization metadata. |
| `move-group` | `group move <session> <group>` | Reorganizes a session. |
| `delete-group` | `group delete <name>` | Destructive; requires confirmation. |

## Agent Deck skills

| Wrapper action | Agent Deck mapping |
| --- | --- |
| `skill-list` | `skill list --json` |
| `skill-attached` | `skill attached <session> --json` |
| `skill-attach` | `skill attach <session> <skill>` |
| `skill-detach` | `skill detach <session> <skill>` |
| `skill-sources` | `skill source list --json` |

Agent Deck skills are materialized for launched tools and are distinct from the ChatGPT skill that contains this wrapper. The Skills Manager supports attachment and detachment; it does not turn a skill into an openable or deletable session card.

## MCPs

| Wrapper action | Agent Deck mapping |
| --- | --- |
| `mcp-list` | `mcp list --json` |
| `mcp-attached` | `mcp attached <session> --json` |
| `mcp-attach` | `mcp attach <session> <mcp>` |
| `mcp-detach` | `mcp detach <session> <mcp>` |

MCP attachment can modify agent configuration. Perform it only when requested.

## Worktrees

| Wrapper action | Agent Deck mapping | Safety |
| --- | --- | --- |
| `worktree-list` | `worktree list --json` | Read-only. |
| `worktree-info` | `worktree info <session> --json` | Read-only. |
| `worktree-finish` | `worktree finish <session>` | May merge, remove worktree, and remove session; requires confirmation. |
| `worktree-cleanup` | `worktree cleanup` | May delete orphaned resources; requires confirmation. |

Worktree creation is available through `launch`, but should be requested by the caller rather than silently enabled.

## Remotes and advanced features

The wrapper exposes `raw` for Agent Deck features that are not normalized, including remote instances, hook integrations, web UI, conductor, account migration, debug dumps, and updates.

Before `raw`, classify the command under [safety.md](safety.md). Require `--confirm` for any mutation and refuse `uninstall` through the wrapper.

## Output contract

For commands returning valid JSON, emit that JSON unchanged unless normalization is required. For text-only commands, emit:

```json
{
  "ok": true,
  "command": ["agent-deck", "..."],
  "exit_code": 0,
  "stdout": "...",
  "stderr": "..."
}
```

Errors use the same envelope with `ok: false` and preserve bounded stdout/stderr for diagnosis.
