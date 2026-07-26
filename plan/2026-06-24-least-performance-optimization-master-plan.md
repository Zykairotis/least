# Least Performance Optimization Plan

Date: 2026-06-24

Scope: speed, latency, throughput, large-repo behavior, tool-call count, cache design, timeout behavior, and agent workflow efficiency for the Least local MCP bridge.

Non-goal: this plan intentionally does not focus on security hardening except where a performance feature needs a safe default. The goal is to make Least feel much faster during normal local coding, PR review, repo exploration, and multi-agent handoff workflows.

---

## 1. Why this plan exists

Least already has many of the right primitives: `files`, `tree`, `search`, `search_context`, `read`, `read_many`, `json_query`, `show_changes`, `bash`, `handoff_to_agent`, and workspace-aware context tools. The remaining speed problem is not only raw filesystem performance. The larger problem is that an agent often needs many small tool calls to complete one coding task.

A typical agent loop today can look like this:

```text
open_current_workspace
files
search_context
read
read_many
search_context
read
edit
show_changes
bash
show_changes
```

Even if each tool call is reasonably fast, the total workflow can feel slow because of repeated round trips, repeated filesystem work, repeated process spawning, and large outputs that the model has to read. The fastest version of Least should reduce both of these:

1. wall-clock time per tool call;
2. number of tool calls needed per task.

The core idea is simple: make individual tools faster, then add higher-level tools that collapse common agent workflows into one call.

---

## 2. Current repo context

Observed project context from the current Least workspace:

- Package: `least@0.31.0`.
- Runtime: Node.js >= 20, TypeScript, MCP SDK, Express, zod, minimatch, zod-to-json-schema.
- Main server files: `src/server.ts`, `src/http.ts`, `src/stdio.ts`, `src/toolRegistry.ts`.
- Filesystem and edit logic: `src/fsOps.ts`, `src/guard.ts`, `src/workspaceLocks.ts`.
- Search and file discovery: `src/filesOps.ts`, `src/searchOps.ts`, `src/jsonQueryOps.ts`.
- Workspace context: `src/workspaceOps.ts`, `src/proContext.ts`, `src/capabilitiesOps.ts`.
- CLI / launcher: `scripts/least.mjs`.
- Existing performance scripts: `scripts/fast-exploration-benchmark.mjs`, `scripts/fast-exploration-unit.mjs`.

Current small synthetic benchmark result from `node scripts/fast-exploration-benchmark.mjs`:

```json
{
  "totalMs": 85,
  "scenarios": [
    { "label": "open_current_workspace_fast", "elapsedMs": 9 },
    { "label": "files_candidate_discovery", "elapsedMs": 44, "backend": "ripgrep" },
    { "label": "search_symbol", "elapsedMs": 15, "backend": "ripgrep" },
    { "label": "search_context_symbol", "elapsedMs": 12, "backend": "ripgrep" },
    { "label": "read_many_three_files", "elapsedMs": 5 }
  ]
}
```

This is good for a tiny generated repo, but it does not prove real-world performance for large repos, monorepos, Windows filesystem behavior, WSL mounts, large files, lockfiles, generated folders, or repeated agent loops. The new plan should measure and optimize those cases.

---

## 3. Reference context

This plan is aligned with these public reference points:

- OpenAI Apps SDK Reference: https://developers.openai.com/apps-sdk/reference
  - Relevant for tool descriptors, compact metadata, output schemas, `structuredContent`, `content`, and `_meta` separation.
- OpenAI Apps SDK Security and Privacy guide: https://developers.openai.com/apps-sdk/guides/security-privacy
  - Used only for safe telemetry and data minimization principles.
- MCP Tools specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
  - Relevant for tool result design and output schema behavior.
- MCP Transports specification: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
  - Relevant for Streamable HTTP sessions, request/response flow, and transport constraints.
- MCP tool-description efficiency research: https://arxiv.org/abs/2602.14878
  - Useful background for why compact tool descriptions and better tool routing can improve agent efficiency.

