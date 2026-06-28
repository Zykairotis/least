# Research-Driven Efficiency Plan for Least

Date: 2026-06-26

Scope: convert the useful material in `.ai-bridge/research` into concrete Least improvements for model-visible output size, task latency, context quality, project memory, workflow routing, and implementation simplicity.

Non-goal: do not copy Headroom, RTK, or Ponytail wholesale. Least should remain a focused local development bridge. Extract only the patterns that fit Least's current architecture.

---

## 1. Executive summary

Least already has the right foundation for efficient local coding workflows: `files`, `search_context`, `read_many`, `batch`, `context_pack`, `project_map`, `show_changes`, `least_perf`, workspace caching, git caching, shell modes, and toolset presets.

The next efficiency gains should come from making existing tool results more compact, more relevant, more recoverable, and more measurable.

The research folder points to five high-value changes:

1. Add deterministic output shaping for noisy tool results.
2. Add raw-output retrieval by hash so compact output remains reversible.
3. Upgrade `context_pack` into the primary task-planning and context-selection tool.
4. Add local `gain` / `discover` analytics on top of `least_perf`.
5. Add narrow project-scoped memory for durable repo facts and repeated workflow corrections.

Recommended implementation order:

1. Fix existing measurement and output-accounting issues.
2. Add compactors for search, git diff, show changes, bash/test logs, and JSON-like output.
3. Add `retrieve_output` for raw output recovery.
4. Upgrade `context_pack` ranking and output shape.
5. Add local analytics and project memory.
6. Add minimality-review and adapter-portability work last.

---

## 2. Research synthesis

### 2.1 Headroom: useful ideas

Adopt these ideas:

- type-aware compression for tool outputs, logs, JSON, code, search results, and text;
- reversible compression through a local retrieval mechanism;
- strict passthrough and determinism invariants;
- output-token reduction by avoiding repeated context, repeated code, and verbose low-value output;
- local persistent metrics for token savings, cost estimates, cache behavior, and latency;
- project-scoped memory with provenance and deduplication.

Do not adopt:

- a provider proxy;
- Anthropic/OpenAI request mutation;
- auth-mode policy gates;
- provider cache-control logic;
- SSE parser work;
- ML compression as a first version.

Reason: Least controls the tool boundary directly. It can compact tool results without becoming a model-provider proxy.

### 2.2 RTK: useful ideas

Adopt these ideas:

- command-specific compactors for `git`, `grep`, `test`, `lint`, and other noisy outputs;
- preserve error semantics and exit status;
- track local savings;
- expose `gain` and `discover` reporting to show value and missed opportunities;
- regression tests that verify context preservation, no NUL/control-character leaks, and safe fallback.

Do not adopt:

- shell hooks as the primary mechanism;
- command rewriting outside Least;
- external telemetry by default.

Reason: Least already owns command execution and tool output formatting. It should implement the compactors natively.

### 2.3 Ponytail: useful ideas

Adopt these ideas:

- minimality ladder: reuse existing code, standard library, platform features, installed dependencies, then implement only the minimum required;
- over-engineering review as a specific workflow;
- agent-portable instructions with one canonical source and thin adapters;
- measured impact rather than generic terseness.

Do not adopt:

- a persona-heavy always-on behavior as a core server feature;
- brevity controls that do not connect to concrete tool output or code quality.

Reason: Least should provide objective review tools and better agent guidance, not a style persona.

---

## 3. Current Least baseline

### 3.1 Strengths already present

- `context_pack` for one-call context assembly.
- `project_map` for source structure extraction.
- `search_context` for search with surrounding lines.
- `read_many` for batched file reads.
- `batch` for concurrent read-only Least calls.
- `least_perf` for runtime performance summaries.
- `files` and `search` with ripgrep support.
- `gitStatus`, `gitDiff`, and `gitLog` helpers.
- `bash` with safe, readonly, and full modes.
- `read_handoff` and `handoff_to_agent` for agent coordination.
- Toolset presets for smaller tool surfaces.
- Blocked glob handling and secret redaction.

### 3.2 Friction points to fix

