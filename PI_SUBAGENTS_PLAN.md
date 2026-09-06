# Void Desktop Pi Native Subagents — Implementation Plan

## Status

Planning / handoff document only. No feature code has been modified as part of this planning step.

## Repository

- Workspace: `/home/mewtwo/ZSSD/void-desktop`
- Local repository: `https://github.com/Zykairotis/void-desktop`
- Upstream repository: `https://github.com/pingdotgg/t3code`
- Baseline branch: `sync-upstream`
- Verified baseline commit: `31195874a` — `merge: sync upstream main into sync-upstream`
- Feature branch to create before implementation: `feat/pi-subagents`

## Product / package identity

Preserve Void identity throughout the implementation:

- `@zykairotis/void-contracts`
- `@zykairotis/void-client-runtime`
- `@zykairotis/void-shared`
- Product naming: `Void`, `void`, `VOID_*`
- Pi runtime must be resolved through `VOID_PI_ROOT` and/or configured executables.
- Never introduce a machine-specific absolute Pi path.
- Do not edit `/home/mewtwo/ZSSD/pi-void`.

## Goal

Add native Pi child-agent / subagent observability to Void Desktop and expose provider-neutral subagent state in Web and Mobile.

V1 must provide:

- Native Pi child-agent creation and tracking.
- Stable parent/child identity.
- Lifecycle states: `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, `stopped`.
- Current activity / progress.
- Last tool.
- Token/tool usage where Pi exposes it.
- Parent agent ID where Pi exposes it.
- Spawn turn ID and latest turn ID derived from canonical thread activities.
- Recent activity entries.
- Provider-neutral normalized client snapshots.
- Server persistence/projection into thread activities.
- Web Agents panel and compact live status strip.
- Basic Mobile visibility.
- Regression coverage for existing providers.

## Explicitly deferred from V1

Do not expand the first implementation into any of the following:

- Subprocess fallback.
- Parallel worker pools.
- Background job orchestration.
- Custom agent profiles.
- Recursive delegation.
- Workflow phases / workflow execution.
- Full orchestration-v2 migration.
- Cross-provider handoff.
- Agent-spawn controls in the UI.
- Reworking Claude/Codex behavior beyond additive compatibility required by the shared contract.

## Architectural constraints

- `apps/server` owns provider adapters, orchestration, lifecycle, ingestion, persistence, WebSocket/RPC behavior.
- `apps/web` owns browser UI.
- `apps/mobile` owns mobile UI.
- `packages/contracts` owns canonical wire schemas.
- `packages/client-runtime` owns provider-neutral client derivation/state.
- `packages/shared` owns small provider-neutral helpers.
- Provider-specific logic must stay inside provider adapter/runtime layers.
- The Web/Mobile UI must not contain `provider === "pi"` branches for subagent behavior.
- Existing Claude, Codex, Cursor, Grok, and OpenCode behavior must remain intact.
- Do not wholesale merge any upstream subagent/orchestration branch.
- Do not reset, overwrite, or discard existing Void/Pi changes.

## Verified current architecture

Void already has the correct canonical transport path for most of this feature:

```text
Pi JSONL
   ↓
apps/server/src/provider/Layers/PiRpcClient.ts
   ↓
apps/server/src/provider/Layers/PiAdapter.ts
   ↓
ProviderRuntimeEvent
   ↓
apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
   ↓
thread.activity.append
   ↓
persisted OrchestrationThread.activities
   ↓
packages/client-runtime state derivation
   ↓
Web / Mobile
```

Important current facts:

1. `PiRpcClient.ts` is already a generic JSONL transport. Unknown Pi event objects are passed through as `PiAgentEvent`; they are not semantically normalized there.
2. `PiAdapter.ts` is therefore the correct Pi-specific semantic normalization boundary.
3. The current canonical provider runtime already includes:
   - `task.started`
   - `task.progress`
   - `task.completed`
4. `ProviderRuntimeIngestion.ts` already persists these task events into `OrchestrationThreadActivity` rows.
5. Claude already emits canonical `task.*` events in the current Void tree.
6. The safest implementation is to enrich the existing `task.*` path rather than create a second Pi-only subagent protocol.

## Existing Pi event surface already handled

`PiAdapter.ts` currently handles parent/session lifecycle and tools such as:

- `agent_start`
- `turn_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `agent_end`
- `agent_settled`
- `compaction_start`
- `compaction_end`