Important design implication: model-visible output should be compact, typed, and easy to consume. Large payloads should be optional, summarized, or moved into UI-only metadata where appropriate.

---

## 4. Performance model

Least performance should be understood as a pipeline:

```text
client request
  -> MCP / HTTP transport overhead
  -> auth / session lookup
  -> tool routing and schema handling
  -> workspace lookup and path guard
  -> filesystem / git / rg / shell operation
  -> formatting / redaction / diff generation
  -> JSON serialization
  -> model reads result
  -> model decides next tool call
```

Optimizing only the filesystem part is not enough. For agent workflows, the slow parts often include:

- repeated MCP round trips;
- repeated tool selection by the model;
- huge text outputs that slow down reasoning;
- full-file reads for small line ranges;
- accumulating all `rg` output before truncating;
- repeated `git status` and `git ls-files` process spawns;
- sequential reads inside `read_many`;
- expensive diff generation even when a summary would be enough;
- lack of timeouts and partial results for expensive tools;
- cold-start command probes and first-use indexing.

The plan therefore has two layers:

1. low-level optimizations: streaming, caching, early stopping, concurrency, timeouts;
2. high-level workflow optimizations: batch tools, context packing, changed-file summaries, project maps.

---

## 5. Performance goals

Suggested target metrics:

| Operation | Target |
|---|---:|
| `read` 100-line range from 5 MB file | <120 ms cold, <30 ms warm |
| `read_many` 20 small files | <60 ms warm with concurrency 8 |
| `files src/**/*.ts` on 10k-file repo | <800 ms cold, <150 ms warm |
| fixed-string `search` on 10k-file repo | stop after max results within 300 ms warm |
| `search_context` max 20 matches | <500 ms cold with streaming rg |
| `open_current_workspace` without tree/skills | <30 ms warm |
| `show_changes` summary only | <150 ms typical repo |
| `context_pack` for common PR task | <1s for 20 useful snippets |
| batch of 5 read-only tools | <60% of sequential wall time |
| standard tool descriptor payload size | reduce by at least 30% |

These targets should be treated as engineering budgets, not marketing claims. Benchmark scripts should measure p50 and p95 separately for cold and warm cache runs.

---

## 6. Priority 0: Add performance telemetry first

Before implementing major speed changes, add a small timing layer to every tool invocation. Without telemetry, it will be hard to know whether an optimization actually helped.

### What to measure

Each tool call should record:

- tool name;
- workspace id;
- total duration;
- time spent in path resolution / guard checks;
- time spent in filesystem reads/writes;
- time spent spawning child processes;
- output byte size;
- model-visible text byte size;
- structured result size;
- cache hit or miss;
- timeout / partial result status;
- backend used: `node`, `ripgrep`, `git`, `cache`, etc.

### Where to implement

Primary files:

- `src/toolRegistry.ts`
- `src/server.ts`
- `src/http.ts`

Add a helper similar to:

```ts
async function measuredToolCall<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    recordTiming(name, performance.now() - started);
  }
}
```

### User-facing tool

Add a read-only tool:

```ts
least_perf({ reset?: boolean, window?: "session" | "lifetime" })
```

It should return:

- slowest tools;
- average and p95 duration by tool;
- cache hit rate;
- child process spawn count;
- timeout count;
- largest outputs;
- current cache memory estimates.

This gives immediate feedback during development and helps users tune their setup.

---

## 7. Priority 0: Stream line-range reads

Current issue: `readTextFile()` reads the entire file, splits the entire file, hashes the entire file, and then returns the selected range. That is simple and correct, but inefficient when the user only needs a small line range from a large file.

### Current behavior to improve

Current shape in `src/fsOps.ts`:

```ts
const buffer = await fsp.readFile(resolved.absPath);
const text = buffer.toString("utf8");
const allLines = splitLines(text);
const selected = allLines.slice(startLine - 1, endLine);
const numbered = withLineNumbers(selected, startLine);
const sha = sha256(text);
```

