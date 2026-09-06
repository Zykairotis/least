# Least workflow tool and local MCP allowlist plan

Date: 2026-07-05
Status: draft plan
Scope: add a small workflow platform to Least that exposes a narrow MCP surface, routes through allowlisted local tools/MCP capabilities, supports helper CLIs and shared skills, and pilots the model with a `video-study` workflow.

---

## 1. Goal

Add a workflow layer to `X:\least` so Least can expose a tiny, stable tool surface to chat clients while still orchestrating richer local PC capabilities under the hood.

The target outcome is:

```text
chat client
  -> Least MCP workflow tool
  -> named workflow runner
  -> allowlisted local capability adapters
  -> helper scripts / CLIs / existing Least tools / selected local MCP servers
  -> persisted workflow state + verification output
```

The first real workflow should be `video-study`, because it is already proven in Hermes and has a clear set of cooperating capabilities:

- Video RAG retrieval
- Obsidian note writing
- Anki card creation
- image-optimizer image cropping/optimization
- optional Todoist task creation

The long-term design should support additional workflows without turning Least into a noisy pile of raw tools.

---

## 2. Decision summary

### 2.1 Visible surface

Expose one primary workflow tool first:

```text
workflow
```

Use an `action` field instead of creating a large family of top-level tools.

Recommended actions:

- `plan`
- `run`
- `resume`
- `status`
- `cancel` (optional in phase 2)

Example shape:

```jsonc
{
  "workflow_id": "video-study",
  "action": "run",
  "input": {
    "source": "D:\\Trading\\Order Flow & Footprint\\DeepCharts Course (Fabio & Andrea)- 2025",
    "project": "default",
    "lesson": "Fabio1",
    "mode": "time-window",
    "window_scope": "0-30",
    "outputs": ["obsidian", "anki", "images"]
  },
  "dry_run": true,
  "max_steps": 3,
  "confirm": false,
  "run_id": "optional-existing-run-id"
}
```

### 2.2 Internal execution model

Do not expose every local MCP server directly to the client.

Instead, the workflow runner should call only:

1. internal Least capabilities;
2. named helper scripts/CLIs shipped with Least;
3. selected allowlisted local MCP servers/tools declared in config.

### 2.3 Why this is better than a raw MCP hub

This design preserves:

- small visible surface;
- deterministic execution paths;
- better testing;
- explicit operator control;
- easier skill reuse;
- safer defaults.

It avoids:

- noisy tool lists;
- arbitrary shell command routing;
- overexposure of local machine capabilities;
- fragile prompt-driven orchestration over dozens of raw endpoints.

---

## 3. Architectural shape

### 3.1 Layers

Use four layers.

#### Layer A: shared skill/instruction layer

Purpose:

- explain the workflow contract to the model;
- define mode, stop conditions, and guardrails;
- make the workflow naturally reusable where Least skills are shared.

This should look similar in spirit to the Hermes `video-study-workflow` skill, but should be tailored to Least's workflow tool contract.

#### Layer B: workflow MCP surface

Purpose:

- give the client one stable high-level tool;
- validate input;
- enforce dry-run/confirm/max-steps rules;
- persist run state;
- return concise structured results and verification tables.

#### Layer C: workflow registry and runner

Purpose:

- register named workflows;
- map workflow ids to plans and step executors;
- support resume/status/cancel;
- coordinate state transitions;
- keep bulk work bounded.

#### Layer D: capability adapters

Purpose:

- wrap existing capabilities behind stable contracts;
- isolate local MCP/tool differences from the workflow layer;
- make test doubles easy.

Adapters may call:

- existing Least tools/functions;
- local helper CLIs/scripts;
- allowlisted local MCP servers/tools.

---

## 4. First-class concepts

### 4.1 Workflows

A workflow is a named orchestrator with:

- id
- description
- input schema
- supported actions
- plan generator
- executor
- verification contract
- required capabilities
- confirmation policy

Examples later:

- `video-study`
- `repo-review`
- `agent-implementation`
- `research-scan`
- `obsidian-capture`

### 4.2 Runs

A run is a persisted instance of one workflow execution.

Suggested state machine:

```text
planned -> awaiting_confirmation -> running -> paused -> completed
planned -> failed
running -> failed
running -> cancelled
paused -> running
```

### 4.3 Capabilities

A capability is an internal adapter contract, not necessarily a public tool.

Examples:

- `video_rag.check_db`
- `video_rag.search_window`
- `video_rag.get_chunk`
- `obsidian.write_note`
- `anki.find_existing`
- `anki.add_cards`
- `images.optimize_selected`
- `todoist.create_task`

### 4.4 Allowlisted local MCP endpoints

This is the control valve.

Least should not dynamically proxy all local MCP tools.

Instead, define entries such as:

```jsonc
{
  "workflows": {
    "localMcpAllowlist": {
      "video-rag": {
        "enabled": true,
        "tools": ["trading_list_projects", "trading_list_videos", "trading_search", "trading_get_chunk", "trading_find_visual", "trading_stats"]
      },
      "anki": {
        "enabled": true,
        "tools": ["listDecks", "findNotes", "notesInfo", "addNotes", "storeMediaFile", "deckStats"]
      },
      "image-optimizer": {
        "enabled": true,
        "tools": ["get_image_info", "auto_crop", "smart_crop", "optimize_image"]
      },
      "todoist": {
        "enabled": false,
        "tools": ["create_task"]
      }
    }
  }
}
```

---

## 5. Implementation phases

### Phase 1: framework only

Deliver:

- workflow schemas
- workflow registry
- persisted run state
- `workflow` MCP tool
- dry-run planning
- status/resume plumbing
- no external MCP proxy yet, or a fake adapter for tests

Goal:

prove the shape before wiring real local tool calls.

### Phase 2: local capability adapter layer

Deliver:

- local helper CLI contracts
- allowlist config loader
- adapter execution helpers
- read-only capability wiring first

Goal:

make the framework capable of safely invoking selected local functionality.

### Phase 3: `video-study` pilot

Deliver:

- video-study workflow implementation
- shared Least skill for video-study
- helper scripts/CLIs
- verification output
- targeted smoke tests

Goal:

replicate the Hermes workflow behavior through Least with a smaller, safer surface.

### Phase 4: expansion

Deliver:

- optional Todoist integration
- more workflow types
- better dashboard/status views
- cancel support
- richer resume behavior

---

## 6. Proposed file additions and changes

### 6.1 Core workflow runtime

Create:

- `src/workflowTypes.ts`
- `src/workflowRegistry.ts`
- `src/workflowRunner.ts`
- `src/workflowState.ts`
- `src/workflowResult.ts`
- `src/workflowAllowlist.ts`
- `src/workflowAdapters.ts`

Modify:

- `src/server.ts`
- `src/toolRegistry.ts` only if a helper is useful; keep changes minimal
- `src/config.ts`
- `src/settingsSchema.ts`
- `docs/settings.md`
- `README.md` if the workflow surface is meant to be public-facing soon

### 6.2 Video-study workflow files

Create:

- `src/workflows/videoStudy/index.ts`
- `src/workflows/videoStudy/plan.ts`
- `src/workflows/videoStudy/run.ts`
- `src/workflows/videoStudy/state.ts`
- `src/workflows/videoStudy/prompts.ts`
- `src/workflows/videoStudy/types.ts`

### 6.3 Helper CLIs / scripts

Create helper scripts that are workflow-sized, not one-script-per-tiny-action.

Recommended:

- `scripts/least-workflow-video-study.mjs`
- `scripts/least-workflow-video-study-smoke.mjs`
- `scripts/least-local-mcp-smoke.mjs`
- `scripts/least-workflow-state-unit.mjs`

Optional subcommand contract for `least-workflow-video-study.mjs`:

```text
plan
check-db
process-window
process-lesson
resume
status
verify
```

Why still add scripts if the main logic is in `src/`?

- easy operator testing outside MCP;
- stable debugging entry point;
- future wrapper target for other agents/tools;
- deterministic smoke coverage.

### 6.4 Skills

Create:

- `skills/video-study/SKILL.md`
- `skills/video-study/references/workflow-contract.md`
- `skills/video-study/references/db-check-trust.md`
- `skills/video-study/references/anki-rules.md`
- `skills/video-study/references/image-selection.md`
- `skills/video-study/templates/run-one-lesson.md`
- `skills/video-study/templates/run-folder-study-batch.md`
- `skills/video-study/templates/deepen-existing-lesson.md`

Optional future shared workflow skill:

- `skills/workflow-orchestrator/SKILL.md`

This should teach the model how to use `workflow plan/run/status` generically and then hand off to the specific workflow references.

### 6.5 Documentation / examples

Create:

- `docs/workflows.md`
- `docs/local-mcp-allowlist.md`
- `docs/video-study-workflow.md`
- `docs/examples/workflows.local.example.jsonc`

---

## 7. Settings and configuration design

### 7.1 Add new settings block

Extend `src/settingsSchema.ts` and docs with something like:

```jsonc
{
  "workflows": {
    "enabled": true,
    "allowed": ["video-study"],
    "defaultDryRun": true,
    "maxStepsDefault": 3,
    "maxStepsHardLimit": 20,
    "requireConfirmationForBulk": true,
    "stateDir": ".ai-bridge/workflows",
    "localMcpAllowlist": {
      "video-rag": {
        "enabled": true,
        "tools": ["trading_list_projects", "trading_search", "trading_get_chunk", "trading_find_visual"]
      },
      "anki": {
        "enabled": true,
        "tools": ["listDecks", "findNotes", "notesInfo", "addNotes", "deckStats", "storeMediaFile"]
      },
      "image-optimizer": {
        "enabled": true,
        "tools": ["get_image_info", "auto_crop", "smart_crop", "optimize_image"]
      },
      "todoist": {
        "enabled": false,
        "tools": ["create_task"]
      }
    }
  }
}
```

### 7.2 Keep `.least/settings.local.json` as the operator override

This is where the user can turn workflows or specific allowlisted servers on/off without editing code.

### 7.3 Relationship to existing `toolMode` and `toolset`

Recommendation:

- keep the new `workflow` tool visible in `standard` and `full` tool modes;
- optionally include it in a future workflow-focused toolset;
- do not expose internal workflow sub-capabilities as top-level tools.

---

## 8. Local MCP access strategy

### 8.1 Non-goal

Do not build a broad MCP discovery/proxy hub in phase 1.

That would create:

- too many visible tools;
- inconsistent auth/runtime behavior;
- weak permission boundaries;
- poor operator comprehension.

### 8.2 Recommended execution model

For a workflow step that needs a local MCP tool:

1. verify the server is configured in the allowlist;
2. verify the requested tool name is allowlisted for that server;
3. execute via a local adapter helper;
4. normalize output into text + structured result;
5. log the call in workflow events;
6. persist a compact verification record.

### 8.3 Adapter boundary

The workflow layer should not care whether a capability came from:

- local MCP server;
- helper CLI;
- direct TypeScript function;
- AnkiConnect HTTP;
- filesystem operation.

The adapter interface should flatten those differences.

Suggested shape:

```ts
interface WorkflowCapabilityAdapter {
  id: string;
  checkHealth(): Promise<{ ok: boolean; detail: Record<string, unknown> }>;
  invoke(action: string, input: Record<string, unknown>): Promise<{
    ok: boolean;
    text: string;
    structured?: Record<string, unknown>;
  }>;
}
```

---

## 9. Video-study pilot design

### 9.1 Contract

The pilot should support:

- DB check first
- scoped query to one project/course/module/lesson
- one-video or whole-folder study mode
- 10-minute windows for long videos
- Obsidian note writing
- Anki duplicate checks and card creation
- selected image extraction/optimization
- resume/progress persistence
- final verification table

### 9.2 Required capability adapters

Implement adapters or wrappers for:

- `video_rag.check_db`
- `video_rag.search_window`
- `video_rag.get_chunk`
- `video_rag.find_visual`
- `obsidian.write_note`
- `obsidian.append_progress`
- `anki.find_existing_cards`
- `anki.add_cards`
- `anki.deck_stats`
- `images.optimize_selected`

Optional later:

- `todoist.create_task`

### 9.3 State model

Persist run state like:

```jsonc
{
  "run_id": "video-study-20260705-001",
  "workflow_id": "video-study",
  "status": "paused",
  "scope": {
    "source": "D:\\Trading\\Order Flow & Footprint\\DeepCharts Course (Fabio & Andrea)- 2025",
    "project": "default",
    "module": "DeepCharts Course (Fabio & Andrea)- 2025",
    "lesson": "Fabio1"
  },
  "progress": {
    "completed_windows": ["00:00-10:00", "10:00-20:00"],
    "next_window": "20:00-30:00",
    "cards_created": 12,
    "images_created": 1,
    "duplicates_skipped": 3
  },
  "verification": {
    "note_path": "D:\\Obsidian Vault\\_V-A-U-L-T_\\...",
    "deck": "Trading::DeepCharts Course"
  }
}
```

### 9.4 Output contract

Every `run`/`resume` result should include:

- workflow id
- run id
- status
- step count performed
- verification table
- changed artifacts
- next window / next lesson
- blockers or confirmation-needed reasons

---

## 10. Skill design

### 10.1 Why skills still matter

The workflow tool gives stable execution. The skill tells the model:

- when to use it;
- how to choose mode;
- what input shape to normalize user requests into;
- which guardrails matter.

### 10.2 Video-study skill package

The skill should include:

#### `skills/video-study/SKILL.md`

Primary behavior contract:

- check DB first;
- do not ingest unless asked;
- process long videos in windows;
- use selected frames;
- duplicate-check Anki;
- verify note/card/image outputs;
- pause on bulk boundaries.

#### `references/workflow-contract.md`

Document the `workflow` tool input/output shape.

#### `references/db-check-trust.md`

Document:

- exact source path trust
- module/lesson trust
- filename collision distrust
- Qdrant-backed queryability

#### `references/anki-rules.md`

Document:

- duplicate checks
- deck naming
- tags
- visual card rules
- batch limits

#### `references/image-selection.md`

Document:

- good vs bad frames
- max images per window
- crop/optimize rules
- naming scheme

#### templates

Add ready-made prompts/contracts:

- `run-one-lesson.md`
- `run-folder-study-batch.md`
- `deepen-existing-lesson.md`

These templates will help both models and operators keep requests consistent.

---

## 11. Helper script plan

The user specifically wants “a lot of scripts and stuff for skill,” so the plan should intentionally create a script layer that stays useful rather than decorative.

### 11.1 Scripts to add now

#### `scripts/least-workflow-video-study.mjs`

Purpose:

- operator/debug CLI for the pilot workflow.

Subcommands:

- `plan`
- `check-db`
- `process-window`
- `process-lesson`
- `status`
- `verify`

#### `scripts/least-local-mcp-smoke.mjs`

Purpose:

- verify allowlisted local MCP endpoints are reachable and expose expected tools.

#### `scripts/least-workflow-state-unit.mjs`

Purpose:

- test run-state read/write/resume semantics.

#### `scripts/least-workflow-video-study-smoke.mjs`

Purpose:

- smoke the pilot end-to-end in dry-run mode.

### 11.2 Scripts to consider later

- `scripts/least-workflow-repo-review.mjs`
- `scripts/least-workflow-agent-task.mjs`
- `scripts/least-workflow-obsidian-capture.mjs`