1. Model-visible output can still be too large. Byte caps exist, but caps are blunt and may drop structure while preserving irrelevant bulk.
2. `context_pack` ranking is useful but still basic. It should combine search hits, symbols, imports, git state, tests, package context, and project memory.
3. `runRipgrepFiles` should stream and stop early after enough files are found instead of accumulating full stdout first.
4. Range reads should distinguish full source file bytes from returned bytes. `read_many` budgeting should use returned bytes when only a line range is emitted.
5. `least_perf` should count `cacheHit` as well as `cache_hit`, otherwise some cache-hit telemetry is likely undercounted.
6. `show_changes` should describe untracked files better. A summary with many untracked files but no useful diff stats is not enough for review workflows.
7. Shell output and test output need domain-specific compaction rather than simple truncation.
8. Project map extraction is regex-based and should eventually be incremental and cache-aware per file.
9. Persistent local knowledge is absent. Agents rediscover the same scripts, architecture, generated paths, and workflow corrections every session.

---

## 4. Design principles

### 4.1 Compact tool output, not model requests

Preferred architecture:

```text
Least tool runs
  -> collect raw output
  -> redact secrets
  -> classify output type
  -> compact deterministically when useful
  -> store raw output by hash if compacted/truncated
  -> return compact model-visible output plus retrieval key
```

Avoid:

```text
LLM request proxy
  -> mutate provider request body
  -> inject provider-specific tools
  -> manage provider cache controls
```

### 4.2 Compactness must be reversible

Any output that is compacted or truncated should provide a retrieval path.

Suggested return metadata:

```ts
interface ShapedOutputMeta {
  mode: "raw" | "compact" | "truncated";
  rawBytes: number;
  visibleBytes: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  savedBytes: number;
  savedTokensEstimate: number;
  retrievalKey?: string;
  retrievalHint?: string;
}
```

### 4.3 Determinism first, ML later if ever

Do not add ML compression in the first implementation. Deterministic compaction can already provide large gains:

- group similar output;
- preserve errors;
- preserve filenames and line numbers;
- collapse repeated lines;
- summarize large arrays;
- keep first/last snippets;
- keep high-signal hunks.

### 4.4 Preserve safety and semantics

A compactor must never hide:

- process exit code;
- thrown errors;
- test failures;
- compiler diagnostics;
- lint diagnostics;
- file paths needed to act;
- line numbers needed to edit;
- security warnings;
- redaction markers;
- write or delete operations;
- command timeout and truncation status.

### 4.5 Measure model-visible bytes, not just wall time

Least performance has two dimensions:

1. tool runtime;
2. model-visible output volume.

A tool that runs in 50 ms but emits 40,000 tokens is still inefficient. `least_perf` should track both.

---

## 5. Target architecture

### 5.1 New modules

Add these modules incrementally:

```text
src/outputShaper.ts
src/toolOutputStore.ts
src/outputCompactors/searchCompactor.ts
src/outputCompactors/gitDiffCompactor.ts
src/outputCompactors/showChangesCompactor.ts
src/outputCompactors/testLogCompactor.ts
src/outputCompactors/jsonCompactor.ts
src/outputCompactors/textCompactor.ts
src/contextRanker.ts
src/projectMemory.ts
src/gainOps.ts
src/minimalityOps.ts
```

The first two are mandatory for Phase 1. The rest can be added as phases land.

### 5.2 Output shaping pipeline

```text
raw operation output
  -> redactSensitiveText
  -> classifyOutput
  -> choose compactor
  -> compact
  -> verify smaller or fallback to raw
  -> store raw when compacted/truncated
  -> record perf/gain metrics
  -> return shaped output
```

### 5.3 Compactor interface

```ts
export type OutputKind =
  | "search"
  | "git_diff"
  | "git_status"
  | "show_changes"
  | "test_log"
  | "lint_log"
  | "tsc_log"
  | "json"
  | "code"
  | "text";

export interface OutputShapeOptions {
  mode?: "raw" | "compact" | "compressed";
  maxVisibleBytes: number;
  preserveLines?: boolean;
  retrievalEnabled?: boolean;
}

export interface OutputCompactorInput {
  kind: OutputKind;
  text: string;
  rawBytes: number;
  toolName: string;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface OutputCompactorResult {
  content: string;
  summary?: string;
  mode: "raw" | "compact" | "truncated";
  rawBytes: number;
  visibleBytes: number;
  savedBytes: number;
  reason: string;
  warnings: string[];
}
```

### 5.4 Tool-output store