### Proposed behavior

Add a fast path:

```text
read(path, start_line, end_line, include_sha256=false)
  -> resolve and guard path
  -> stat file
  -> stream file line by line
  -> skip until start_line
  -> collect until end_line
  -> stop reading immediately
  -> return selected lines
```

Only compute full-file SHA when the caller asks for it:

```ts
include_sha256?: boolean
```

Default should be:

- `include_sha256: false` for exploration reads;
- `include_sha256: true` when an edit workflow explicitly needs stale-write protection.

### Tool schema changes

Add optional arguments to `read` and `read_many`:

```ts
include_sha256?: boolean
include_line_numbers?: boolean
max_tokens_estimate?: number
```

### Tradeoff

Streaming line ranges means total line count may require a full scan. Options:

1. keep `totalLines` only when cheap or requested;
2. return `totalLines: undefined` for fast partial reads;
3. maintain a cached line index for large frequently-read files.

Best first step: return exact `totalLines` only for full-file reads or when `include_total_lines=true`.

---

## 8. Priority 0: Parallelize `read_many`

Current issue: `read_many` reads files sequentially. For many small files, this wastes time because disk and OS caches can handle multiple small reads efficiently.

### Proposed behavior

Implement a concurrency-limited worker pool:

```ts
read_many({ items, concurrency = 8 })
```

Rules:

- preserve output order;
- dedupe identical path/range requests;
- stop when `max_total_bytes` or `max_tokens_estimate` is reached;
- use streaming line reads for ranged reads;
- avoid SHA calculation unless requested;
- report skipped files with reasons.

### Expected effect

Reading 20 small files should become closer to 3 batches of disk work instead of 20 sequential waits. This is especially important for agents because they often inspect many related source files at once.

### Implementation location

Primary file: `src/fsOps.ts`.

Add a generic helper:

```ts
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>;
```

---

## 9. Priority 0: Stream ripgrep output and stop early

Current issue: `searchOps.ts` accumulates stdout into a string and parses after the child process exits. It also uses `--max-count`, which limits matches per file rather than guaranteeing a global max result count.

### Why this matters

In a large repo, a query can match thousands of lines. Least may only need 20. The fastest behavior is to parse lines as they arrive and terminate ripgrep once the requested result budget is satisfied.

### Proposed behavior

Use streaming parsing:

```text
spawn rg
for each stdout chunk:
  split into complete lines
  parse line or json event
  append match
  if matches.length >= maxResults:
    kill child
    return partial result with truncated=true
```

### Prefer `rg --json`

`rg --json` avoids fragile parsing of paths containing colons or unusual characters. It also makes context handling more reliable.

Proposed command style:

```bash
rg --json --line-number --color=never --fixed-strings QUERY ROOT
```

### Result behavior

Return:

```ts
{
  matches,
  truncated: true | false,
  used: "ripgrep",
  timing,
  killedAfterMaxResults: true | false
}
```

### Implementation location

Primary file: `src/searchOps.ts`.

---

## 10. Priority 0: Add per-tool timeouts and cancellation

Current issue: `bash` has timeout support, but normal tools like `search`, `files`, `tree`, `read_many`, `json_query`, `export_pro_context`, and future `context_pack` need explicit budgets too.

### Proposed defaults

| Tool | Default timeout |
|---|---:|
| `read` | 5s |
| `read_many` | 10s |
| `files` | 5s |
| `tree` | 5s |
| `search` | 10s |
| `search_context` | 10s |
| `json_query` | 5s |
| `show_changes` summary | 10s |
| `show_changes` full diff | 30s |
| `export_pro_context` | 30s |
| `context_pack` | 30s |
| `project_map` cold build | 60s |

### Behavior on timeout

Tools should return partial results when possible:

```ts
{
  partial: true,
  timedOut: true,
  resultsCollected: n,
  message: "Timed out after 10000ms; returned partial results."
}
```

Hard failures should be reserved for operations that cannot safely return partial data.

### Implementation location

