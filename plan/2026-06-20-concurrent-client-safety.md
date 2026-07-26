# Concurrent Client Safety Plan for Least

> Goal: make it safe and predictable for two remote clients such as ChatGPT and Grok to connect to the same Least workspace at the same time without corrupting files, overwriting each other's edits, or running mutating commands against stale state.

## Executive Summary

Least now supports exposing one local workspace to multiple public clients on the same host. That solves connectivity, but it does not solve concurrency. Two connectors can still read, edit, and execute commands against the same repo at overlapping times. The current system is transport-safe but not mutation-safe.

This plan recommends a staged solution:

1. Add a workspace mutation lock with explicit ownership.
2. Add automatic lock leases so abandoned locks do not block the system forever.
3. Add optimistic stale-state checks to `write` and `edit` so even the lock owner cannot blindly overwrite newer file content.
4. Add optional read-only secondary-client behavior for safer operational defaults.
5. Keep full per-client workspace isolation and git-worktree-based isolation as future enhancements, not part of the first implementation.

The recommended first production version is:

- one writer at a time per workspace
- concurrent reads allowed
- mutation tools require a lock lease
- `write` and `edit` reject stale mutations based on file hash or expected content version
- lock state is visible through existing status/config tools and a new lock-status tool

This is the best balance of correctness, UX, and implementation cost for Least.

---

## Problem Statement

### Current behavior

Today Least allows multiple HTTP/MCP sessions to exist concurrently. This is valid and useful for:

- one client reading while another edits
- one client reviewing while another plans
- one client running diagnostics while another inspects docs

However, the current system does not coordinate mutation access. That means two clients can:

- edit the same file at the same time
- edit different files in the same feature branch while assuming stale repo state
- run commands such as build, test, install, or codegen while files are being changed underneath them
- produce diffs and review summaries that no longer correspond to the state originally observed

### Failure modes to prevent

The solution must prevent or at least make explicit the following behaviors:

1. Blind overwrite of a file modified by another client after the first client read it.
2. Simultaneous `write`, `edit`, or mutating `bash` calls from different clients against one workspace.
3. Mutation ownership becoming permanently stuck when a client disconnects or crashes.
4. Confusing operator UX where both clients appear to have full mutation authority at once.
5. Review tools showing changes produced by multiple overlapping actors without attribution or lock state.

### Non-goals for v1

This plan deliberately does not try to solve:

- semantic merge of overlapping edits from two clients
- conflict-free replicated editing
- full distributed transaction semantics across multiple tools
- separate token issuance per client
- full workspace cloning or per-client git branch automation in the first release

---

## Option Review and Ratings

The following approaches were considered.

### 1. Single-writer model

**Description**

Allow multiple clients to connect, but only one client may perform mutating actions at a time.

**Strengths**

- simplest mental model
- easiest to explain to users
- lowest implementation risk
- consistent with how local coding agents are typically used

**Weaknesses**

- may feel restrictive if users expect true parallel implementation
- needs explicit ownership and timeout handling to avoid deadlock

**Rating**: 9.5/10

### 2. Explicit session locking

**Description**

Introduce `acquire_workspace_lock` and `release_workspace_lock`. Mutating tools require lock ownership.

**Strengths**

- clear ownership
- preserves concurrent reads
- easy to audit and debug
- maps well to Least's workspace abstraction

**Weaknesses**

- requires lock lifecycle UX
- can be annoying if the user forgets to release the lock

**Rating**: 9.5/10

### 3. Lease-based locking

**Description**

Locks expire automatically unless renewed by the current owner.

**Strengths**

- avoids abandoned locks
- better operational resilience than permanent locking
- good fit for browser-based or session-based clients

**Weaknesses**

- slightly more complex than a simple lock
- requires clear expiration semantics

**Rating**: 9.5/10

### 4. Optimistic stale-state checks

**Description**

Require a file hash, content version, or expected pre-edit state for mutation tools. Reject writes if the file has changed since the client last observed it.

**Strengths**

- blocks stale overwrites
- complements locking well
- protects against accidental misuse by the lock holder
- fits existing `read` tool behavior because `read` already returns `sha256`

