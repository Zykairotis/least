---
name: agent-deck-iv
description: Operate Agent Deck as a cross-platform interactive invocation layer for local coding agents and custom IV tools. Use when an agent must inspect Agent Deck health, discover sessions/groups/profiles, launch a verified tool in a visible terminal, create parent-child agent trees, send follow-up instructions, retrieve output, attach interactively, control session lifecycle, attach skills or MCPs, inspect worktree associations, or perform approved cleanup. Prefer this skill over raw Agent Deck shell commands because it normalizes JSON, resolves custom IV profiles, and enforces confirmation for destructive actions.
---

# Agent Deck IV

Use Agent Deck as the session-control layer between an orchestrator and a verified coding-tool IV.

## Start with discovery

Run `scripts/agent_deck_iv.py doctor` on the first use of a host. Confirm the executable, version, JSON support, terminal backend, config location, and session registry are available.

Run `scripts/agent_deck_iv.py ui-doctor` before expecting this skill to appear in Agent Deck's Skills Manager. If the source is missing, register the containing skills directory explicitly with `register-source <name> <path> --confirm`.

Use `scripts/agent_deck_iv.py capabilities` when the installed Agent Deck version may differ from the documented interface.

## Understand the Agent Deck UI model

Treat skills and sessions as different objects:

- A skill is discovered from a registered source and attached to a supported Claude, Gemini, Codex, or Pi session. It is not an openable session card.
- A session is the object shown in the main UI. Open it with Enter or `attach`; stop it before removal when required.
- Use the Skills Manager to attach or detach a skill. Removing a skill source is a configuration operation, not session deletion.
- Do not promise that a skill can be opened, stopped, archived, or deleted like a session.

## Select the operation

Read [references/actions.md](references/actions.md) for the complete action catalog and command mapping.

Use the wrapper for deterministic operations:

- inventory and UI setup: doctor, ui-doctor, version, capabilities, tools, profiles, groups, sessions, summary, show, current, register-source, unregister-source
- launch: launch a raw verified command or resolve a `<tool>-iv` profile
- hierarchy: children, set-parent, unset-parent
- interaction: send, output, attach, focus
- lifecycle: start, stop, restart, revive, fork, archive, unarchive, remove
- organization: create-group, delete-group, move-group
- attachments: skills for supported Claude, Gemini, Codex, or Pi sessions; MCPs when requested
- worktrees: list and inspect by default; finish or cleanup only after confirmation
- advanced surfaces: remotes and raw pass-through when the requested action is not normalized

## Launch verified IV tools

Prefer `launch --iv <skill-name>` over embedding a harness command manually.

Resolve the IV from `<skill-root>/<skill-name>/references/tool-profile.json`. Require the profile to exist and not be `unavailable`. Launch its `scripts/tool.py run` wrapper so the executable and arguments remain owned by the IV.

Use `--parent` to create visible child sessions. Keep orchestration hierarchies explicit; do not add `--no-parent` when the user requested a subtree.

Use `--prompt-file` for long prompts. Avoid secrets in prompts, command arguments, wrappers, titles, persisted extra arguments, or Agent Deck configuration.

Do not create a worktree unless the caller explicitly requests one. Worktree planning belongs to the separate worktree layer.

## Observe and interact

Use JSON-capable commands for machine decisions. Treat Agent Deck's persistent session record, live tmux process, agent conversation, and worktree as separate resources.

Use `show` before lifecycle mutations. Use `output` for the latest agent response. Use `attach` only when an interactive terminal is available; otherwise return the session ID and attach command.

Use `children` to inspect a parent orchestration session. Use `send` only for a running session.

## Apply safety policy

Read [references/safety.md](references/safety.md) before cleanup, deletion, worktree completion, remote mutation, hook installation, updates, or raw commands.

Require `--confirm` for destructive wrapper actions. Never bypass the confirmation check by invoking `raw` with an equivalent destructive command.

Do not automatically:

- merge or delete worktrees
- force cleanup
- remove active sessions
- uninstall or update Agent Deck
- change accounts, authentication, hooks, remotes, or conductor infrastructure
- attach MCPs or skills not requested by the user
- launch unrestricted tool modes that the selected IV did not approve

## Verify outcomes

After launch or mutation:

1. Read the returned session ID.
2. Run `show` and verify path, group, command, parent, and status.
3. For live work, retrieve `output` or attach interactively.
4. For disposable tests, stop and remove only the created session.
5. Report unresolved states honestly; a persistent `error` record does not prove a live process exists.

## Compatibility

Use Python standard-library subprocess calls with argument arrays and `shell=False`. Resolve `agent-deck` from `AGENT_DECK_BIN`, `PATH`, and common user-local binary locations.

Support Windows, macOS, Linux, BSD-like systems, and other Python-supported hosts where Agent Deck is installed. Treat tmux-specific inspection as optional because Agent Deck may use a different backend on another host.