Add a helper:

```ts
withTimeout<T>(name: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T>
```

External child processes must receive a kill signal on abort.

---

## 11. Priority 0: Workspace file index cache

Current issue: file discovery is repeated across tools. `files`, `search` fallback, `json_query`, `export_pro_context`, and future context tools all need a list of files.

### Proposed cache

Create a per-workspace cache:

```ts
type WorkspaceFileIndex = {
  workspaceId: string;
  root: string;
  generatedAt: number;
  backend: "git" | "ripgrep" | "node";
  files: Array<{
    path: string;
    size?: number;
    mtimeMs?: number;
    kind?: "source" | "test" | "docs" | "config" | "lockfile" | "generated" | "unknown";
  }>;
}
```

### Cache policy

- TTL: 2-5 seconds for simple file list.
- Longer mtime-based validity for symbol maps and package context.
- Invalidate on `write`, `edit`, `multi_edit`, `apply_patch`, `handoff_to_agent`, or explicit `refresh: true`.
- Keep memory bounded by max file count and max cached workspaces.

### Why short TTL is enough

Agent workflows often make several tool calls within a few seconds. Even a 2-second cache can remove repeated `rg --files` or `git ls-files` calls during one reasoning loop.

---

## 12. Priority 1: Git status and `git ls-files` cache

Current issue: workspace summaries and file discovery repeatedly call git. Git is fast, but process spawning and repo scans add up.

### Cache these separately

- `git status --short --branch`: TTL 1-2 seconds.
- `git ls-files`: TTL 2-5 seconds.
- `git diff --name-only`: TTL 1-2 seconds.
- `git diff --stat`: TTL 1-2 seconds.

### Invalidation

Invalidate on:

- Least writes/edits;
- mutation shell commands;
- explicit refresh;
- timeout expiry.

### Why separate caches

`git status` changes more often than tracked file list. `git ls-files` can be cached slightly longer.

---

## 13. Priority 1: Add a `batch` tool

The largest agent speed gain may come from reducing round trips. Add a read-only batching tool first.

### Proposed schema

```ts
batch({
  calls: Array<{
    tool: "files" | "tree" | "search" | "search_context" | "read" | "read_many" | "json_query" | "git_status" | "git_diff" | "workspace_snapshot";
    args: Record<string, unknown>;
  }>;
  max_parallel?: number;
  timeout_ms?: number;
})
```

### Behavior

- Only allow read-only tools in v1.
- Run independent calls concurrently.
- Preserve call order in the result.
- Return partial results if one call times out.
- Enforce per-call and whole-batch output budgets.

### Example use

```json
{
  "calls": [
    { "tool": "files", "args": { "glob": "src/**/*.ts", "max_results": 200 } },
    { "tool": "json_query", "args": { "path": "package.json", "pointer": "/scripts" } },
    { "tool": "search_context", "args": { "query": "ToolRegistry", "path": "src", "max_matches": 10 } }
  ]
}
```

### Why this matters

A single batch call can replace 3-6 model/tool round trips. For ChatGPT and Grok workflows, reducing round trips often matters more than shaving 10ms off a filesystem function.

---

## 14. Priority 1: Add `context_pack`

`context_pack` should be the high-level tool that solves the common problem: “Find the files and snippets needed for this task.”

### Proposed schema

```ts
context_pack({
  task: string;
  query?: string;
  paths?: string[];
  globs?: string[];
  max_files?: number;
  max_snippets?: number;
  max_bytes?: number;
  max_tokens_estimate?: number;
  include_git_status?: boolean;
  include_package_context?: boolean;
})
```

### What it should do

1. Use provided paths/globs if present.
2. Use cached file index to identify likely files.
3. Run `search_context` if query is provided.
4. Rank candidate files by relevance.
5. Read only useful snippets or small full files.
6. Include package/script context when helpful.
7. Return a compact summary plus snippets.

### Output shape