**Weaknesses**

- adds some friction for tool callers
- requires tool contract changes

**Rating**: 9/10

### 5. Read-only secondary client

**Description**

Allow one full-access client and force other sessions into read-only mode.

**Strengths**

- easy operational policy
- very safe when one client is only reviewing
- low complexity

**Weaknesses**

- policy, not full correctness
- less flexible than lock/lease-based control

**Rating**: 7.5/10

### 6. Queue mutating operations

**Description**

Serialize writes and mutating commands through one server-side queue.

**Strengths**

- prevents simultaneous mutations
- preserves availability for both clients

**Weaknesses**

- hides ownership
- harder to explain when queued operations execute after the user context has changed
- risk of long-running queued commands acting on outdated assumptions

**Rating**: 7/10

### 7. Git branch or git-worktree isolation

**Description**

Each client gets its own branch or `git worktree` and works in isolation.

**Strengths**

- strongest isolation short of full copies
- good path to true parallel implementation
- grounded in supported Git workflows

**Weaknesses**

- much higher UX and implementation cost
- requires branch/worktree management, merge/review strategy, cleanup, and path remapping

**Rating**: 8.5/10

### 8. Path-scoped ownership

**Description**

Assign different folders or files to different clients.

**Strengths**

- sounds flexible in theory

**Weaknesses**

- fails quickly when changes cross shared configs, tests, types, docs, or imports
- hard to enforce cleanly

**Rating**: 5.5/10

### Final recommendation

Implement **lease-based session locking plus optimistic stale-state checks** as the main solution. Optionally allow a read-only secondary-client mode later as an operator-facing convenience. Keep git worktree isolation as a separate future roadmap item.

---

## Recommended Architecture

## Core design principles

1. Multiple clients may read concurrently.
2. Only one client may mutate a workspace at a time.
3. Mutating actions must be denied if lock ownership is absent.
4. Mutating actions must also be denied if file state is stale.
5. Lock ownership must recover automatically after disconnect or lease expiry.
6. The system must make lock state visible in normal status tooling.

## Workspace lock model

Introduce one mutation lock per opened workspace.

Suggested internal shape:

```ts
type WorkspaceLock = {
  workspaceId: string;
  ownerSessionId: string;
  ownerLabel?: string;
  acquiredAt: string;
  expiresAt: string;
  lastRenewedAt: string;
  mode: "exclusive";
};
```

The lock is server-local and in-memory for v1.

Rationale:

- Least already behaves like a session-oriented local bridge.
- Persisting locks to disk is unnecessary and potentially harmful because stale lock files after process exit create avoidable support problems.

## Session identity

Use MCP transport session identity as the primary owner key.

For HTTP MCP:

- use the existing MCP session ID established during initialize
- tie lock ownership to that session ID

For stdio or non-session contexts, if needed later:

- synthesize a stable in-process owner ID

For audit visibility, allow an optional human label:

- `client_label`
- examples: `chatgpt`, `grok`, `gpt-review`, `grok-docs`

This is cosmetic, not security-sensitive.

## Lease policy

Recommended defaults:

- lease duration: 120 seconds
- automatic renewal on every successful mutating tool call
- explicit renewal tool available for long editing sessions
- server prunes expired locks opportunistically during tool calls and on a timer

Behavior:

- if a client acquires the lock and goes idle, the lock expires after 120 seconds
- another client can then acquire the lock
- if the original client tries to mutate after expiration, it gets a lock error and must reacquire

## Lock acquisition semantics

`acquire_workspace_lock`:

- succeeds if no active lock exists
- succeeds idempotently if the requesting session already owns the lock
- fails with structured lock-owner metadata if another session owns the lock

`release_workspace_lock`:

- succeeds if the caller owns the lock
- succeeds as a no-op if no lock exists and the caller asks to release
- fails if another session owns the lock, unless an explicit force-release capability is later added

No force-release in v1. Let the lease expire instead.

## Which tools require the lock

Require lock ownership for:

- `write`
- `edit`
- `bash` when the command is considered mutating or the server is in `bash=full`
- any future tool that can modify files or repo state

Do not require the lock for:

- `read`
- `search`
- `tree`
- `git_status`
- `git_diff`
- `show_changes`
- `server_config`
- `open_workspace`
- `open_current_workspace`
- `read_handoff`
- `codex_context`

Special handling for `bash`:

- In `safe` mode, even commands that look non-mutating should require the lock only if they are project-state-changing.
- In `full` mode, require the lock for all `bash` commands because the server cannot reliably infer whether the shell command mutates state.

This is intentionally conservative.

---

## Public Tool and Interface Changes

## New tools

### `workspace_lock_status`

Purpose:

- inspect whether the workspace is currently locked for mutation

Input:

- `workspace_id?: string`

Output fields:

- `locked: boolean`
- `owner_session_id?: string` (redacted/truncated if needed)
- `owner_label?: string`
- `acquired_at?: string`
- `expires_at?: string`
- `seconds_remaining?: number`

### `acquire_workspace_lock`

Purpose:

- acquire or re-acquire the workspace mutation lease

Input:

- `workspace_id?: string`
- `client_label?: string`

Output fields:

- `acquired: boolean`
- `workspace_id: string`
- `owner: boolean`
- `owner_label?: string`
- `acquired_at: string`
- `expires_at: string`
- `seconds_remaining: number`
- if denied:
  - `locked_by_other: true`
  - `current_owner_label?: string`
  - `current_expires_at?: string`

### `renew_workspace_lock`

Purpose:

- extend the current session's lease without performing a mutation

Input:

- `workspace_id?: string`

Output fields:

- `renewed: boolean`
- `expires_at: string`
- `seconds_remaining: number`

### `release_workspace_lock`

Purpose:

- release the current session's lock voluntarily

Input:

- `workspace_id?: string`

Output fields:

- `released: boolean`
- `was_owner: boolean`

## Mutating tool contract changes

### `write`

Add optional but recommended stale-state argument:

- `expected_sha256?: string`

Behavior:

- if `expected_sha256` is provided and the current file exists with a different sha256, reject with conflict
- if the file does not exist and `expected_sha256` is provided, reject unless the caller explicitly indicated file creation is expected

Recommended extra field:

- `expect_absent?: boolean`

This avoids ambiguity when creating new files.

### `edit`

Add optional stale-state argument:

- `expected_sha256?: string`

Behavior:

- if provided and the file sha256 differs, reject before attempting the edit
- existing exact-match logic remains in place after the hash check

### `bash`

No new user-facing argument required for v1.

Behavioral change only:

- require lock ownership for mutating shell access
- in `full` mode, require the lock for all `bash` invocations

## Error shape for lock conflicts

Standardize a structured error body for mutation denial:

```json
{
  "error": "workspace_locked",
  "message": "Workspace is locked by another session.",
  "workspace_id": "ws_...",
  "owner_label": "grok",
  "expires_at": "2026-06-20T12:00:00.000Z",
  "seconds_remaining": 51
}
```

Standardize a stale-write conflict shape:

```json
{
  "error": "stale_file_state",
  "message": "Refusing to modify file because it changed since the caller last read it.",
  "path": "src/http.ts",
  "expected_sha256": "...",
  "actual_sha256": "..."
}
```

---

## Internal Implementation Plan

## 1. Add a lock manager

Create a small in-memory manager module responsible for:

- storing one lock per workspace
- checking ownership by session ID
- pruning expired locks
- acquiring, renewing, releasing, and reading status

Recommended API:

```ts
type LockAcquireResult =
  | { ok: true; lock: WorkspaceLock; alreadyOwned: boolean }
  | { ok: false; reason: "owned_by_other"; lock: WorkspaceLock };

interface WorkspaceLockManager {
  get(workspaceId: string): WorkspaceLock | undefined;
  acquire(workspaceId: string, ownerSessionId: string, ownerLabel?: string): LockAcquireResult;
  renew(workspaceId: string, ownerSessionId: string): WorkspaceLock | undefined;
  release(workspaceId: string, ownerSessionId: string): { released: boolean; wasOwner: boolean };
  requireOwner(workspaceId: string, ownerSessionId: string): WorkspaceLock;
  prune(): void;
}
```