Store raw output only when needed:

```text
.least/cache/tool-output/<workspace-id>/<sha256>.txt
```

Metadata sidecar:

```json
{
  "key": "sha256:...",
  "toolName": "bash",
  "kind": "test_log",
  "createdAt": "2026-06-26T00:00:00.000Z",
  "rawBytes": 123456,
  "visibleBytes": 12000,
  "ttlMs": 86400000
}
```

Do not store output containing obvious secrets. If redaction changed the raw output, store only the redacted raw output.

### 5.5 Retrieval tool

Add a read-only tool:

```ts
retrieve_output({ key, start_line?, end_line?, max_bytes? })
```

Rules:

- only keys generated in the same workspace are accessible;
- line ranges are supported;
- default max bytes remains bounded;
- returned output is redacted again defensively;
- missing or expired keys return a clear error.

---

## 6. Phase 0: measurement and correctness fixes

Priority: immediate.

### 6.1 Fix model-visible byte accounting

Likely files:

- `src/perf.ts`
- `src/toolRegistry.ts`
- result shape helpers in `src/server.ts`

Tasks:

1. Record raw bytes and visible bytes separately.
2. Record structured result JSON byte size separately when practical.
3. Treat both `cacheHit` and `cache_hit` as cache-hit signals.
4. Add fields for `compacted`, `rawBytes`, `visibleBytes`, `savedBytes`, `retrievalKeyPresent`.
5. Update `least_perf` to show largest model-visible outputs.

Acceptance criteria:

- `least_perf` shows top tools by visible bytes.
- `least_perf` shows cache-hit rates for tools returning either camelCase or snake_case cache flags.
- No existing tool result schemas break.

Tests:

- add a unit/smoke script that feeds representative result shapes into perf recording;
- verify `cacheHit: true` increments cache-hit counters;
- verify large output appears in largest-output report.

### 6.2 Stream `rg --files` and stop early

Likely files:

- `src/filesOps.ts`
- `src/processRunner.ts` if a reusable streaming helper is needed

Tasks:

1. Add streaming process helper for line-oriented output.
2. Stop reading once `maxResults` plus a small buffer is reached.
3. Kill the child process cleanly after enough results are collected.
4. Preserve fallback behavior when `rg` is unavailable.
5. Ensure `truncated` is true when early stop occurs.

Acceptance criteria:

- `files` on a large repo returns quickly when `maxResults` is small.
- Output order remains stable.
- Blocked globs are still enforced.

Tests:

- generated repo with 25k files;
- `files({ maxResults: 20 })` should not process all 25k results;
- compare result shape against old behavior for small repos.

### 6.3 Correct returned-byte budgeting for range reads

Likely files:

- `src/fsOps.ts`
- `src/contextPackOps.ts` if it consumes read byte values

Tasks:

1. Introduce `fileBytes` and `returnedBytes` fields.
2. Preserve existing `bytes` as `returnedBytes` or add compatibility notes.
3. Update `read_many` to enforce total budget against returned bytes.
4. Keep `totalBytes` or `fileBytes` for caller visibility.

Acceptance criteria:

- reading 20 small ranges from large files is not rejected because the full files are large;
- callers still know when the underlying file is large;
- no stale-write protection behavior is weakened.

### 6.4 Improve `show_changes` for untracked files

Likely files:

- `src/reviewOps.ts`
- `src/gitOps.ts`

Tasks:

1. Summarize untracked file count.
2. Include top untracked file paths up to a bounded limit.
3. Include size estimates for untracked files where cheap.
4. Classify likely generated files, lockfiles, docs, source, tests, config.
5. Preserve ability to request full diff for tracked changes.

Acceptance criteria:

- a repo with only untracked files gets a useful `show_changes` summary;
- generated/lockfile noise is clearly labeled;
- no content from ignored/blocked secret files leaks.

---

## 7. Phase 1: output shaper MVP

Priority: highest feature impact.

### 7.1 Add `src/outputShaper.ts`

Tasks:

1. Define the compactor interface.
2. Implement `shapeTextOutput(input, options)`.
3. Add default byte thresholds:
   - raw if output < 8 KB;
   - compact if output >= 8 KB and kind is known;
   - truncate with first/last/error preservation if kind is unknown and output exceeds cap.