```ts
{
  summary: string;
  candidateFiles: string[];
  snippets: Array<{
    path: string;
    startLine: number;
    endLine: number;
    reason: string;
    text: string;
  }>;
  skipped: Array<{ path: string; reason: string }>;
  timing: TimingInfo;
}
```

### Why it matters

Without `context_pack`, the model must manually orchestrate `files`, `search`, `read`, and `read_many`. With `context_pack`, one tool can collect the context needed for an implementation or review task.

---

## 15. Priority 1: Add `read_around`

Agents often know a file and line number from search results, but they do not know the exact range to read. `read_around` removes that friction.

### Schema

```ts
read_around({
  path: string;
  line: number;
  before?: number;
  after?: number;
  include_sha256?: boolean;
})
```

### Example

```json
{
  "path": "src/server.ts",
  "line": 420,
  "before": 40,
  "after": 80
}
```

### Implementation

This can reuse the new streaming line-range read engine.

---

## 16. Priority 1: Add `read_changed_files`

PR review and local coding loops often begin with changed files. Add one tool that understands that workflow.

### Schema

```ts
read_changed_files({
  include_untracked?: boolean;
  include_staged?: boolean;
  include_unstaged?: boolean;
  globs?: string[];
  exclude_globs?: string[];
  max_files?: number;
  max_bytes?: number;
  include_lockfiles?: boolean;
  include_generated?: boolean;
})
```

### Behavior

- Get changed file list from git.
- Classify files: source, tests, docs, config, lockfile, generated, large, binary.
- Read source/test/config files first.
- Summarize skipped large/generated files.
- Return compact context suitable for review.

### Why it matters

This replaces a slow manual loop:

```text
git_status
show_changes
read_many selected files
search_context for related symbols
```

---

## 17. Priority 1: Add `diff_summary` and lazy full diff

Current issue: full diffs can be expensive and large. Many workflows only need a summary first.

### New tool

```ts
diff_summary({
  path?: string;
  staged?: boolean;
  classify?: boolean;
})
```

### Output

```ts
{
  files: Array<{
    path: string;
    status: string;
    additions?: number;
    deletions?: number;
    kind?: string;
    risk?: "low" | "medium" | "high";
  }>;
  totals: { files: number; additions: number; deletions: number };
}
```

### Change `show_changes`

Keep current full diff behavior, but add:

```ts
include_diff?: boolean
summary_only?: boolean
diff_max_chars?: number
```

Default for large diffs should be summary-first.

---

## 18. Priority 1: Add `multi_edit` and `apply_patch`

Current issue: edit-heavy tasks require many tool calls. Each call performs path checks, file reads, diff generation, and result formatting.

### `multi_edit`

```ts
multi_edit({
  edits: Array<{
    path: string;
    old_text: string;
    new_text: string;
    replace_all?: boolean;
    expected_replacements?: number;
  }>;
  expected_sha256s?: Record<string, string>;
  include_diff?: boolean;
})
```

### `apply_patch`

```ts
apply_patch({
  patch: string;
  check_only?: boolean;
  include_diff?: boolean;
})
```

### Design note

`multi_edit` is easier and safer to implement first because it uses the existing exact replacement model. `apply_patch` is more powerful but requires careful patch parsing and rejection behavior.

### Performance value

A task that currently needs 10 edit calls could become 1 call, followed by one `show_changes` or `diff_summary`.

---

## 19. Priority 1: Add project map and symbol cache

Raw text search is useful, but coding agents benefit from a lightweight project map.

### First version: regex-based symbol map

No full TypeScript AST is required at first. Build a fast approximate map from source files:

- exported functions;
- classes;
- interfaces;
- types;
- imports;
- route-like strings;
- test files;
- config files.

### Schema

```ts
project_map({
  refresh?: boolean;
  globs?: string[];
  include_imports?: boolean;
  include_exports?: boolean;
  include_tests?: boolean;
})
```

### Output

```ts
{
  files: string[];
  symbols: Array<{
    name: string;
    kind: "function" | "class" | "type" | "interface" | "const" | "route";
    path: string;
    line?: number;
  }>;
  packageContext?: object;
  timing: TimingInfo;
}
```