`PiAdapter.test.ts` has fixture coverage for these parent/runtime events.

Do not assume native child-agent event names from memory. The first implementation task is to discover the actual Pi child-agent wire events and their field semantics.

## Upstream reference material

Local remote refs currently available:

```text
upstream/t3code/native-subagent-observability
upstream/t3code/subagent-workflow-sidebar
upstream/subagent-obs/01-contracts
upstream/subagent-obs/03-reuse
upstream/subagent-obs/04-agents-panel
upstream/subagent-obs/05-thread-visibility
```

The local `upstream/t3code/native-subagent-observability` ref was observed at:

```text
3585e6342 refactor(server): canonical make/layer exports + bucket reclassification fix
```

GitHub code search also surfaced a newer indexed implementation at commit:

```text
45d9aa90baab8f2d6b13c7ae3cf2f97128edaf7b
```

Useful upstream files to study selectively:

```text
packages/contracts/src/providerRuntime.ts
packages/contracts/src/orchestration.ts
packages/client-runtime/src/state/subagentRuntime.ts
packages/client-runtime/src/state/subagentRuntime.test.ts
apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
apps/server/src/orchestration/ThreadBackgroundLiveness.ts
apps/server/src/orchestration/ThreadBackgroundLiveness.test.ts
apps/server/src/provider/Layers/ClaudeAdapter.ts
apps/server/src/provider/Layers/CodexAdapter.ts
apps/server/src/provider/Layers/CodexSessionRuntime.ts
apps/server/src/provider/testFixtures/codexMultiAgentWire.json
apps/web/src/components/AgentsPanel.tsx
apps/web/src/components/RightPanelTabs.tsx
apps/web/src/rightPanelStore.ts
apps/web/src/components/chat/MessagesTimeline.tsx
apps/web/src/components/chat/MessagesTimeline.logic.ts
apps/mobile/src/lib/threadActivity.ts
apps/mobile/src/lib/threadActivity.test.ts
```

Use the upstream code as a reference only. Adapt names, schemas, storage keys, edition gates, and architecture to Void. Do not cherry-pick broad commits without first inspecting their complete diff.

A diff of the native-subagent branch against `sync-upstream` touches hundreds of unrelated files and even removes the Void Pi implementation because upstream T3 does not carry it. This confirms that wholesale merging is unsafe.

---

# Execution Plan

## Phase 0 — Branch and safety checks

Before implementation:

```bash
git status --short
git log -1 --oneline --decorate
git switch -c feat/pi-subagents sync-upstream
```

Expected starting commit:

```text
31195874a
```

If the worktree is not clean, stop and inspect every existing change. Do not reset or overwrite user work.

### Gate

- Branch is `feat/pi-subagents`.
- Base is `31195874a` unless intentionally rebased later.
- Existing work is preserved.

---

## Phase 1 — Read-only Pi native child-agent wire audit

This is the first task. Do not modify feature code before completing this audit.

### Inspect

```text
apps/server/src/provider/Layers/PiRpcClient.ts
apps/server/src/provider/Layers/PiAdapter.ts
apps/server/src/provider/Layers/PiAdapter.test.ts
apps/server/src/provider/Layers/PiProvider.ts
apps/server/src/provider/Services/ProviderAdapter.ts
packages/contracts/src/providerRuntime.ts
```

Also inspect the configured Pi runtime source through `VOID_PI_ROOT` if available, but do not edit that external runtime.

### Determine the real Pi child lifecycle

For every native child-agent event, identify:

- Raw event `type`.
- Native child-agent ID.
- Parent-agent ID, if present.
- Spawn tool/use ID, if present.
- Title / description.
- Role / profile.
- Model.
- Status.
- Current activity/progress.
- Current or last tool.
- Input/output/cache/reasoning tokens.
- Tool-use count.
- Duration, if present.
- Completion result.
- Error/failure representation.
- Stop/abort/interruption representation.
- Whether usage frames are cumulative or deltas.
- Whether child events carry turn/session identity directly or must inherit it from the active parent turn.