### 11.3 Script design rules

Every helper script should:

1. accept structured args only;
2. support `--json` where useful;
3. support `--dry-run`;
4. preserve exit codes;
5. avoid shell quoting tricks;
6. emit machine-readable errors;
7. never bypass Least safety policy.

---

## 12. MCP/tool registration plan

### 12.1 Register one new public tool first

Add to `src/server.ts`:

- `workflow`

Suggested schema:

```jsonc
{
  "action": "plan | run | resume | status | cancel",
  "workflow_id": "string",
  "run_id": "string?",
  "input": "object?",
  "dry_run": "boolean?",
  "max_steps": "number?",
  "confirm": "boolean?",
  "confirm_token": "string?"
}
```

### 12.2 Optionally add read-only companions later

If one tool feels too opaque, phase 2 can split out:

- `workflow_list`
- `workflow_status`

But do not start there unless needed.

---

## 13. Safety and guardrails

### 13.1 Public workflow guardrails

Required:

- `dry_run` support for `plan` and optionally `run`
- `max_steps`
- `confirm` / `confirm_token` for bulk actions
- workflow id must be allowlisted
- local MCP tool calls must be allowlisted
- no arbitrary command execution

### 13.2 Bulk policy

Examples of operations that should require confirmation:

- processing an entire course deeply
- creating more than 50 cards in one run chunk
- creating Todoist tasks in bulk
- ingesting a folder not yet indexed

### 13.3 Resume policy

Resume should continue from persisted state, not re-run completed windows unless explicitly requested.

### 13.4 Auditability

Persist event logs for each run:

- plan generated
- capability invoked
- side effect performed
- verification result
- pause/confirm boundary hit

---

## 14. Testing plan

### 14.1 Unit tests

Add targeted Node/unit scripts for:

- workflow registry lookup
- workflow state transitions
- dry-run enforcement
- max-steps enforcement
- confirmation gating
- allowlist enforcement
- resume semantics

### 14.2 Tool registration tests

Update or add smokes to ensure:

- `workflow` is visible in expected tool modes/toolsets
- hidden internal capability adapters are not public tools

### 14.3 Pilot workflow smoke

Dry-run smoke should verify:

- DeepCharts folder recognized as indexed
- plan contains expected windows
- no side effects when dry-run is on
- status file and result file are created correctly

### 14.4 Optional live smoke on this machine

When explicit local approval exists, verify:

- Anki reachable
- image-optimizer reachable
- Video RAG reachable
- note file path can be resolved safely

Do not require Todoist live verification for phase 1.

---

## 15. Rollout order

### Step A

Land workflow framework with one no-op/sample workflow and tests.

### Step B

Land allowlist config and capability adapter interface.

### Step C

Land `video-study` workflow and helper scripts in dry-run mode.

### Step D

Enable live adapters for Video RAG, Anki, image-optimizer, and Obsidian.

### Step E

Add shared skill package and docs.

### Step F

Add optional Todoist path behind explicit opt-in.

---

## 16. Recommended final shape after phase 1

Visible client surface:

```text
workflow
```

Shared skills:

```text
skills/video-study/...
```

Helper/operator scripts:

```text
scripts/least-workflow-video-study.mjs
scripts/least-local-mcp-smoke.mjs
scripts/least-workflow-video-study-smoke.mjs
scripts/least-workflow-state-unit.mjs
```

Internal runtime:

```text
src/workflow*.ts
src/workflows/videoStudy/*
```

State:

```text
.ai-bridge/workflows/<run_id>/
```

---

## 17. Recommendation

Build this as a workflow platform with a `video-study` pilot, not as a general-purpose local MCP proxy.

Use one public workflow tool, helper CLIs for repeatable operations, and rich shared skills for natural orchestration.

That gives the user:

- a small clean tool surface;
- future extensibility;
- strong control;
- reusable skill contracts;
- safer growth when more tools are added later.