### Why it matters

For questions like “where is tool registration handled?” the agent can inspect the map first rather than running several broad searches.

---

## 20. Priority 1: Compact tool descriptors and add toolsets

Tool descriptions matter because the model has to read and choose among tools. Too many verbose tools can slow decisions and increase incorrect tool choice.

### Toolset profiles

Add launch/config options:

```text
--toolset explore
--toolset edit
--toolset review
--toolset handoff
--toolset full
```

Suggested profile contents:

- `explore`: `open_current_workspace`, `files`, `search_context`, `read_many`, `json_query`, `context_pack`.
- `edit`: `open_current_workspace`, `context_pack`, `read_many`, `multi_edit`, `show_changes`, `bash`.
- `review`: `open_current_workspace`, `diff_summary`, `read_changed_files`, `search_context`, `show_changes`.
- `handoff`: `open_current_workspace`, `export_pro_context`, `handoff_to_agent`, `read_handoff`.
- `full`: current full tool set.

### Descriptor compaction

In standard mode, descriptions should be short and direct. Keep long instructions in README/CHATGPT_PROMPT, not every tool descriptor.

Example:

```text
read: Read a workspace text file or line range.
read_many: Read multiple workspace text files or ranges in one call.
context_pack: Gather compact task-relevant repo context.
```

---

## 21. Priority 2: Token-budget-aware output

Bytes are not the same as model cost. Add token-estimate budgets for tools that return text.

### Proposed option

```ts
max_tokens_estimate?: number
```

Use a rough estimator:

```ts
estimatedTokens = Math.ceil(chars / 4)
```

This should be available on:

- `read`;
- `read_many`;
- `search_context`;
- `context_pack`;
- `read_changed_files`;
- `show_changes`.

### Behavior

When the budget is reached, return partial context and a clear note about what was skipped.

---

## 22. Priority 2: Worker thread offload

Some operations are CPU-heavy and can block the server event loop:

- large diff generation;
- secret scanning over large files;
- symbol indexing;
- large JSON parsing;
- line numbering huge outputs;
- classification of thousands of files.

Move these to worker threads when input exceeds a threshold.

Suggested thresholds:

- file > 1 MB;
- diff input > 1 MB;
- project map over > 1000 files;
- JSON file > 1 MB.

Do not start with workers. Add telemetry first, then only move proven hot spots.

---

## 23. Priority 2: Warmup and startup indexing

Add a warmup tool and optional startup warmup.

### Tool

```ts
warmup({
  indexes: ["files", "git", "package", "symbols"]
})
```

### Config

```env
LEAST_WARMUP=files,git,package
```

### CLI behavior

For public tunnel / dual-client workflows, print whether warmup completed and how long it took.

Warmup should never block server startup by default. Use background warmup unless the user explicitly requests blocking behavior.

---

## 24. Priority 2: Transport and session latency tuning

Least already uses Streamable HTTP and session maps. Optimizations to consider:

- avoid repeated expensive auth/session parsing after initialization;
- keep per-session small caches for recent workspace id and lock owner id;
- avoid sorting session maps on every prune if session count is small;
- prune sessions on interval or threshold rather than every request;
- keep response payloads compact to reduce HTTP serialization cost;
- use structured responses for clients that can render UI cards.

Transport tuning is less important than read/search/batch/context improvements, but it helps when a user is going through a public tunnel.

---

## 25. Benchmark plan

The existing benchmark should evolve from a tiny synthetic repo into a scale suite.

### Repo sizes

Generate these test repos:

- tiny: 50 files;
- small: 500 files;
- medium: 5,000 files;
- large: 25,000 files;
- monorepo-like: 100,000 files with nested packages.

### File types

Include:

- TypeScript source files;
- tests;
- docs;
- JSON configs;
- lockfiles;
- generated folders;
- binary-looking files;
- large text files;
- nested package directories.

### Scenarios