### Produce an audit table

Before code changes, write down a mapping like:

```text
Pi raw event
  → semantic meaning
  → stable identity source
  → canonical ProviderRuntimeEvent
  → canonical fields available
  → missing data / reconstruction rule
```

### Identity rule

Use stable identity in this order:

```text
native Pi child-agent ID
    >
native Pi task/run ID
    >
spawn toolCallId only if Pi itself uses it as lifecycle identity
```

Never derive identity from:

- title
- prompt text
- array position
- timestamps
- current tool name

For direct children of the root Pi session, use `parentAgentId = null` unless Pi exposes a genuine root agent ID.

### Gate

Do not continue until:

- Child creation can be identified reliably.
- Completion/failure/stopping can be matched to the same stable child ID.
- Usage semantics are understood.
- The Pi event shapes are documented in tests/fixtures or audit notes.

---

## Phase 2 — Minimal provider-neutral contracts

### Primary files

```text
packages/contracts/src/providerRuntime.ts
packages/contracts/src/providerRuntime.test.ts
packages/contracts/src/index.ts              # only if exports require it
```

### Strategy

Extend the existing canonical `task.*` model. Do not introduce a separate Pi-only `subagent.*` wire protocol.

All new fields should be optional to preserve old provider emitters and old persisted data.

### Add typed per-task usage

Target shape:

```ts
interface RuntimeTaskUsage {
  totalTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  toolUses?: number;
  durationMs?: number;
}
```

### Add minimal V1 agent linkage to task lifecycle payloads

Recommended fields:

```text
taskType
title
role
model
parentAgentId
toolUseId
typedUsage
lastToolName
```

Add them to the lifecycle rows where they are known, especially progress and terminal rows, not only `task.started`.

Reason: the client must be able to reconstruct an agent even when an older start activity falls outside retention.

### Add non-terminal status event only if required

Add:

```text
task.updated
```

for provider-neutral non-terminal state changes.

V1 runtime status vocabulary:

```text
pending
running
waiting
idle
completed
failed
stopped
```

Keep the existing terminal `task.completed` status vocabulary compatible with current code:

```text
completed | failed | stopped
```

Do not expand V1 into workflow retry/phase semantics.

### Add tool attribution where needed

Extend canonical item/tool payloads only enough to associate child-owned tools:

```ts
ItemLifecyclePayload {
  ...
  agentId?: string;
  parentToolUseId?: string;
}

ToolProgressPayload {
  ...
  taskId?: RuntimeTaskId;
  parentToolUseId?: string;
}
```

### Contract tests

Cover:

- Old task payloads still decode.
- New agent linkage fields decode.
- `typedUsage` validates non-negative counters.
- `task.updated` validates allowed statuses.
- Item/tool ownership fields are optional.

### Commit boundary

```text
feat(contracts): add provider-neutral subagent task metadata
```

---

## Phase 3 — Pi adapter normalization

### Primary files

```text
apps/server/src/provider/Layers/PiAdapter.ts
apps/server/src/provider/Layers/PiAdapter.test.ts
```

Consider extracting focused child-agent state logic into:

```text
apps/server/src/provider/Layers/PiSubagentRuntime.ts
apps/server/src/provider/Layers/PiSubagentRuntime.test.ts
```

if this keeps `PiAdapter.ts` from becoming harder to reason about.

Do not push Pi semantics into `PiRpcClient.ts`; keep that layer transport-oriented.

### Pi-local state

Maintain only provider-boundary bookkeeping, for example:

```ts
Map<NativePiChildId, PiChildState>
```

Possible internal fields:

```text
child ID
parent ID
title
role
model
status
current/last tool
latest usage
spawn turn ID
last turn ID
timestamps
terminal flag
```

### Canonical mapping

Conceptual mapping after the wire audit:

```text
native child creation
    → task.started

child becomes running/waiting/idle
    → task.updated

child narration/progress
    → task.progress

child tool starts
    → item.started { agentId }
    → optional task.progress { lastToolName }

child tool heartbeat/progress
    → tool.progress { taskId }

child tool finishes
    → item.completed { agentId }

child usage update
    → task.progress { typedUsage }

child success
    → task.completed { status: completed }

child failure
    → task.completed { status: failed }

child stopped/aborted
    → task.completed { status: stopped }
```

### Usage normalization

Normalize Pi usage in the adapter into one shared interpretation.

Prefer cumulative per-child frames if Pi exposes them. This makes duplicate/out-of-order delivery safe to fold using field-wise maxima downstream.

Do not mix parent-session token usage with child usage.

### Parent interrupt handling

`interruptTurn()` currently sends Pi `abort`.

After Pi accepts the abort:

- Mark all still-active child agents associated with the interrupted turn as `stopped`, unless Pi has already supplied terminal events.
- Ensure duplicate subsequent Pi terminal events are idempotent.

### Session/process exit handling

`closeContext()` / unexpected Pi process exit must terminalize remaining active children.

Never leave persisted agents permanently `running` because the provider process vanished.

### Tests / fixture

Add a deterministic native Pi child-agent fixture based on actual captured/verified Pi wire events.

Cover:

1. create → running → progress → completed
2. failure
3. stopped by parent interrupt
4. session/process exit
5. duplicate progress
6. duplicate terminal event
7. child tool ownership
8. usage updates
9. two children under one parent turn
10. stable identity across multiple events

### Commit boundary

```text
feat(pi): normalize native child-agent lifecycle events
```

---

## Phase 4 — Server ingestion, persistence, projection, liveness

### Primary files

```text
apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

Potential new focused files:

```text
apps/server/src/orchestration/ThreadBackgroundLiveness.ts
apps/server/src/orchestration/ThreadBackgroundLiveness.test.ts
```

### Extend the existing activity projection

Do not create a second subagent persistence store for V1.

Use existing:

```text
ProviderRuntimeEvent
    → runtimeEventToActivities()
    → thread.activity.append
    → OrchestrationThread.activities
```

### Repeat agent linkage on persisted rows

Persist enough linkage on `task.started`, `task.progress`, `task.updated`, and `task.completed` to reconstruct child state without depending on the start row still being present.

### Agent/background classification

Classify once on the server using provider-neutral semantics.

Recommended persisted marker:

```text
agentKind: "agent"
```

for rows that belong to the Agents surface.

Use whitelist/default-safe semantics:

- Known agent/subagent task type → `agent`.
- Unknown task type → background/ordinary work log.

Do not let shell tasks, monitor tasks, plans, or unknown background work become agents just because they use `task.*`.

### Tool ownership

Persist child-owned tool activity with `agentId` / `taskId` linkage.

The client can then:

- incorporate it into the child agent recent-activity model;
- suppress the duplicate row from the parent work log.

### Liveness

Track lightweight thread liveness from canonical task events:

```text
task.started   → active
task.progress  → active/update timestamp
task.updated   → status-dependent active/idle
task.completed → inactive
session.exited → clear thread liveness
```

Only connect this to thread settled/sidebar behavior where the current Void model requires it. Do not migrate orchestration architecture.

### Server tests

Cover:

- Agent task activities preserve linkage.
- Background task activities remain ordinary work-log activities.
- `task.updated` projects correctly.
- Child tool ownership is persisted.
- Terminal task reconstructs missing start metadata when possible.
- Liveness clears on terminal event and session exit.
- Existing approval / tool / task projection tests remain green.

### Commit boundary

```text
feat(server): project subagent activity and liveness
```

---

## Phase 5 — Provider-neutral client state

### New files

```text
packages/client-runtime/src/state/subagentRuntime.ts
packages/client-runtime/src/state/subagentRuntime.test.ts
```

Expose it through the existing Void client-runtime package exports.

### V1 normalized model

Target shape:

```ts
interface RuntimeSubagent {
  id: string;

  title: string;
  role: string | null;
  model: string | null;

  status:
    | "pending"
    | "running"
    | "waiting"
    | "idle"
    | "completed"
    | "failed"
    | "stopped";