Recommended location:

- either a new dedicated module such as `src/workspaceLocks.ts`
- or colocated with workspace/session infrastructure if that already exists

## 2. Thread session identity into tool handlers

Today the tool handlers focus on workspace ID and path resolution. The lock layer needs session context.

Implementation requirement:

- when an MCP request arrives, identify the MCP session ID associated with that transport
- make that session ID available to mutation tools during the request

Recommended approach:

- extend the request/tool invocation pipeline so each handler can access a `sessionContext`
- include:
  - `sessionId`
  - optional `surface`
  - optional `clientLabel`

Do not try to infer client identity from bearer token because the token is shared.

## 3. Enforce lock ownership in mutation tools

Before executing mutation logic, call the lock manager.

For `write` and `edit`:

1. resolve workspace
2. require lock owner
3. perform stale-state validation if provided
4. execute the mutation
5. renew the lease on success

For `bash`:

1. resolve workspace
2. if command requires mutation protection, require lock owner
3. execute command
4. renew lease on success

## 4. Reuse existing file hashes for stale checks

The current `read` tool already returns `sha256`. Use that as the primary optimistic-concurrency token.

Recommended client flow:

1. `read path`
2. capture returned `sha256`
3. call `edit` or `write` with `expected_sha256`

This avoids inventing a second versioning mechanism.

## 5. Surface lock state in status tools

Enhance the following tools to include lock information in structured output:

- `server_config`
- `open_current_workspace`
- `open_workspace`
- `workspace_snapshot`
- `show_changes` optionally, if practical

Recommended minimum:

- include a `lock` object in structured content when a workspace is opened or inspected

This helps both humans and clients understand whether mutation is currently available.

## 6. Add optional read-only secondary-client mode later

Not part of the first mutation-safety implementation, but easy to layer on top.

Potential flags:

- `--secondary-readonly`
- `LEAST_SECONDARY_READONLY=1`

Behavior:

- sessions that do not own the current mutation lock are allowed read tools only
- lock owner retains full capabilities

This is optional because the lock-based model already blocks unsafe mutation.

---

## Command and Mode Semantics

## Default policy for v1

Recommended default:

- lock enforcement is enabled only when explicitly configured at first rollout

Reason:

- this changes mutation semantics substantially
- some existing workflows may rely on immediate write capability without lock acquisition

Recommended launcher/config knob:

- `LEAST_CONCURRENCY_MODE=off|lock|lease`

Definitions:

- `off`: current behavior, no lock enforcement
- `lock`: explicit lock required, no automatic expiry
- `lease`: explicit lock required, lock expires automatically

Recommended default after rollout confidence:

- move default from `off` to `lease`

For a simpler implementation, it is acceptable to skip `lock` and support only:

- `off`
- `lease`

That is likely preferable.

## Recommended final setting set

- `LEAST_CONCURRENCY_MODE=lease`
- `LEAST_LOCK_LEASE_MS=120000`

Optional CLI support:

- `--concurrency off|lease`
- `--lock-lease-ms <ms>`

These should also round-trip through saved settings if launcher-managed settings are preserved there.

---

## Tool UX Guidance

Least should guide the remote client to use the feature correctly.

Recommended instruction updates for the MCP server:

- when multiple clients may connect, acquire the workspace lock before any mutating operation
- prefer `read` to capture `sha256` before `write` or `edit`
- if a lock conflict occurs, report the owner and remaining lease time instead of retrying aggressively

Suggested tool descriptions:

- `acquire_workspace_lock`: acquire exclusive mutation rights for this workspace
- `renew_workspace_lock`: extend the current mutation lease
- `release_workspace_lock`: release mutation rights when finished
- `workspace_lock_status`: inspect current mutation ownership

---

## Testing Plan

## Unit tests

Add focused tests for the lock manager:

1. acquire when unlocked
2. acquire again by same owner
3. acquire by different owner while locked
4. renew by owner
5. renew by non-owner
6. release by owner
7. release by non-owner
8. automatic expiry after lease timeout
9. prune removes expired locks

## Tool-level tests

Add tests for:

1. `write` without lock => `workspace_locked`
2. `edit` without lock => `workspace_locked`
3. `bash` in full mode without lock => `workspace_locked`
4. `write` with lock => success
5. `edit` with lock => success
6. `write` with stale `expected_sha256` => `stale_file_state`
7. `edit` with stale `expected_sha256` => `stale_file_state`
8. lock renewal after successful mutation extends `expires_at`

## Session-level tests

Test two independent MCP sessions against the same workspace:

1. session A acquires lock
2. session B can still `read`
3. session B cannot `write`
4. session A releases lock
5. session B can now acquire and mutate

## Launcher and settings tests

If launcher flags are added, test:

1. `least settings set --concurrency lease`
2. `least settings show` displays concurrency mode and lease duration
3. `least start` carries the mode into server env
4. `least doctor` displays concurrency mode readiness when enabled

## Smoke tests

Add a dedicated smoke script for concurrent clients, for example:

- `scripts/concurrency-lock-smoke.mjs`

Scenarios to cover:

1. two MCP clients connect to one workspace
2. first client acquires lock
3. second client reads successfully
4. second client fails to write with lock error
5. first client writes successfully
6. second client later acquires after release or expiry
7. stale hash rejection is enforced

## Manual validation

Manual test matrix:

1. ChatGPT holds lock, Grok tries to edit => denied with helpful owner/lease data
2. Grok holds lock, ChatGPT reads and searches => succeeds
3. lock owner disconnects or goes idle => lock expires and another client can acquire
4. client uses stale hash after another client changed file => rejected with stale-state conflict

## Acceptance criteria

The feature is complete when:

1. no two remote sessions can mutate one workspace at the same time
2. stale file overwrites are rejected even for the lock owner
3. lock ownership is visible and understandable
4. abandoned locks recover automatically
5. concurrent reads still work normally
6. existing non-concurrency modes remain usable

---

## Rollout Strategy

## Phase 1

Ship behind an explicit config flag:

- `LEAST_CONCURRENCY_MODE=lease`

Keep default off.

## Phase 2

Exercise with:

- ChatGPT + Grok dual-client users
- long-running sessions
- mixed read/write workflows

Collect practical feedback on:

- lease timeout length
- whether manual renewal is needed often
- whether `bash` lock requirements are too strict

## Phase 3

If stable, make `lease` the default for public-tunnel modes and dual-client mode.

Recommended policy for that step:

- default `lease` when public tunnel is enabled
- allow `off` only by explicit override for advanced users

---

## Future Work

Not part of the first implementation, but worth documenting.

### 1. Secondary-client read-only mode

Useful policy layer on top of locking.

### 2. Per-client labels from connector surface

Auto-label sessions as:

- `chatgpt`
- `grok`
- `openai-v1`

This would improve lock status visibility.

### 3. Per-client worktree isolation

If true simultaneous implementation is later needed, add optional `git worktree` support so each client edits a separate checkout.

### 4. Mutation audit trail

Record lock acquisition, release, and mutation denials in a bounded session log for debugging.

### 5. Force release for local operator only

Potential future CLI-only command:

- `least unlock-workspace --root <dir>`

Do not expose force-unlock as a remote MCP tool in the first version.

---

## Final Recommendation

Implement **lease-based exclusive mutation locking plus optimistic stale-file checks**.

Do not start with queues, path ownership, or per-client worktrees.

The concrete first implementation should include:

- one in-memory lock per workspace
- `workspace_lock_status`
- `acquire_workspace_lock`
- `renew_workspace_lock`
- `release_workspace_lock`
- lock enforcement on `write`, `edit`, and mutating `bash`
- `expected_sha256` support for `write` and `edit`
- smoke tests for two simultaneous clients

That gives Least a clear, robust concurrency story with minimal conceptual overhead and without changing its core local-bridge architecture.