4. Estimate tokens with a cheap heuristic initially: `Math.ceil(chars / 4)`.
5. Verify compacted output is smaller. If not, return raw.
6. Record compaction stats into `perf`.

Acceptance criteria:

- no tool output grows because of compaction;
- output includes a clear summary when compacted;
- retrieval key appears only when raw output is stored.

### 7.2 Add `src/toolOutputStore.ts`

Tasks:

1. Choose workspace-local cache root.
2. Implement write-by-hash.
3. Implement read-by-key with line ranges.
4. Add TTL cleanup opportunistically.
5. Add defensive redaction before storing.
6. Add max raw-output storage size per item.

Suggested defaults:

```text
LEAST_OUTPUT_STORE=1
LEAST_OUTPUT_STORE_TTL_MS=86400000
LEAST_OUTPUT_STORE_MAX_ITEM_BYTES=5242880
```

Acceptance criteria:

- compacted outputs can be retrieved by key;
- expired/missing keys fail clearly;
- no path traversal is possible via key.

### 7.3 Add `retrieve_output` tool

Likely files:

- `src/server.ts`
- `src/toolRegistry.ts`
- `src/toolOutputStore.ts`

Tool shape:

```ts
retrieve_output({
  workspace_id?: string,
  key: string,
  start_line?: number,
  end_line?: number,
  max_bytes?: number
})
```

Acceptance criteria:

- the tool is read-only;
- respects workspace boundary;
- returns line-numbered ranges;
- returns metadata: raw bytes, returned bytes, truncated flag.

### 7.4 Wire MVP compactors into tools

Start with these integrations:

1. `gitDiff` -> `git_diff` compactor.
2. `show_changes` -> `show_changes` compactor.
3. `bash` -> `test_log`, `lint_log`, `tsc_log`, or `text` compactor based on command.
4. `search_context` -> `search` compactor when many matches exist.

Do not alter edit/write tools in this phase.

---

## 8. Phase 1 compactor specifications

### 8.1 Search compactor

Rules:

1. Group by file path.
2. Keep match count per file.
3. Preserve line numbers and context lines.
4. Collapse repeated adjacent matches.
5. Show top files first by match count and exactness.
6. Include omitted file/match counts.

Output example:

```text
Search compacted: 184 matches in 37 files -> showing 12 files, 40 snippets. Raw output: retrieve_output key sha256:...

src/contextPackOps.ts - 22 matches
  L41-L52: ...
  L188-L205: ...

src/searchOps.ts - 16 matches
  L90-L112: ...

Omitted: 25 files, 144 matches. Use retrieve_output(...) for the full result.
```

Tests:

- preserves before/after context;
- does not count context lines as matches;
- handles Windows paths;
- handles no-match output;
- handles NUL/control characters by stripping or escaping them.

### 8.2 Git diff compactor

Rules:

1. Always show file summary first.
2. Preserve small diffs entirely.
3. For large diffs, keep:
   - file headers;
   - hunk headers;
   - changed function/class/type names when detectable;
   - added/removed lines around errors/config/API surfaces;
   - imports/exports changes;
   - package/script changes;
   - test assertions.
4. Collapse generated/lockfile hunks aggressively.
5. Preserve binary-file notices.
6. Store raw diff when compacted.

Tests:

- preserves patch headers;
- no fake line numbers;
- package.json script changes always retained;
- lockfile large hunks are summarized;
- binary file messages retained.

### 8.3 Show changes compactor

Rules:

1. Show branch/status summary.
2. Show staged/unstaged/untracked buckets separately.
3. Show changed file categories: source, tests, docs, config, generated, lockfiles.
4. Include diffstat when available.
5. Include raw diff retrieval key if full diff omitted.
6. Explicitly show when no tracked diff exists but untracked files exist.

Tests:

- untracked-only repo;
- staged-only repo;
- mixed staged/unstaged/untracked;
- many generated files.

### 8.4 Test log compactor

Rules:

1. Preserve command, duration, exit code, timeout, signal.
2. If success and output is large, return a short success summary plus last few lines.
3. If failure, preserve:
   - failing test names;
   - assertion messages;
   - stack frames within workspace;
   - expected/received blocks;
   - first error and final summary.
4. Deduplicate repeated stack frames and repeated warnings.
5. Store raw log when compacted.

Command detection:

- `npm test`, `pnpm test`, `yarn test`, `bun test` -> test log;
- `npm run typecheck`, `tsc`, `npx tsc` -> TypeScript diagnostics;
- `eslint`, `biome`, `ruff`, `cargo clippy` -> lint diagnostics;
- fallback -> text compactor.

### 8.5 JSON compactor

Rules:

1. Preserve keys.
2. Preserve booleans, nulls, numbers, short strings, IDs, hashes, UUID-like strings.
3. Summarize long strings.
4. Summarize large arrays with count, first N, last N, and notable outliers.
5. Never emit invalid JSON unless explicitly marked as summary text.

Start with readable `json_summary`; do not pretend summarized JSON is original data.

---

## 9. Phase 2: `context_pack v2`

Priority: high.

### 9.1 Purpose

`context_pack` should be the default first serious call for a coding task. It should reduce exploration loops from many calls to one high-signal response.

### 9.2 New ranking model

Add `src/contextRanker.ts`.

Signals:

```ts
interface ContextSignalScores {
  queryHitScore: number;
  exactSymbolScore: number;
  pathNameScore: number;
  importNeighborScore: number;
  gitChangedScore: number;
  testAdjacencyScore: number;
  packageScriptScore: number;
  memoryScore: number;
  recentCommitScore: number;
  sizePenalty: number;
  generatedPenalty: number;
}
```

Default priorities:

- exact symbol hit: very high;
- changed file: high;
- test adjacency: high for edit/debug/review profiles;
- import neighbor: medium;
- package/config anchor: medium;
- generated/lockfile penalty: high;
- large file penalty: medium unless exact hit.

### 9.3 Profiles

Add `profile` option:

```ts
profile?: "explore" | "edit" | "debug" | "review"
```

Behavior:

- `explore`: architecture files, README, package config, top matched source files.
- `edit`: matched source files, nearby tests, imports, current git status.
- `debug`: failing logs, suspect files, tests, recent changes, error snippets.
- `review`: changed files, diff summary, tests touched, risky config/API changes.

### 9.4 Output shape

```ts
interface ContextPackV2Result {
  task: string;
  profile: "explore" | "edit" | "debug" | "review";
  summary: string;
  selectedFiles: Array<{
    path: string;
    reason: string;
    score: number;
    scoreBreakdown: Partial<ContextSignalScores>;
    snippets: Array<{ startLine: number; endLine: number; text: string }>;
  }>;
  omitted: {
    files: number;
    snippets: number;
    reasons: string[];
  };
  git?: { branch?: string; statusSummary?: string };
  packageContext?: { scripts?: string[]; dependencies?: string[] };
  suggestedNextCalls: string[];
  rawRetrievalKey?: string;
}
```

### 9.5 Implementation tasks

1. Keep current `contextPack` signature backward compatible.
2. Add optional `profile` and `explain` fields.
3. Use `project_map` result when available or cheap to compute.
4. Use `git status` cache.
5. Use `package.json` scripts and dependencies.
6. Use project memory once Phase 4 exists.
7. Deduplicate snippets across search and file reads.
8. Apply output shaper if result exceeds max bytes.

Acceptance criteria:

- for a symbol task, selected files include exact hits and likely tests;
- for a review task, changed files outrank unrelated matches;
- output explains why files were selected;
- suggested next calls are concrete and minimal.

---

## 10. Phase 3: local `gain` and `discover` analytics

Priority: medium-high.

### 10.1 Extend `least_perf`

Add fields:

- top visible-byte tools;
- top raw-byte tools;
- total saved bytes from compaction;
- estimated saved tokens from compaction;
- compaction hit/fallback rate;
- retrieval count;
- cache-hit rate by tool/backend;
- slowest tools by p50/p95;
- timeouts by tool;
- largest raw output kinds;
- recommended next optimizations.

### 10.2 Add `least_gain`

Read-only tool:

```ts
least_gain({ window?: "session" | "lifetime", format?: "text" | "json" })
```

Example output:

```text
Least gain this session
- Raw bytes processed: 4.8 MB
- Model-visible bytes emitted: 880 KB
- Estimated visible-token reduction: 81.7%
- Top savers:
  1. bash test_log: 2.1 MB -> 44 KB
  2. git diff: 900 KB -> 80 KB
  3. search_context: 340 KB -> 62 KB
- Retrievals used: 3
- Compactor fallbacks: 2
```