  parentAgentId: string | null;

  spawnTurnId: TurnId | null;
  lastTurnId: TurnId | null;

  progress: string | null;
  lastToolName: string | null;

  usage: RuntimeTaskUsage | null;
  recentActivity: readonly SubagentActivityEntry[];

  firstSeenAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}
```

Derive `spawnTurnId` and `lastTurnId` from persisted activity `turnId`; do not create Pi-only wire fields for them unless a real requirement appears.

### Fold invariants

The fold must handle:

- duplicate events
- out-of-order events
- completion before start
- late start after completion
- partial metadata
- progress after start
- terminal idempotence
- stopped terminal state
- partial usage updates
- missing old start activity due to retention
- persisted reload

For cumulative usage, merge each counter using `max()` so duplicate frames cannot inflate totals and partial terminal frames cannot erase known fields.

### Recent activity

Keep a bounded ring, approximately 6 recent entries per agent.

Bound summaries to a reasonable UI-safe length.

### Presentation partition

```text
Active:
  pending
  running
  waiting

Idle:
  idle

Settled:
  completed
  failed
  stopped
```

### Client tests

Cover all fold invariants above plus:

- multiple agents
- parent linkage
- last-tool updates
- usage merge
- deterministic order
- background task exclusion

### Commit boundary

```text
feat(client-runtime): derive normalized subagent state
```

---

## Phase 6 — Web Agents panel + live strip

### Primary files

```text
apps/web/src/components/AgentsPanel.tsx
apps/web/src/components/chat/AgentsLiveStrip.tsx
apps/web/src/components/chat/MessagesTimeline.tsx
apps/web/src/components/chat/MessagesTimeline.logic.ts
apps/web/src/components/RightPanelTabs.tsx
apps/web/src/rightPanelStore.ts
apps/web/src/rightPanelStore.test.ts
apps/web/src/components/ChatView.tsx
```

### Right-panel integration

Add a new singleton right-panel surface:

```text
kind: "agents"
id: "agents"
```

Preserve the existing Void right-panel storage key and Void branding. Do not copy T3 storage keys.

### Shared derivation

In `ChatView`, derive once from thread activities:

```text
thread.activities
    ↓
foldSubagentActivities()
    ↓
deriveAgentPanelModel()
```

Reuse the same derived model for:

- Agents panel
- live strip
- any timeline filtering/attribution

### Agents panel V1 content

Show:

- title
- role
- model when available
- live status
- current activity/progress
- last tool
- token/tool usage
- elapsed time
- recent activity
- parent relationship when present
- completion result/error when available

Do not add V1 controls for spawn/retry/profile/workflow/parallelism.

### Live strip

Render a compact strip only when there are active/waiting agents.

Suggested information:

```text
N agents active
waiting indicator if relevant
latest active agent title + progress/tool
button/action to open Agents panel
```

### Timeline/work-log behavior

Agent-owned task/tool activity should not appear twice.

- Parent narration remains in the parent timeline.
- Child-owned tool/task rows feed the child model.
- Background tasks continue to render in the normal work log exactly as before.

No Pi-specific logic in components.

### Web tests

Cover:

- Agents surface migration/store.
- Panel renders active and settled agents.
- Waiting/failed/stopped status styling/labels.
- Live strip visibility.
- No duplicate parent work-log row for child-owned tools.
- Background task remains visible.

### Commit boundary

```text
feat(web): add native agents panel and live strip
```

---

## Phase 7 — Mobile visibility

### Primary files

```text
apps/mobile/src/lib/threadActivity.ts
apps/mobile/src/lib/threadActivity.test.ts
apps/mobile/src/features/threads/thread-work-log.tsx
apps/mobile/src/features/threads/ThreadFeed.tsx
```

Reuse the shared client-runtime fold. Do not implement a second mobile-only subagent state machine.

### Minimum V1 UI

Provide a compact presentation such as:

```text
2 agents active
```

with compact agent rows showing:

- title
- status
- latest progress or last tool

Keep settled history visible enough to understand completed/failed child work after reopening a thread.

Suppress child-owned work-log duplicates the same way Web does.

### Mobile tests

Cover:

- active count
- waiting / failed / stopped presentation
- progress label
- background task still shown normally
- child-owned work-log row suppressed

### Commit boundary

```text
feat(mobile): surface native subagent activity
```

---

## Phase 8 — End-to-end validation

Build one deterministic Pi lifecycle scenario:

```text
parent turn starts
    ↓
