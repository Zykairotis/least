# Fast Exploration Performance Plan for Least

> Goal: make Least substantially faster for repository exploration and light inspection work by removing avoidable MCP round trips, ensuring native fast search backends are used on the host OS, and only then expanding shell/backend flexibility for advanced execution.

## Executive Summary

The current slowdown is not primarily caused by PowerShell versus Bash. The larger problem is that Least steers agents toward many small structured calls such as `tree`, `search`, and `read`, while the fastest exploration patterns in real repos usually require:

- one fast file listing call
- one fast content search call
- one batched read or search-with-context call

Today Least already has some of the right building blocks, but they are not optimized for a Windows-hosted server talking to an agent that wants terminal-like speed:

- `search` can use `rg`, but its command detection is Unix-specific and can fail on native Windows hosts
- `tree` and `listFiles` are recursive Node filesystem walks rather than fast native file-list backends
- `read` is single-file only, which forces repeated round trips
- initial workspace opening still performs too much work by default
- the `bash` tool is positioned as a restricted verification tool rather than a fast exploration tool

The recommended implementation order is:

1. Fix native fast-search backend detection on Windows.
2. Make workspace opening cheaper by default.
3. Add dedicated high-throughput read-only exploration tools.
4. Update instructions and tool descriptions so models prefer those fast tools.
5. Add shell/backend selection for execution only after the exploration path is already fast.

This order gives the highest speed improvement for the lowest implementation and security risk.

---

## Problem Statement

### User-reported issue

The current exploration loop feels slow because agents are encouraged or forced to use many separate MCP calls such as:

- open workspace
- discover tools
- `tree`
- `search`
- `read`
- another `read`
- another `search`

This is materially slower than normal terminal-driven exploration such as:

```text
rg "truedata|clickhouse|market-data" scripts packages src
rg --files | rg "truedata|clickhouse"
git ls-files | rg "worker|backfill|analysis"
rg -n -C 2 "persistVolumeAnalysis" src scripts
```

### Environment split that matters

There are two separate runtime realities:

1. The coding agent in this session is running in WSL Bash.
2. Least itself is typically started by the user from Windows PowerShell.

That means performance-sensitive tool execution must be designed around the process that actually runs Least, not around the shell used by the remote coding agent.

If Least is a native Windows process, then the fastest and most reliable exploration path is usually:

- native Windows `rg.exe`
- native Windows `git.exe`
- direct Windows filesystem access

It is usually not ideal to route every exploration action through WSL unless Least itself also runs inside WSL.

---

## Current State Analysis

### 1. `search` already wants to be fast, but the backend detection is wrong for Windows

In [src/searchOps.ts](/mnt/x/least/src/searchOps.ts:26), `commandExists()` checks for a command by spawning `/bin/sh -lc 'command -v ...'`.

That is a real problem for a native Windows Least process:

- `/bin/sh` may not exist
- the check can fail even when `rg.exe` exists on `PATH`
- failure causes `search` to fall back to the slow Node-based scan in [src/searchOps.ts](/mnt/x/least/src/searchOps.ts:83)

The fallback path walks files, reads them, splits them into lines, and searches in JavaScript. That is acceptable as a last resort, but it is not acceptable as an invisible default for a Windows-hosted server.

### 2. `tree` and `listFiles` are safe but not optimal for speed

The `tree` implementation in [src/fsOps.ts](/mnt/x/least/src/fsOps.ts:107) recursively walks the filesystem using `readdir` and formatting logic. `listFiles()` in [src/fsOps.ts](/mnt/x/least/src/fsOps.ts:156) does another recursive filesystem walk.

These implementations are reasonable for correctness and portability, but they are not the fastest way to answer the questions agents actually ask first:

- what files exist that match a name pattern?
- what files under version control look relevant?
- what files mention a symbol or subsystem?

For those questions, `rg --files`, `git ls-files`, or a glob-oriented backend are generally faster and more useful than a rendered directory tree.

### 3. `read` is high-latency because it is single-file only

`readTextFile()` in [src/fsOps.ts](/mnt/x/least/src/fsOps.ts:213) reads one file and formats it with line numbers.

The implementation itself is not the worst problem. The main issue is the tool shape:

- one request per file
- one request per line range
- no batch mode
- no built-in search context mode

This means common workflows such as “show me the three relevant files around this symbol” require repeated request/response cycles.

### 4. Initial workspace open is heavier than it should be

The startup path still does too much by default.