### 10.3 Add `least_discover`

Read-only tool:

```ts
least_discover({ window?: "session" | "lifetime" })
```

It should report missed opportunities:

- tools that produced large raw output with no compactor;
- commands that repeatedly fell back to text compactor;
- paths that repeatedly trigger generated-file noise;
- cache misses from unstable arguments;
- repeated `read` calls that should have been `read_many`;
- repeated `search` followed by reads that could have been `context_pack`.

Acceptance criteria:

- recommendations are local and actionable;
- no source content is included unless already model-visible;
- no external telemetry.

---

## 11. Phase 4: project-scoped memory

Priority: medium.

### 11.1 Purpose

Agents repeatedly rediscover repo facts. Project memory should store durable facts that reduce repeated context work.

Examples:

- test command is `npm run smoke`;
- build command is `npm run build`;
- source entry point is `src/server.ts`;
- generated files live under `dist`, `coverage`, `.next`;
- `context_pack` should include `src/toolRegistry.ts` for tool schema changes;
- a previous failed command was corrected by using `npm run build` instead of `tsc` directly.

### 11.2 Storage

Start with JSONL. Do not add a database dependency first.

Path:

```text
.least/memory/project-memory.jsonl
```

Record shape:

```ts
interface ProjectMemoryRecord {
  id: string;
  kind: "architecture" | "command" | "decision" | "warning" | "workflow" | "file_map";
  text: string;
  source: "manual" | "handoff" | "tool" | "agent";
  confidence: number;
  paths?: string[];
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}
```

### 11.3 Tools

Add later, after internal integration:

```ts
project_memory_search({ query, kind?, max_results? })
project_memory_save({ kind, text, paths?, confidence? })
project_memory_update({ id, text, supersedes? })
```

Start with internal-only reads for `context_pack` if exposed tools feel too broad.

### 11.4 Safety

Do not store:

- secrets;
- environment values;
- API keys;
- full file contents;
- private user identity facts;
- raw command lines containing tokens;
- raw paths outside the workspace.

Apply redaction before save.

---

## 12. Phase 5: minimality review

Priority: medium.

### 12.1 Add `review_minimality`

Tool:

```ts
review_minimality({ path?, include_untracked?: boolean, max_findings?: number })
```

It should inspect current changes and flag:

- new dependency where Node/browser/platform feature is enough;
- duplicated helper function already present elsewhere;
- unnecessary abstraction layers;
- large generated boilerplate;
- config churn unrelated to the task;
- custom parsing where `URL`, `URLSearchParams`, `Intl`, `crypto`, `path`, or `fs` would do;
- unnecessary shell/backend complexity;
- low-value code introduced without tests.

It must not recommend removing:

- validation at trust boundaries;
- error handling;
- auth checks;
- redaction;
- path guards;
- accessibility behavior;
- tests that prove behavior.

### 12.2 Output shape

```text
Minimality review: 4 findings

1. New helper duplicates existing function
   File: src/foo.ts
   Existing equivalent: src/bar.ts:42
   Recommendation: reuse existing helper.
   Risk: low

2. New dependency may be unnecessary
   File: package.json
   Dependency: left-pad-example
   Native alternative: String.prototype.padStart
   Risk: medium
```

---

## 13. Phase 6: adapter portability

Priority: lower, useful for adoption.

### 13.1 Canonical instruction source

Create one canonical Least agent instruction file, for example:

```text
docs/agent-instructions/least-agent-core.md
```

Then generate thin adapters for:

- `AGENTS.md` or `AGENTS.example.md`;
- `.github/copilot-instructions.md`;
- `.cursor/rules/least.mdc`;
- `.windsurf/rules/least.md`;
- `.clinerules/least.md`;
- Codex plugin instructions if used;
- Gemini/Antigravity-compatible instruction files if used.

### 13.2 Adapter rule

Adapters should not fork behavior. They should either include the canonical text or be generated from it.

### 13.3 Useful Least-specific instruction themes

- Prefer `context_pack` first for non-trivial repo tasks.
- Prefer `search_context` over `search` plus repeated `read`.
- Prefer `read_many` over repeated `read`.
- Prefer `show_changes` before final summary.
- Use `retrieve_output` only when compact output is insufficient.
- Use `least_perf` / `least_gain` when optimizing Least itself.
- Do not use raw shell for normal file browsing.

