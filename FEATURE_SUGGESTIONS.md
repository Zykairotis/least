# Least - Feature Suggestions

Grounded in the actual tool surface (`ToolRegistry` / agent ops / dashboard) as of 2026-07-05.
Each item lists concrete file touch points and a verification step, not vague ideas.
Items marked `[in-flight]` overlap with current uncommitted work and should be folded into
that work rather than started separately.

## Layer 1 - MCP tool surface (smallest blast radius, highest signal)

`ToolRegistry` in [src/toolRegistry.ts](src/toolRegistry.ts) is the registration point; the
`LEAST_TOOLSET` profiles (`explore`/`edit`/`review`/`handoff`/`full`) in [src/toolRegistry.ts](src/toolRegistry.ts)
control which tools ChatGPT sees.

1. `git_blame_inline` - read-only. Layer git blame onto `read_around` output so the model
   sees "who last touched this line and when" without a second call. Touch: [src/gitOps.ts](src/gitOps.ts),
   [src/filesOps.ts](src/filesOps.ts). Verify: `node scripts/smoke.mjs`, then a new
   `scripts/git-blame-inline-unit.mjs` against a fixture repo.

2. `symbol_usages` - read-only. Given a symbol from `project_map`, return its call sites
   via ripgrep word-boundary matches plus file:line. Fills the gap between `project_map`
   (definition map) and `search` (free text). Touch: [src/projectMapOps.ts](src/projectMapOps.ts),
   new `src/symbolUsagesOps.ts`. Verify: `node scripts/process-runner-unit.mjs`.

3. `diff_apply_preview` - read-only dry run of `apply_patch` that returns the post-patch
   file content and a conflict check without writing. Lets the model self-verify a patch
   shape before committing. Touch: [src/patchOps.ts](src/patchOps.ts). Verify: extend
   `scripts/output-shaper-unit.mjs` with a no-write case.

4. `cache_warmth` - read-only. One-shot tool that reports which `workspaceCache` keys are
   hot vs cold, so the model can decide whether to `warmup` before a batched read. Touch:
   [src/workspaceCache.ts](src/workspaceCache.ts), [src/perf.ts](src/perf.ts). Verify:
   `node scripts/gain-unit.mjs`.

## Layer 2 - Agent orchestration (extends existing agent_ops family)

The agent lifecycle in [src/agentTypes.ts](src/agentTypes.ts) already has `planned`,
`running`, `resumed`, `interrupted`, `cancelled`. There is no multi-agent or dependency
linking yet.

5. `agent_graph` `[in-flight risk]` - declare a DAG of agent jobs that run after their
   deps finish. Reuses `AgentJobRecord` and adds an optional `dependsOn: string[]` (taskIds).
   The coordinator in [src/agentLaunchCoordinator.ts](src/agentLaunchCoordinator.ts) already
   accepts jobs; this adds a `waiting` pre-phase. Check the current `agentDirectLaunch.ts`
   work first - it may already hand-roll something close. Touch:
   [src/agentLaunchCoordinator.ts](src/agentLaunchCoordinator.ts),
   [src/agentTypes.ts](src/agentTypes.ts), new `src/agentDag.ts`.

6. `agent_diff_replay` - when an agent finishes, snapshot the worktree diff against base
   and store it next to `agentJobStore`. `agent_result` already returns logs; this adds the
   exact patch the agent produced. Touch: [src/agentResult.ts](src/agentResult.ts),
   [src/gitOps.ts](src/gitOps.ts).

7. `agent_cost_ledger` - record per-job wall-clock, token-quota-equivalent (input/output
   bytes via `outputShaper`), and exit state into a small sqlite file. Surfaces through a
   new `agent_costs` read-only tool. Reuses [src/node-sqlite.d.ts](src/node-sqlite.d.ts) and
   the sqlite that dashboard-store already uses. Touch: new `src/agentCostLedger.ts`.

## Layer 3 - Dashboard (web/dashboard)

8. `agent_kanban` view - columns per `AgentLifecycleState`, cards per job, live via the
   existing `dashboardEvents` stream. No new backend; pure client component over
   `dashboardSnapshot`. Touch: `web/dashboard/src/App.tsx` and a new
   `web/dashboard/src/AgentKanban.tsx`. Verify: `npm run dashboard:build-smoke`.

9. `cost_panel` - read the agent cost ledger (item 7) and render a small chart. If 7 is not
   built, skip this - YAGNI without it.

## Layer 4 - Safety / review

10. `secret_scan_inline` - run a lightweight secret regex sweep when `read` returns a
    file inside `.env`-adjacent paths, and refuse `write` of content matching high-confidence
    secret patterns. Already has redaction infra in [src/redact.ts](src/redact.ts); add a
    writer-side gate. Touch: [src/redact.ts](src/redact.ts), [src/permissions.ts](src/permissions.ts).
    Verify: extend `scripts/permissions-unit.mjs`.

11. `review_minimality` already exists; extend it to flag new files > N lines with < M
    references elsewhere (likely dead-on-arrival code). Touch only:
    [src/minimalityOps.ts](src/minimalityOps.ts). Smallest diff in the whole list.

## Recommended order

Start with 11 (smallest), then 1 or 3 (read-only, low risk, high model value), then 5 if
the in-flight direct-launch work does not already cover it. Defer 8/10 until the agent
work lands so the dashboard and safety gates match the real job shape.

## Explicitly NOT doing

- New tunnel backends - cloudflare / tailscale / ngrok coverage is enough.
- New MCP SDK wrappers - `@modelcontextprotocol/sdk` upgrade churn has no user value now.
- Custom auth schemes - `httpAuth` + `dashboardAuth` are fine; do not add a second path.

spoiler: skipped model/LLM proxying (out of scope for an MCP bridge by design), add when
the user explicitly asks for a hosted mode.