child created
    ↓
child running
    ↓
child tool starts
    ↓
child progress + usage
    ↓
child tool completes
    ↓
child completes
    ↓
parent settles
```

Then validate variants:

- child failure
- child stopped by parent interrupt
- Pi process exit
- session replacement/close
- duplicate events
- completion before start
- two parallel/native children if Pi itself emits them in V1
- persisted reload

Verify the complete chain:

```text
Pi raw event
   → ProviderRuntimeEvent
   → persisted OrchestrationThreadActivity
   → RuntimeSubagent fold
   → Web Agents panel/live strip
   → Mobile visibility
```

## Regression matrix

Existing provider behavior must remain intact:

- Claude
- Codex
- Cursor
- Grok
- OpenCode

Explicit checks:

- Old activities/contracts still decode.
- Existing provider tests pass unchanged unless an additive expected field requires adjustment.
- Unknown/background tasks remain ordinary work-log entries.
- Agent-owned tools do not appear twice.
- Interrupt/session exit cannot leave phantom running agents.
- No Pi-specific code appears in shared UI/client-runtime derivation.
- Void package scopes and branding are preserved.

## Validation cadence

After every layer, run focused tests and typechecks for the touched package(s).

Before completion, run the repository-prescribed relevant full checks. At minimum inspect package scripts and execute the current equivalents of:

```text
contracts tests + typecheck
client-runtime tests + typecheck
server tests + typecheck
web tests + typecheck/build
mobile tests + typecheck
```

If root scripts provide aggregate checks, use those instead of inventing commands.

Do not claim success with a failing validation step.

---

# Proposed commit sequence

Keep commits small and layer-oriented:

```text
1. feat(contracts): add provider-neutral subagent task metadata
2. feat(pi): normalize native child-agent lifecycle events
3. feat(server): project subagent activity and liveness
4. feat(client-runtime): derive normalized subagent state
5. feat(web): add native agents panel and live strip
6. feat(mobile): surface native subagent activity
7. test(pi-subagents): add end-to-end lifecycle regression coverage
```

If the Pi event audit requires adding only fixtures/notes before contracts, make that a separate first commit.

---

# Definition of Done

The V1 branch is complete only when all of the following are true:

1. Pi native child creation produces a stable provider-neutral agent identity.
2. A child can transition through active states and reach completed/failed/stopped terminal state.
3. Child progress and last tool update live.
4. Child usage is normalized without double counting.
5. Parent/child linkage is preserved when Pi exposes it.
6. Spawn and last-turn IDs are reconstructable.
7. Agent state survives server/client reload through persisted thread activities.
8. Child-owned tool activity is attributed to the child and not duplicated in the parent work log.
9. Web has an Agents panel and live status strip without Pi-specific logic.
10. Mobile exposes basic active/settled agent visibility.
11. Parent interruption and Pi process/session exit cannot leave phantom running children.
12. Claude, Codex, Cursor, Grok, and OpenCode regression suites remain green.
13. No upstream orchestration-v2 branch was wholesale merged.
14. No machine-specific Pi path was introduced.
15. Void branding/package identity remains intact.

---

# First task for the next agent

Do this before editing feature code:

> Analyze the current Pi provider lifecycle and identify the exact native event/transport points where child-agent creation, progress, state changes, tool ownership, completion, failure, interruption, and usage can be normalized into the shared `task.*` contract. Inspect `PiRpcClient.ts`, `PiAdapter.ts`, Pi adapter tests, current contracts, and the configured Pi runtime source if available. Report the actual event shapes and a proposed Pi-raw → canonical-event mapping. Do not invent Pi event names and do not modify `/home/mewtwo/ZSSD/pi-void`.

Once that audit is complete, proceed phase-by-phase with tests alongside each layer.