---

## 14. Configuration plan

Add options gradually.

Suggested config fields:

```ts
export type OutputMode = "raw" | "compact" | "compressed";

interface LeastConfig {
  outputMode: OutputMode;
  outputStore: boolean;
  outputStoreTtlMs: number;
  outputStoreMaxItemBytes: number;
  compactSearch: boolean;
  compactGitDiff: boolean;
  compactShell: boolean;
  projectMemory: boolean;
}
```

Environment variables:

```text
LEAST_OUTPUT_MODE=compact
LEAST_OUTPUT_STORE=1
LEAST_OUTPUT_STORE_TTL_MS=86400000
LEAST_OUTPUT_STORE_MAX_ITEM_BYTES=5242880
LEAST_COMPACT_SEARCH=1
LEAST_COMPACT_GIT_DIFF=1
LEAST_COMPACT_SHELL=1
LEAST_PROJECT_MEMORY=0
```

Defaults:

- `outputMode=compact` only for tools known to emit noisy output;
- output store enabled when compaction/truncation occurs;
- project memory off until stable or behind explicit flag.

---

## 15. Testing plan

### 15.1 Unit and smoke scripts

Add scripts under `scripts/` rather than introducing a new test framework immediately:

```text
scripts/output-shaper-unit.mjs
scripts/output-store-unit.mjs
scripts/context-ranker-unit.mjs
scripts/gain-unit.mjs
scripts/project-memory-unit.mjs
scripts/minimality-review-unit.mjs
```

Wire them into `npm run smoke` as phases land.

### 15.2 Regression fixtures

Create generated test data inside temp dirs:

- large git diff;
- generated lockfile-like diff;
- many untracked files;
- TypeScript compiler diagnostics;
- ESLint diagnostics;
- Jest/Vitest failure output;
- ripgrep context output;
- large JSON arrays;
- large file range reads.

### 15.3 Compactor invariants

Every compactor must pass:

1. output is no larger than input unless raw fallback is chosen;
2. errors are preserved;
3. line/file references are preserved;
4. control characters do not leak;
5. no secrets appear after redaction;
6. deterministic output for same input;
7. retrieval key exists when content is compacted/truncated and storage is enabled.

### 15.4 Benchmark updates

Update:

- `scripts/fast-exploration-benchmark.mjs`
- `scripts/perf-scale-benchmark.mjs`

Add fields:

```json
{
  "rawBytes": 1000000,
  "visibleBytes": 120000,
  "savedBytes": 880000,
  "estimatedTokensBefore": 250000,
  "estimatedTokensAfter": 30000,
  "compacted": true
}
```

Add scenarios:

- large diff;
- large test failure;
- large search result;
- `context_pack` with many candidates;
- retrieve raw output by key.

---

## 16. Rollout plan

### Step 1: internal-only shaping helpers

Implement `outputShaper` and unit tests, but do not wire into tools yet.

### Step 2: opt-in compaction

Add config/env flags and allow explicit `output_mode: "compact"` where schemas support it.

### Step 3: default compact mode for known noisy tools

Enable by default for:

- `bash` outputs over threshold;
- `gitDiff` over threshold;
- `show_changes` summaries;
- `search_context` with many matches.

### Step 4: retrieval tool

Expose `retrieve_output` only after storage and workspace isolation are tested.

### Step 5: gain/discover

Expose analytics once compaction stats are reliable.

### Step 6: context_pack v2 and memory

Upgrade ranking after compaction is stable. Add project memory behind a flag.

---

## 17. Prioritized implementation checklist

### P0: must do first

- [ ] Fix `cacheHit` / `cache_hit` accounting in perf.
- [ ] Add raw bytes vs visible bytes tracking.
- [ ] Stream and early-stop `rg --files` in `files`.
- [ ] Correct range-read returned-byte accounting.
- [ ] Improve `show_changes` untracked-file summaries.

### P1: output shaper MVP

- [ ] Add `src/outputShaper.ts`.
- [ ] Add `src/toolOutputStore.ts`.
- [ ] Add text fallback compactor.
- [ ] Add search compactor.
- [ ] Add git diff compactor.
- [ ] Add show changes compactor.
- [ ] Add bash/test log compactor.
- [ ] Add `retrieve_output` tool.
- [ ] Wire compaction metrics into `least_perf`.