Measure:

- cold `open_current_workspace`;
- warm `open_current_workspace`;
- `files` with and without glob;
- fixed-string `search`;
- regex `search`;
- `search_context`;
- line-range `read`;
- `read_many` 20 files;
- `context_pack`;
- `read_changed_files`;
- `diff_summary`;
- `multi_edit`.

### Metrics

Record:

- p50 duration;
- p95 duration;
- output bytes;
- model-visible bytes;
- number of child process spawns;
- cache hit rate;
- timeout count;
- platform;
- filesystem type if available.

---

## 26. Implementation order

Recommended order:

1. Add telemetry and `least_perf`.
2. Add timeout helper and partial-result convention.
3. Optimize `read` with streaming line ranges and optional SHA.
4. Parallelize `read_many`.
5. Stream `rg` search output and stop early.
6. Add workspace file index cache.
7. Add git status / git ls-files cache.
8. Add `read_around`.
9. Add `diff_summary` and lazy full diff options.
10. Add `read_changed_files`.
11. Add `batch` for read-only tools.
12. Add `context_pack`.
13. Add `multi_edit`.
14. Add project map / symbol cache.
15. Add toolsets and compact descriptors.
16. Add warmup.
17. Expand benchmark suite and CI gates.
18. Document fast profiles and expected workflows.

This order gives early measurable wins before adding larger workflow tools.

---

## 27. Suggested config additions

```env
LEAST_TOOL_TIMEOUT_MS=30000
LEAST_READ_TIMEOUT_MS=5000
LEAST_READ_MANY_TIMEOUT_MS=10000
LEAST_SEARCH_TIMEOUT_MS=10000
LEAST_FILES_TIMEOUT_MS=5000
LEAST_TREE_TIMEOUT_MS=5000
LEAST_READ_CONCURRENCY=8
LEAST_CACHE_TTL_MS=3000
LEAST_GIT_CACHE_TTL_MS=1500
LEAST_ENABLE_TELEMETRY=1
LEAST_ENABLE_CONTEXT_PACK=1
LEAST_ENABLE_BATCH=1
LEAST_WARMUP=files,git,package
LEAST_TOOLSET=standard
```

Defaults should remain conservative, but speed-oriented profiles can set these automatically.

---

## 28. Validation commands

Use these after each implementation wave:

```bash
npm run build
npm run smoke
node scripts/fast-exploration-unit.mjs
node scripts/fast-exploration-benchmark.mjs
node scripts/workspace-locks-unit.mjs
node scripts/http-smoke.mjs
node scripts/openai-smoke.mjs
node scripts/dual-client-smoke.mjs
npm pack --dry-run
```

For performance-specific work, add:

```bash
node scripts/perf-scale-benchmark.mjs --repo-size small
node scripts/perf-scale-benchmark.mjs --repo-size medium
node scripts/perf-scale-benchmark.mjs --repo-size large
```

---

## 29. Acceptance criteria

The optimization project should be considered successful when:

- common exploration tasks need fewer tool calls;
- large file range reads do not load full files by default;
- search stops after global max results instead of collecting unnecessary output;
- `read_many` is parallel and preserves output order;
- file and git caches show high hit rates during normal agent loops;
- tools have predictable timeout behavior;
- `context_pack` can gather useful implementation context in one call;
- `read_changed_files` can support PR review workflows without manual file selection;
- diff summaries are fast and full diffs are opt-in for large changes;
- benchmark scripts track cold and warm performance;
- docs explain the fastest workflows and profiles.

---

## 30. Final recommendation

The biggest practical improvement is not one micro-optimization. It is this combined package:

1. telemetry;
2. streaming read/search;
3. cache file/git state;
4. batch read-only calls;
5. add `context_pack` and `read_changed_files`;
6. make outputs compact and token-budget-aware.

That changes Least from “a set of useful local tools” into “a fast local agent context engine.” The goal should be for a model to understand a repo change, inspect the right files, make edits, and verify results with as few tool calls as possible.