`open_current_workspace` in [src/server.ts](/mnt/x/least/src/server.ts:798) defaults to:

- `include_tree=false`
- `include_skills=true`
- `include_global_skills=true`

`open_workspace` in [src/server.ts](/mnt/x/least/src/server.ts:1003) defaults to:

- `include_tree=true`
- `include_skills=true`
- `include_global_skills=true`

Then `workspaceSummary()` in [src/workspaceOps.ts](/mnt/x/least/src/workspaceOps.ts:148) still collects:

- skill inventory when requested
- git status
- recent commits via `git log`
- optional tree output

Global skill discovery can walk user/plugin locations such as `.codex/plugins/cache` in [src/capabilitiesOps.ts](/mnt/x/least/src/capabilitiesOps.ts:148). That is unnecessary overhead for many sessions whose first need is simply “open the repo and search for a symbol.”

### 5. The current `bash` tool is intentionally not the fast exploration path

The current model guidance explicitly tells clients not to use bash for file inspection and repository browsing in [src/server.ts](/mnt/x/least/src/server.ts:324) and in the `bash` tool description at [src/server.ts](/mnt/x/least/src/server.ts:1322).

On top of that, safe mode blocks inspection commands such as `cat`, `grep`, `rg`, `head`, and `tail` in [src/bashOps.ts](/mnt/x/least/src/bashOps.ts:70).

This is why the current system feels slower than a normal terminal workflow even though it does technically expose a shell tool.

### 6. On Windows, the current shell path is `cmd.exe`, not PowerShell

The shell selection logic in [src/bashOps.ts](/mnt/x/least/src/bashOps.ts:205) uses:

- `cmd.exe /d /s /c` on Windows
- `/bin/bash -lc` on non-Windows

That means the current execution model does not truly support PowerShell semantics as a first-class backend, even if the user launches Least from PowerShell.

---

## Root Cause Summary

The current slowdown is caused by a combination of design choices:

1. Too many small tool calls for common exploration workflows.
2. Slow fallback behavior when native fast search tools are not detected correctly.
3. Initial workspace-opening defaults that perform optional work too early.
4. Lack of batch-oriented read-only exploration tools.
5. Tool instructions that steer agents away from the fastest available exploration path.

The shell/backend issue is real, but it is not the first-order bottleneck.

---

## Goals

### Primary goals

1. Make repository exploration feel closer to `rg` plus `git ls-files` plus `head` speed.
2. Preserve Least's current safety model for blocked paths, secret redaction, and write controls.
3. Avoid forcing agents to rely on raw shell quoting for common read-only tasks.
4. Work well when Least runs as a native Windows process.

### Secondary goals

1. Support explicit backend selection for command execution.
2. Allow PowerShell, CMD, Bash, or WSL when advanced execution really needs them.
3. Improve future support for database and project-script adapters without exposing unrestricted shell access by default.

### Non-goals for the first iteration

1. Replacing all structured tools with raw shell commands.
2. Full PowerShell command parsing and security analysis.
3. Defaulting to WSL for every command on Windows.
4. Building a complete read-only terminal emulator.

---

## Recommended Architecture

### Core principle

Use structured tools for the common read-only operations, but power those tools with the fastest native backend available on the host OS.

That means:

- search should use `rg` directly when available
- file listing should use `rg --files`, `git ls-files`, or another fast native backend
- multi-file reads should happen in one tool call
- shell backend selection should remain a lower-level execution concern, not the primary exploration interface

### Why this is better than a shell-first design

If Least tells agents to solve repo exploration by constructing arbitrary PowerShell/CMD/Bash/WSL command strings, it inherits:

- quoting differences
- path translation issues
- shell-specific escaping bugs
- more difficult policy enforcement
- more fragile UX for tool callers

If Least instead provides a handful of high-throughput read-only tools, it gets most of the speed benefit without exposing that complexity to every agent.

---

## Recommended Implementation Order

## Phase 0: Instrumentation and Baseline

### Objective

Measure where time is actually spent before and after changes.

### Changes

1. Add timing metrics around:
   - `open_current_workspace`
   - `open_workspace`
   - `tree`
   - `search`
   - `read`
2. In `search`, record which backend was used:
   - `ripgrep`
   - `node`
3. Add optional debug logging for tool latency and result size.

### Why this matters

Without timing data, it is easy to argue about shell preference while missing the actual bottleneck. The instrumentation should confirm:

- whether Windows `search` is falling back to Node
- how expensive global skill scanning is
- how often repeated `read` calls dominate wall-clock time