### P2: context quality

- [ ] Add `src/contextRanker.ts`.
- [ ] Add `profile` to `context_pack`.
- [ ] Add score breakdowns.
- [ ] Include test adjacency.
- [ ] Include import neighbors where cheap.
- [ ] Include git changed-file signal.
- [ ] Add suggested next calls.

### P3: analytics

- [ ] Extend `least_perf` with visible bytes and saved bytes.
- [ ] Add `least_gain`.
- [ ] Add `least_discover`.
- [ ] Add benchmark fields for raw/visible/saved bytes.

### P4: project memory

- [ ] Add `src/projectMemory.ts`.
- [ ] Store JSONL memory under `.least/memory`.
- [ ] Add redaction and deduplication.
- [ ] Integrate memory read into `context_pack` behind flag.
- [ ] Optionally expose memory search/save tools.

### P5: minimality and portability

- [ ] Add `review_minimality`.
- [ ] Add canonical agent instruction source.
- [ ] Add or document adapter generation.
- [ ] Update README and tool guidance.

---

## 18. Acceptance criteria for the whole plan

The plan should be considered successful when:

1. A large test/log/diff/search workflow emits at least 60% fewer model-visible bytes without losing actionable errors or file references.
2. Any compacted/truncated output can be retrieved by key.
3. `context_pack` selects more relevant files than simple search-first exploration in generated source/test scenarios.
4. `least_perf` can explain both runtime cost and output-volume cost.
5. `least_gain` shows concrete local savings.
6. `least_discover` identifies at least three classes of missed optimization opportunities.
7. No default behavior sends telemetry outside the machine.
8. No compactor hides failures, timeouts, or unsafe operations.
9. Existing smoke tests continue passing.
10. New tests cover search, diff, shell/test logs, retrieval, and byte accounting.

---

## 19. Implementation risks and mitigations

### Risk: compactors hide important details

Mitigation:

- preserve errors and line/file references by invariant;
- store raw output;
- add regression tests with failure output;
- fallback to raw when unsure.

### Risk: output store leaks sensitive data

Mitigation:

- redact before storage;
- do not store outputs that match high-confidence secret patterns;
- use workspace-local storage;
- enforce key-only access, no arbitrary path reads;
- add TTL cleanup.

### Risk: schemas become too complex

Mitigation:

- add optional fields;
- keep existing string output paths compatible;
- use common shaped-output metadata internally first.

### Risk: `context_pack` becomes slow

Mitigation:

- use cached project map;
- cap candidates;
- use cheap scoring first;
- make import-neighbor scoring optional or bounded;
- report partial results if time budget is hit.

### Risk: project memory accumulates stale facts

Mitigation:

- store provenance and timestamps;
- include confidence;
- support supersession;
- keep memory behind a flag initially;
- surface memory facts with source labels.

---

## 20. Recommended first PR

Title:

```text
Add output byte accounting and compact-output groundwork
```

Contents:

1. Fix perf cache-hit accounting for `cacheHit` and `cache_hit`.
2. Add raw/visible byte fields to perf recording.
3. Add `src/outputShaper.ts` with text fallback compactor only.
4. Add `scripts/output-shaper-unit.mjs`.
5. Update `least_perf` output to show largest visible outputs.
6. Do not wire compaction into default tool behavior yet.

Why this first:

- low risk;
- proves measurement;
- creates the interface for later compactors;
- avoids changing user-visible tool output before tests exist.

Second PR:

```text
Add raw output store and retrieve_output tool
```

Third PR:

```text
Compact git diff, show_changes, and shell/test logs behind opt-in output_mode
```

Fourth PR:

```text
Upgrade context_pack ranking with profile-aware score breakdowns
```

---

## 21. Notes for future implementers

Do not optimize for aesthetic terseness. Optimize for agent usefulness per visible token.

A good compact output is not merely shorter. It must answer:

- what happened;
- where it happened;
- whether it failed;
- what to inspect next;
- how to retrieve omitted details.

Least should remain deterministic, local, and recoverable. The research projects are useful because they show where agent workflows waste tokens and time. The right Least implementation is smaller and more direct than those projects: compact the tool result at the source, store the raw output locally, rank context better, and measure the difference.
