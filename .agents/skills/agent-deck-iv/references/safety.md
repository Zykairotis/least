# Safety policy

Classify every operation before execution.

## Read-only

Run without confirmation:

- doctor, version, capabilities
- profiles, groups, sessions, summary, show, current
- children, output
- skill-list, skill-attached, skill-sources
- mcp-list, mcp-attached
- worktree-list, worktree-info
- remote list and remote sessions through `raw`

## Reversible mutations

Require a clear user request, but not a second confirmation:

- launch, send, focus
- start, stop, restart, revive, fork
- archive, unarchive
- set-parent, unset-parent
- create-group, move-group
- skill-attach, skill-detach
- mcp-attach, mcp-detach

Before mutating an existing session, run `show` unless the session was created earlier in the same workflow.

## Destructive or high-impact

Require the wrapper's `--confirm` flag and an explicit user request:

- remove session
- delete group
- worktree finish
- worktree cleanup
- raw remote removal or update
- raw hook install or uninstall
- raw conductor setup or teardown
- raw Agent Deck update
- raw cleanup with `--yes` or force flags
- raw session property changes affecting path, command, wrapper, tool, or account

Never invoke `agent-deck uninstall` through this skill.

## Command and credential handling

- Use argument arrays and `shell=False` in the wrapper.
- Treat Agent Deck's `--cmd` value as persisted configuration. Do not place secrets in it.
- Do not place secrets in titles, prompts, prompt files, MCP names, skill names, extra arguments, environment overrides, or wrappers.
- Do not read or copy authentication stores unless the user explicitly requests a supported account operation.
- Do not infer permission bypass flags. The selected IV owns approval of unrestricted modes.
- Reject generated IV profiles whose status is `unavailable`.
- Report `needs-review` profiles before launch and require `--allow-needs-review`.

## Session state distinctions

Do not conflate:

- persistent Agent Deck record
- live tmux or other terminal process
- underlying agent conversation
- project directory
- Git worktree and branch

A session marked `error` can be a stale registry entry. A session record can remain after the terminal exits. A stopped session can still retain files and conversation metadata.

## Worktree policy

Do not create a worktree unless requested. Do not finish, merge, delete, or force-clean a worktree automatically. The future worktree orchestrator should own planning and integration policy.

## Cleanup policy

For disposable tests:

1. Use a unique title prefix.
2. Record the returned session ID.
3. Stop the session if running.
4. Remove only that recorded session with confirmation.
5. Do not run broad cleanup.