### Deliverables

- per-tool duration logging
- backend-use counters for `search`
- before/after comparison notes in docs or a benchmark script

---

## Phase 1: Fast Wins With Minimal Surface Change

### 1. Fix `rg` detection on Windows

### Objective

Ensure `search` reliably uses ripgrep when Least is running on Windows and `rg.exe` is installed.

### Proposed changes

1. Replace the `/bin/sh`-based `commandExists()` logic in [src/searchOps.ts](/mnt/x/least/src/searchOps.ts:26) with a platform-aware implementation.
2. On Windows, prefer one of:
   - `where rg`
   - direct spawn attempt of `rg --version`
   - startup-time capability detection cached in memory
3. On non-Windows, keep the direct spawn strategy but avoid shelling through `/bin/sh` if possible.
4. Cache command availability so Least does not repeat detection work on every search call.

### Recommendation

The cleanest approach is to attempt `spawn("rg", ["--version"])` once at startup, cache success, and use that cached capability during `search` calls.

### Expected payoff

High. This is likely the single most important fix for native Windows performance.

### 2. Make initial open cheaper by default

### Objective

Reduce the work done before the first useful search.

### Proposed changes

1. Change `open_current_workspace` defaults to:
   - `include_tree=false`
   - `include_skills=false`
   - `include_global_skills=false`
2. Change `open_workspace` defaults to match the same fast-open behavior.
3. Make recent commits optional rather than always included in `workspaceSummary()`.
4. Keep AGENTS detection and minimal git status if those remain operationally important.

### Recommendation

Introduce a minimal-open summary for first contact:

- workspace id
- root
- modes
- AGENTS presence/path
- concise git status

Everything else should be opt-in.

### Expected payoff

Medium to high. This reduces unnecessary startup cost and makes the first interaction feel much snappier.

### 3. Relax exploration guidance only where speed-safe alternatives exist

### Objective

Stop forcing agents into suboptimal behavior once faster structured tools exist.

### Proposed changes

1. Update the general instructions in [src/server.ts](/mnt/x/least/src/server.ts:324).
2. Remove blanket language that makes `tree` the default exploration primitive.
3. Teach the model a better exploration order:
   - open workspace
   - file list/glob tool
   - search or search-with-context
   - read-many only for exact file content

### Expected payoff

Medium. Tool policy has a direct effect on agent behavior.

---

## Phase 2: Add High-Throughput Read-Only Exploration Tools

This phase is the main product improvement.

### 1. Add a `files` or `glob` tool

### Objective

Provide fast file discovery without recursive tree walking.

### Tool behavior

Suggested name:

- `files`

Suggested inputs:

- `workspace_id`
- `path`
- `glob`
- `tracked_only`
- `include_hidden`
- `max_results`

Suggested backend order:

1. `git ls-files` when `tracked_only=true`
2. `rg --files` when available
3. Node fallback walk as a last resort

Suggested outputs:

- flat file list
- result count
- truncated flag
- backend used

### Why it matters

Many exploration tasks do not need a tree at all. They need “show me candidate files quickly.”

### Recommendation

Make this the preferred tool for discovery. Keep `tree` for visualization and orientation, not as the default first step.

### 2. Add `search_context`

### Objective

Return search hits plus nearby code so agents do not immediately need follow-up `read` calls.

### Tool behavior

Suggested inputs:

- `workspace_id`
- `query`
- `regex`
- `path`
- `glob`
- `include_hidden`
- `before_lines`
- `after_lines`
- `max_matches`

Suggested backend:

- `rg -n -C <N>` when available
- Node fallback only if truly necessary

Suggested outputs:

- path
- matched line
- surrounding context block
- backend used
- truncated flag

### Why it matters

This replaces the common slow loop:

1. `search`
2. `read file A`
3. `read file B`
4. `read file C`

with one call.

### 3. Add `read_many`

### Objective

Allow one request to read several files or ranges.

### Tool behavior

Suggested inputs:

- `workspace_id`
- `items: [{ path, start_line?, end_line? }]`
- `max_total_bytes`

Suggested outputs:

- array of file blocks
- per-file line range metadata
- per-file SHA-256
- total byte count
- truncated flag

### Why it matters

Even with `search_context`, agents still need exact content reads sometimes. Those should be batchable.

### 4. Consider `json_query` as a repo-focused optional tool

### Objective

Reduce the need for `jq` in common structured inspection tasks.

### Tool behavior

Suggested inputs:

- `workspace_id`
- `path` or `glob`
- `pointer` or a small safe query syntax

### Recommendation

This is optional for the first performance push. It is useful, but not as important as `files`, `search_context`, and `read_many`.

---

## Phase 3: Execution Backend Selection

### Objective

Support the user's desired flexibility to run commands via PowerShell, CMD, Bash, or WSL when execution really needs shell-specific behavior.

### Important principle

This phase is useful, but it should not be the first speed fix. It is mainly about execution compatibility and control, not the core exploration bottleneck.

### Proposed config model

Add a new config field separate from `bashMode`, for example:

- `shellBackend: "auto" | "cmd" | "powershell" | "bash" | "wsl"`

Suggested environment variable and CLI flag:

- `LEAST_SHELL_BACKEND`
- `--shell-backend`

### Why it must be separate from `bashMode`

These are different concerns:

- `bashMode` controls whether and how shell execution is allowed
- `shellBackend` controls which shell or process host is used when shell execution happens

Combining them would create confusing semantics and poor UX.

### Backend recommendations

#### `auto`

Recommended default.

- Windows: prefer `cmd` or `powershell` based on explicit policy
- non-Windows: prefer `bash`

#### `powershell`

Use PowerShell Core if available, otherwise Windows PowerShell if explicitly supported.

Suggested forms:

- `pwsh -NoLogo -NoProfile -NonInteractive -Command`
- `powershell.exe -NoLogo -NoProfile -NonInteractive -Command`

#### `cmd`

Current behavior on Windows.

- `cmd.exe /d /s /c`

#### `bash`

Use native Bash only when present in the current host environment.

#### `wsl`

Use only as an explicit opt-in backend.

Suggested form:

- `wsl.exe bash -lc ...`

### Why `wsl` should not be default from a Windows Least host

Per-command WSL execution introduces:

- process boundary overhead
- path translation complexity between `X:\...` and `/mnt/x/...`
- quoting differences across Windows and Linux
- harder debugging and error handling

It is better as an advanced execution backend than as the main exploration path.

### Required companion work

1. Standardize how workspace-relative paths are passed into shell commands.
2. Define per-backend cwd handling.
3. Define path conversion rules for WSL.
4. Extend tests to validate each backend independently.

---

## Phase 4: Optional Read-Only Terminal Mode

### Objective

Allow some terminal-style exploration speed without opening the door to unrestricted shell execution.

### Recommendation

If this is implemented, do not make it the primary first step. Implement it only after the structured fast tools exist.

### Proposed mode split

Current:

- `off`
- `safe`
- `full`

Suggested future split:

- `off`
- `readonly`
- `full`

### `readonly` behavior

Allow commands such as:

- `pwd`
- `ls`
- `find`
- `git status`
- `git diff`
- `git ls-files`
- `rg`
- `head`
- `tail`

Still block:

- writes and destructive commands
- env-variable expansion for sensitive values
- path escape outside workspace
- network tools such as `curl` or `wget`
- chained shell expressions, redirects, and process substitution unless intentionally supported

### Important warning

This feature has meaningful security and parsing complexity, especially across PowerShell, CMD, Bash, and WSL. It should not replace dedicated exploration tools.

---

## Detailed Tool Recommendations

### Recommended first-class tools

1. `files`
2. `search`
   - keep existing name
   - ensure it reliably uses native `rg`
3. `search_context`
4. `read_many`
5. `show_changes`
   - already exists and is the right direction for review aggregation

### Tools to de-emphasize for first-pass exploration

1. `tree`
2. `read` for multi-file inspection
3. `bash` for repository browsing

### Suggested exploration workflow after implementation

1. `open_current_workspace`
2. `files` with a path or glob filter
3. `search_context` for a symbol or subsystem term
4. `read_many` only for exact target files
5. `show_changes` after edits

---

## Windows-Hosted Least Strategy

### Recommended production assumption

Design Least's fast exploration mode around the environment where Least itself runs.

If Least runs in Windows PowerShell:

- prefer native Windows binaries and filesystem access
- do not assume `/bin/sh`
- do not require WSL for basic repo exploration

### Recommended backend policy for Windows hosts

1. Structured read-only tools should use native binaries where possible.
2. `search` should prefer `rg.exe`.
3. `files` should prefer `git ls-files` or `rg --files`.
4. PowerShell should become a supported execution backend if the user wants it.
5. WSL should remain opt-in for Linux-specific tasks.

### Alternative long-term option

If the user wants maximum consistency and the repo can live comfortably inside WSL, the cleanest setup is:

- run Least inside WSL too
- keep repo paths native to WSL
- use Bash/Linux-native tools end to end

That is operationally clean, but it is a deployment choice, not a mandatory product requirement.

---

## Testing Plan

### Unit tests

1. Search backend detection:
   - Windows success path for `rg`
   - Windows failure path fallback to Node
   - non-Windows success path
2. Files tool backend selection:
   - `git ls-files`
   - `rg --files`
   - Node fallback
3. `read_many` validation:
   - blocked paths rejected
   - byte limits enforced
   - mixed file ranges handled correctly
4. Shell backend config parsing:
   - valid backends accepted
   - invalid backends rejected

### Integration tests

1. `open_current_workspace` fast mode returns quickly and omits optional data by default.
2. `search` reports `used: ripgrep` when `rg` is available.
3. `files` and `search_context` work on a representative test repo.
4. PowerShell backend executes a simple command on Windows hosts.
5. `cmd` backend remains backward compatible.
6. WSL backend path handling works when explicitly enabled.

### Performance tests

Benchmark at least these scenarios before and after changes:

1. open current workspace
2. list candidate files for a subsystem keyword
3. search for a symbol across `src` and `scripts`
4. inspect three related files

Capture:

- elapsed time
- number of tool calls required for the task
- backend used

The target is not only lower latency per call. It is fewer calls per successful exploration task.

---

## Risks and Tradeoffs

### 1. Shell-backend work can consume time without solving the main bottleneck

If implemented first, `shellBackend` may improve compatibility while leaving exploration speed mostly unchanged.

### 2. Cross-shell semantics are messy

PowerShell, CMD, Bash, and WSL differ in:

- quoting
- escaping
- glob expansion
- environment-variable syntax
- path semantics

This is why structured fast tools should remain the primary exploration interface.

### 3. Native tool assumptions must be carefully detected

Relying on `rg`, `git`, or PowerShell means Least must expose clear fallback behavior and diagnostics when they are unavailable.

### 4. Read-only shell mode adds policy complexity

A permissive but supposedly safe shell mode can become difficult to reason about across all supported backends.

---

## Final Recommendation

The best performance plan for Least is:

1. Fix Windows-native `rg` detection so `search` reliably uses the fast backend.
2. Make workspace open minimal by default.
3. Add `files`, `search_context`, and `read_many` as first-class fast read-only tools.
4. Update tool guidance so agents prefer those tools over `tree` plus repeated `read` calls.
5. Add `shellBackend` support afterward for execution compatibility, with `powershell` as a real backend and `wsl` as an explicit opt-in.

This sequence addresses the true bottleneck first: structured exploration throughput.

If only one improvement can be started immediately, it should be the Windows-native `rg` detection fix. If one larger product change is prioritized after that, it should be the addition of `files` plus `search_context`.

---

## Proposed Work Breakdown

### Milestone 1: Fast backend correctness

1. Fix `rg` detection.
2. Cache capability checks.
3. Add backend-use logging.

### Milestone 2: Faster first contact

1. Slim `open_current_workspace` defaults.
2. Slim `open_workspace` defaults.
3. Make git log optional.
4. Reduce default skill scanning.

### Milestone 3: High-throughput exploration tools

1. Implement `files`.
2. Implement `search_context`.
3. Implement `read_many`.
4. Update instructions and descriptions.

### Milestone 4: Shell backend support

1. Add `shellBackend` config.
2. Implement native PowerShell support.
3. Keep CMD compatibility.
4. Add explicit WSL backend.

### Milestone 5: Optional advanced read-only shell mode

1. Design `readonly` mode.
2. Implement carefully per backend.
3. Treat as optional, not required for the main speed win.

---

## Open Questions

1. Should `open_current_workspace` still include git status by default, or should even that become opt-in for a strict fast-open mode?
2. Should the new `files` tool prefer `git ls-files` or `rg --files` by default when both are available?
3. Should `search_context` replace the current `search` output format, or should it be a separate tool?
4. Is PowerShell Core (`pwsh`) required, or is Windows PowerShell support sufficient for the first Windows backend release?
5. Does the project want a single fast mode that changes defaults globally, or should fast behavior be exposed through explicit flags and per-tool options?

---

## Immediate Next Step

Implement Phase 1 before touching shell-backend expansion:

1. fix `rg` detection on Windows
2. make open defaults lighter
3. add timing instrumentation

That will validate the bottleneck and create a clean base for the new high-throughput exploration tools.
