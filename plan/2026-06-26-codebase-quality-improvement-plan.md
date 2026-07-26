# Codebase Quality Improvement Plan

Date: 2026-06-26
Workspace: `X:\least`
Branch observed: `rebrand-to-least`
Scope: targeted quality, correctness, safety, reviewability, and maintainability improvements based on a read-only review of the current codebase.

## 1. Executive summary

The codebase is in a promising state. `npm run build` and `npm run smoke` both passed during review, and the architecture already has the right primitives for a local development bridge: path guards, workspace locks, stale write protection, read/search tools, context packs, output shaping, reversible retrieval, and local performance accounting.

The main risk is not a build failure. The main risk is behavior drift: several new systems work in the happy path but have edge cases where configuration semantics, large-file handling, review completeness, or process reliability do not match the intended design.

This plan prioritizes changes that reduce user-visible surprises and make the tool reliable under real agent workflows.

Highest-priority issues:

1. `LEAST_OUTPUT_MODE=compact` currently appears to bypass per-kind compaction flags.
2. Range reads can still reject large files before returning a small requested range.
3. Review flows can miss files inside untracked directories.
4. `multi_edit` stale SHA checks are sensitive to raw path spelling.
5. `processRunner` can double-settle after child process spawn errors.
6. Timeout and compaction metrics can be inaccurate in some edge cases.
7. Diff/search compactors need correctness hardening so they preserve actionable review context.

## 2. Guiding principles

Use these principles while implementing the fixes:

- Preserve agent usefulness over aesthetic terseness.
- Prefer deterministic behavior over clever behavior.
- Never hide failures, security warnings, timeouts, write/delete operations, file paths, line numbers, or diagnostics needed to act.
- Make compact output reversible through `retrieve_output` whenever detail is omitted.
- Keep the local bridge focused. Avoid provider-proxy behavior, request mutation, external telemetry, shell hooks, and persona-driven behavior.
- Treat build/smoke success as necessary but not sufficient. Add targeted regression tests for each discovered issue.
- Do not introduce new dependencies unless there is a clear reason that Node or existing project dependencies cannot satisfy.

## 3. Current validation baseline

Observed validation results during review:

```bash
npm run build
npm run smoke
```

Both commands passed.

Existing scripts from `package.json` include:

```bash
npm run build
npm run smoke
npm run bench:discovery
npm run bench:scale
npm run bench:apply
npm run bench
```

Recommended validation after every phase:

```bash
npm run build
npm run smoke
```

Recommended validation before merging the full plan:

```bash
npm run build
npm run smoke
npm run bench
```

## 4. Priority map

### P0 — Correctness blockers

These should be fixed before treating the branch as release-ready.

1. Fix output-mode and compaction flag semantics.
2. Fix line-range reads on large files.
3. Expand untracked directories in review flows.
4. Add regression tests for the three behaviors above.

### P1 — Reliability and safety hardening

1. Fix `multi_edit` expected SHA lookup normalization.
2. Fix child-process error double-settle handling.
3. Prevent double timeout metric recording.
4. Harden output-store path containment checks.

### P2 — Compactor correctness and review quality

1. Preserve git diff order or explicitly label reordered hunks.
2. Fix search-context match counting.
3. Improve test/log compaction to preserve workspace frames and final failure context.
4. Add compactor fixture tests.

### P3 — Maintainability and configuration cleanup

1. Fix `tsconfig.json` include pattern.
2. Clarify HTTP token/query-token tradeoffs in docs.
3. Reframe `review_minimality` as heuristic unless deeper checks are added.
4. Add focused documentation for output modes, retrieval, and review workflow.

## 5. Detailed issue plan

## Issue 1 — Output mode bypasses per-kind compaction flags

### Observed behavior

`config.ts` exposes per-kind flags such as:

```text
LEAST_COMPACT_SEARCH
LEAST_COMPACT_GIT_DIFF
LEAST_COMPACT_SHELL
```

However, `outputShaper.ts` appears to compact large outputs whenever `outputMode` is `compact` or `compressed`, before the kind-specific flags meaningfully control behavior.

Because `LEAST_OUTPUT_MODE` defaults to `compact`, per-kind flags can be effectively bypassed.

### Why this matters

This makes rollout control unreliable. An operator may believe search, shell, or git diff compaction is disabled, but large outputs can still be compacted because global mode is set to `compact`.

It also conflicts with the intended conservative rollout:

- compact known noisy tools by default,
- store omitted raw output when compacting,
- keep memory and broad compaction off until stable.

### Target behavior

Recommended semantics:

```text
LEAST_OUTPUT_MODE=raw
  Return raw output except existing hard caps/truncation.

LEAST_OUTPUT_MODE=compact
  Compact only known noisy kinds whose per-kind flag is enabled.

LEAST_OUTPUT_MODE=compressed
  Force compaction attempt for all eligible large outputs.
```

Alternative clearer names:

```text
raw
compact_known
compact_all
```

If renaming is too disruptive, preserve existing names but document them precisely.

### Implementation steps

1. Open `src/outputShaper.ts`.
2. Locate `shouldCompact()` or equivalent decision function.
3. Change logic to check global mode first, then per-kind flag.
4. Make `compressed` the only mode that bypasses per-kind flags.
5. Ensure unknown output kinds under `compact` do not compact unless explicitly enabled.
6. Ensure `raw` disables compaction even if per-kind flags are true.
7. Update `server_config` output if it reports output settings.
8. Update docs/comments to explain exact behavior.

### Suggested decision shape

```ts
function shouldCompact(config: LeastConfig, kind: OutputKind, rawBytes: number): boolean {
  if (rawBytes < config.outputCompactThresholdBytes) return false;

  switch (config.outputMode) {
    case "raw":
      return false;
    case "compressed":
      return true;
    case "compact":
      return compactionEnabledForKind(config, kind);
    default:
      return false;
  }
}
```

### Regression tests

Add tests that cover:

1. `outputMode=raw` never compacts large search output.
2. `outputMode=compact` compacts search only when `compactSearch=true`.
3. `outputMode=compact` does not compact unknown text kind by default.
4. `outputMode=compressed` compacts eligible large text regardless of per-kind flag.
5. `outputMode=compact` plus `LEAST_COMPACT_SEARCH=0` returns raw search output.

### Acceptance criteria

- Per-kind flags work under default compact mode.
- The default behavior matches documented rollout policy.
- Existing build and smoke tests pass.
- New unit tests fail before the fix and pass after it.

## Issue 2 — Range reads can reject large files before returning small ranges

### Observed behavior

The range-read implementation mostly returns a bounded line range, but the read path still performs a full-file text-size guard before deciding whether to stream the requested range.

Conceptual current behavior:

```ts
assertTextFile(absPath, maxBytes);
if (rangeRequested) {
  streamLineRange(absPath, startLine, endLine);
}
```

### Why this matters

A user or agent may request a tiny line range from a large readable file. The operation can fail because the full file exceeds `maxReadBytes`, even though the returned content would be small.

This affects:

- large logs,
- generated but text-readable files,
- long snapshots,
- bundled source maps,
- large Markdown or JSON files,
- vendor files where only a small region is needed.

### Target behavior

Line-range reads should be limited by returned bytes, not full file bytes.

Whole-file reads should continue to enforce full-file size caps.

### Implementation steps

1. Open `src/fsOps.ts`.
2. Locate `readTextFile()` and `readManyTextFiles()` if they share helper logic.
3. Determine whether `start_line` or `end_line` was requested.
4. If a line range is requested:
   - resolve path normally,
   - block binary files using a small sample check rather than full-file read,
   - stream line range,
   - enforce returned byte budget,
   - report file total bytes separately from returned bytes where available.
5. If no line range is requested:
   - retain the existing full-file `assertTextFile()` behavior.
6. Ensure `read_many` applies the same principle per file.
7. Update structured output fields so `fileBytes`, `returnedBytes`, and `truncated` are unambiguous.

### Suggested helper split

```ts
assertReadableTextFileForWholeRead(absPath, maxBytes)
assertReadableTextFileForRangeRead(absPath)
readLineRangeWithByteBudget(absPath, startLine, endLine, maxReturnedBytes)
```

### Regression tests

Create a temporary text file larger than `maxReadBytes`, then assert:

1. Whole-file read fails or truncates according to current policy.
2. `read(path, start_line=10, end_line=20)` succeeds.
3. Returned bytes are less than or equal to requested budget.
4. Binary-like large files are still rejected for range reads.
5. `read_many` can read a bounded range from a large file without reading the whole file into memory.

### Acceptance criteria

- Small line ranges from large text files work.
- Whole-file safety caps remain intact.
- Binary files remain blocked.
- Returned-byte accounting is correct.

## Issue 3 — Review flows can miss files inside untracked directories

### Observed behavior

Git status can report untracked directories compactly:

```text
?? plan/
?? src/newFeature/
```

Review tools that parse porcelain entries may treat those as changed paths but not expand them to contained files. If the path is a directory, `read_changed_files` may skip it because it is not a normal file.

### Why this matters

This can make a large new feature appear as one untracked directory entry instead of many reviewable files.

A review workflow should not silently ignore source files just because Git summarized the parent directory.

### Target behavior

Review tools should see individual files inside untracked directories.

Preferred approach:

```bash
git status --porcelain=v1 -uall
```

This asks Git to report all untracked files, not just untracked directory summaries.

### Implementation steps

1. Open `src/gitOps.ts` and `src/reviewOps.ts`.
2. Locate the status command used by `gitStatus()`.
3. For review-related status calls, use `--porcelain=v1 -uall`.
4. If a global change to `gitStatus()` is too risky, add an option:

```ts
gitStatus(config, workspace, guard, path, { untrackedMode: "all" })
```

5. Update `show_changes`, `diff_summary`, and `read_changed_files` to use full untracked expansion.
6. If Git still returns a directory entry, expand it through guarded filesystem traversal and apply existing ignore/generated/lockfile filters.

### Regression tests

Create a temporary Git repo test fixture with:

```text
newdir/a.ts
newdir/b.ts
newdir/nested/c.ts
```

Assert:

1. `diff_summary` reports individual files or a directory plus expanded files.
2. `read_changed_files` reads the eligible files inside the untracked directory.
3. `show_changes` untracked summary includes enough detail to know what is inside the directory.
4. Blocked directories and ignored files remain excluded.

### Acceptance criteria

- Untracked directories no longer hide contained reviewable files.
- Review tools remain bounded by `max_files` and `max_bytes`.
- Existing filters for generated, binary, lockfile, and blocked paths still apply.

## Issue 4 — `multi_edit` stale SHA lookup is path-string sensitive

### Observed behavior

`multi_edit` supports an `expected_sha256s` map keyed by path. The lookup uses the raw path string from the edit request.

Conceptual current behavior:

```ts
const filePath = String(edit.path ?? "");
const expected = expectedShaMap[filePath];
const resolved = guard.resolve(workspace, filePath, { forWrite: true });
```

If the caller read `src/foo.ts` but edits `./src/foo.ts`, the map lookup can miss the expected SHA even though both refer to the same file.

### Why this matters

The stale-write protection should apply based on the normalized workspace-relative path, not user spelling.

### Target behavior

For every edit item:

1. Resolve the path.
2. Normalize it to `resolved.relPath`.
3. Look up expected SHA by both raw and normalized path.
4. Prefer normalized path in results.

### Implementation steps

1. Open `src/server.ts` around the `multi_edit` handler.
2. Resolve `filePath` before reading `expectedShaMap`.
3. Look up:

```ts
const expected = expectedShaMap[filePath] ?? expectedShaMap[resolved.relPath];
```

4. Consider normalizing the entire map once:

```ts
const normalizedExpectedShaMap = normalizeExpectedShaMap(expectedShaMap, guard, workspace);
```

5. Ensure error output reports the normalized path.

### Regression tests

1. Read `src/foo.ts`, capture SHA.
2. Call `multi_edit` with `path: "./src/foo.ts"` and map key `src/foo.ts`.
3. Assert stale guard is applied.
4. Modify the file between read and edit.
5. Assert edit fails with `stale_file_state`.

### Acceptance criteria

- Stale SHA checks are path-normalization safe.
- Existing exact path map behavior still works.
- Error messages remain actionable.

## Issue 5 — Child process spawn errors can double-settle

### Observed behavior

In `src/processRunner.ts`, `child.on("error")` rejects but does not mark the operation settled. A later `close` event can call `finalize()` and attempt to resolve.

Affected functions:

```text
streamProcessLines()
runCappedProcess()
```

### Why this matters

Double-settle is usually masked by Promise behavior, but it can lead to confusing metrics, cleanup behavior, or hard-to-debug test flakes.

### Target behavior

Every process runner should settle exactly once.

### Implementation steps

1. Open `src/processRunner.ts`.
2. Add a shared cleanup helper per function.
3. In `error` handlers:

```ts
if (settled) return;
settled = true;
cleanup();
reject(error);
```

4. In `finalize()`, keep the existing `if (settled) return` guard.
5. Ensure abort listeners are removed in both success and error paths.
6. Consider killing the child process only when it exists and is not already closed.

### Regression tests

1. Attempt to run a definitely missing executable.
2. Assert Promise rejects exactly once.
3. Assert child process timing is recorded once.
4. Assert no unhandled rejection is emitted.

### Acceptance criteria

- Spawn error path is deterministic.
- Metrics are not double recorded.
- No unhandled rejection or warning is produced.

## Issue 6 — Timeout metrics can be recorded twice

### Observed behavior

`withTimeout()` records timeout in the soft abort timer and again in the hard-stop timer if the operation ignores abort.

Conceptual current behavior:

```ts
softTimer: recordTimedOut(); controller.abort(error);
hardTimer: recordTimedOut(); reject(error);
```

### Why this matters

`least_perf`, `least_gain`, and `least_discover` should be trusted. Double-counted timeouts reduce diagnostic value.

### Target behavior

One logical timeout should increment timeout metrics once.

### Implementation steps

1. Open `src/timeout.ts`.
2. Add a local boolean:

```ts
let recordedTimeout = false;
function recordTimeoutOnce() {
  if (recordedTimeout) return;
  recordedTimeout = true;
  recordTimedOut();
}
```

3. Use it in both soft and hard timers.
4. Verify process-level timeout metrics in `processRunner.ts` do not also double count the same timeout. If they do, define clear ownership:
   - `withTimeout` records tool-level timeout,
   - process runner records child-process partial/timed-out result only if it returns normally.

### Regression tests

1. Create a tool operation that ignores abort and exceeds hard stop.
2. Assert timeout count increments by one.
3. Create a tool operation that respects abort.
4. Assert timeout count still increments by one.

### Acceptance criteria

- Timeout metrics are stable and not double counted.
- Existing timeout behavior remains user-visible and fast.

## Issue 7 — Output-store path containment should use relative-path validation

### Observed behavior

The output store validates retrieval keys and uses a prefix-based path check.

Prefix checks can be fragile because paths such as `/repo2` start with `/repo` as strings.

Current exploitability appears low because keys are validated as SHA-like values, but the guard should still be robust.

### Target behavior

Use `path.relative()` containment checks rather than string prefix checks.

### Implementation steps

1. Open `src/toolOutputStore.ts`.
2. Replace prefix-style containment checks with:

```ts
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
```

3. Resolve real paths where appropriate.
4. Keep key validation strict.
5. Keep retrieval scoped to the same workspace id.

### Regression tests

1. Valid SHA key retrieves expected output.
2. Invalid key formats are rejected.
3. Path traversal attempts are rejected.
4. Workspace id mismatch does not retrieve output from another workspace.

### Acceptance criteria

- Retrieval remains read-only and workspace-scoped.
- Path containment is robust by construction.

## Issue 8 — Git diff compactor reorders hunks

### Observed behavior

`compactGitDiff()` scores and sorts kept hunks by signal.

This can reorder the patch body relative to Git's original diff order.

### Why this matters

For review, original order is useful. Reordering can confuse patch application reasoning and make it harder to compare with `git diff`.

### Target behavior

Choose one of these options:

1. Preserve original diff order in the main patch body.
2. Keep a separate ranked summary at the top, but keep hunks in original order.
3. If reordering remains, explicitly label the output as reordered.

Recommended option: preserve original patch order.

### Implementation steps

1. Open `src/outputCompactors/gitDiffCompactor.ts`.
2. Keep `fileSummaries` as-is.
3. Replace sorted hunk output with original `keptHunks` order.
4. Optionally add a high-signal summary section before the patch body:

```text
High-signal files:
- package.json
- src/server.ts
```

5. Ensure lockfile summaries still reduce noise.

### Regression tests

1. Create a multi-file diff fixture.
2. Compact it.
3. Assert file order in compacted patch body matches original diff order.
4. Assert lockfile hunks are summarized when large.
5. Assert binary file notices are preserved.

### Acceptance criteria

- Review output remains compact but does not misrepresent patch order.
- Diff stats and file paths are preserved.

## Issue 9 — Search compactor can inflate match counts

### Observed behavior

The search compactor parses context output. It appears to count the `### file:line` header as a match and then count the actual matched context line again.

### Why this matters

Inflated match counts reduce trust in compacted search output and can mislead ranking or summaries.

### Target behavior

A match should be counted exactly once.

### Implementation steps

1. Open `src/outputCompactors/searchCompactor.ts`.
2. For context headers, create/open the group but do not increment `matchCount`.
3. Increment only on actual match lines or simple `path:line:text` records.
4. Ensure range headers remain context snippets, not matches.

### Regression tests

Create fixture input:

```text
### src/a.ts:10
8- before
10: target
11- after
---
```

Assert:

```text
totalMatches === 1
file matchCount === 1
```

Also test multiple context blocks for the same file.

### Acceptance criteria

- Match counts are correct for plain ripgrep output and context output.
- File grouping remains useful.

## Issue 10 — `tsconfig.json` include pattern is misleading

### Observed behavior

`tsconfig.json` uses:

```json
"include": ["src*.ts"]
```

The build passes because TypeScript follows imports from included entrypoints, but this include pattern is surprising and may miss standalone source files not imported by the entrypoint.

### Target behavior

Use an explicit source tree include:

```json
"include": ["src/**/*.ts"]
```

If scripts or root-level TypeScript files are intentionally included, add them explicitly:

```json
"include": ["src/**/*.ts", "scripts/**/*.ts"]
```

### Implementation steps

1. Open `tsconfig.json`.
2. Replace include pattern with `src/**/*.ts`.
3. Run build.
4. Fix any newly discovered type errors in previously excluded files.

### Regression tests

Build itself is the test:

```bash
npm run build
```

Optional: add a smoke assertion that all expected source files are part of the TypeScript program, but this may be overkill.

### Acceptance criteria

- TypeScript includes all source files intentionally.
- Build remains clean.

## Issue 11 — HTTP query-token auth should be clearly documented

### Observed behavior

The onboarding flow supports token-in-query URLs such as:

```text
/mcp?least_token=...
```

This may be required for convenient ChatGPT setup, but query tokens can appear in browser history, reverse-proxy logs, screenshots, or terminal copy/paste artifacts.

### Target behavior

Keep query-token support if required, but document the risk and recommend Bearer auth where available.

### Implementation steps

1. Update README or local setup docs.
2. Add a short warning near any copied URL instructions:

```text
The copied URL contains a private local token. Treat it like a password. Prefer Bearer auth in clients that support it.
```

3. Ensure onboarding page does not print the token directly. Current behavior already avoids printing it.
4. Avoid logging full request URLs server-side if not already avoided.

### Tests

Manual check:

1. Start HTTP server.
2. Open onboarding page.
3. Confirm token is not printed in HTML body.
4. Confirm MCP route works with token.
5. Confirm route rejects missing/incorrect token.

### Acceptance criteria

- Users are warned clearly.
- Token remains accepted where required.
- Token is not printed unnecessarily.

## Issue 12 — `review_minimality` should be framed as heuristic

### Observed behavior

`src/minimalityOps.ts` currently checks simple patterns:

- dependency names that may have native alternatives,
- large files with functions,
- mixed shell/file complexity.

This is useful but shallow.

### Target behavior

Either:

1. Clearly label the tool as heuristic, or
2. Expand it to check actual duplication, existing helpers, and available Node APIs more precisely.

Recommended near-term fix: label it as heuristic and avoid overconfident wording.

### Implementation steps

1. Update tool description in `src/server.ts`.
2. Update output heading:

```text
Heuristic minimality review
```

3. Add documentation caveat:

```text
Findings are prompts for human/agent review, not mandatory removals.
```

4. Keep the rule that validation, error handling, security, accessibility, and tests must not be removed for minimality.

### Future enhancement ideas

- Search for existing helpers with similar names before flagging new helpers.
- Detect newly added dependency from diff, not just current package.json.
- Compare new code against existing imports and utility modules.
- Add allowlist comments for intentional abstraction.

### Acceptance criteria

- Tool output does not overstate confidence.
- Existing useful heuristic behavior remains.

## 6. Test strategy

Add or extend a dedicated script such as:

```bash
node scripts/output-shaper-unit.mjs
```

or add new smoke sections in:

```bash
node scripts/smoke.mjs
```

Recommended test groups:

### Output mode tests

- raw mode disables compaction.
- compact mode respects per-kind flags.
- compressed mode compacts broadly.
- retrieval key is only produced when output is compacted/truncated and stored.

### Range read tests

- whole-file read blocks large file.
- range read succeeds for large text file.
- range read blocks binary file.
- returned byte accounting is correct.

### Review flow tests

- untracked directory expands to files.
- generated and lockfile filters still work.
- `show_changes` summarizes untracked files clearly.
- `read_changed_files` reads bounded eligible files.

### Process runner tests

- missing executable rejects once.
- timeout records once.
- truncated process output preserves partial marker.
- stderr and stdout budget handling remains correct.

### Compactor tests

- search context match counts are exact.
- diff order is preserved.
- lockfile hunks are summarized.
- failed test logs preserve failing test names, expected/received snippets, and final summary.

## 7. Suggested implementation phases

## Phase 1 — Fix release-blocking semantics

Files likely touched:

```text
src/outputShaper.ts
src/config.ts
src/fsOps.ts
src/gitOps.ts
src/reviewOps.ts
src/server.ts
scripts/smoke.mjs or scripts/output-shaper-unit.mjs
```

Tasks:

1. Fix output-mode semantics.
2. Fix range-read behavior.
3. Fix untracked-directory expansion.
4. Add regression coverage.
5. Run:

```bash
npm run build
npm run smoke
```

Expected result:

- Main correctness blockers removed.
- Default behavior aligns with the existing research plan.

## Phase 2 — Reliability hardening

Files likely touched:

```text
src/server.ts
src/processRunner.ts
src/timeout.ts
src/toolOutputStore.ts
scripts/smoke.mjs
```

Tasks:

1. Normalize `multi_edit` expected SHA lookup.
2. Fix process runner double-settle.
3. Fix timeout double-counting.
4. Harden output-store containment.
5. Add targeted tests.
6. Run build and smoke.

Expected result:

- Fewer concurrency and diagnostics edge cases.
- More trustworthy metrics.

## Phase 3 — Compactor quality

Files likely touched:

```text
src/outputCompactors/gitDiffCompactor.ts
src/outputCompactors/searchCompactor.ts
src/outputCompactors/testLogCompactor.ts
scripts/output-shaper-unit.mjs
```

Tasks:

1. Preserve diff order.
2. Fix search match counting.
3. Improve test-log preservation where needed.
4. Add fixture tests.
5. Run build, smoke, and any output-shaper unit script.

Expected result:

- Compact output becomes safer to use in review and debugging.

## Phase 4 — Config and docs cleanup

Files likely touched:

```text
tsconfig.json
README.md
docs/* if present
src/server.ts
src/minimalityOps.ts
```

Tasks:

1. Fix TypeScript include pattern.
2. Document output modes and retrieval behavior.
3. Document query-token tradeoff.
4. Reword minimality review as heuristic.
5. Run build and smoke.

Expected result:

- Cleaner developer onboarding.
- Fewer hidden assumptions.

## 8. Acceptance criteria for the full plan

The plan is complete when all of the following are true:

1. `LEAST_OUTPUT_MODE=compact` respects per-kind compaction flags.
2. `LEAST_OUTPUT_MODE=raw` disables compaction.
3. `LEAST_OUTPUT_MODE=compressed` intentionally compacts broadly.
4. Small line-range reads work on large text files.
5. Whole-file reads still enforce size limits.
6. Binary files remain blocked.
7. Review tools expand or otherwise reveal files inside untracked directories.
8. `multi_edit` stale SHA checks work with normalized and raw path spellings.
9. Child process spawn errors settle exactly once.
10. Timeout metrics count one timeout once.
11. Output-store retrieval uses robust containment checks.
12. Git diff compaction does not silently reorder hunks, or labels reordering clearly.
13. Search compaction reports accurate match counts.
14. `tsconfig.json` includes all intended source files.
15. Query-token auth tradeoff is documented.
16. Minimality review is framed as heuristic unless made deeper.
17. `npm run build` passes.
18. `npm run smoke` passes.
19. Regression tests exist for the P0 issues.
20. No new dependencies are added without a written justification.

## 9. Recommended first pull request

Title:

```text
Fix compact-output semantics and large-file range reads
```

Contents:

1. Fix `outputShaper` decision logic so `compact` respects per-kind flags.
2. Add tests for raw, compact, and compressed output modes.
3. Fix `readTextFile` range-read behavior for large text files.
4. Add tests for line ranges from large files.
5. Update docs/comments for output mode semantics.
6. Run build and smoke.

Do not include unrelated cleanup in this PR. Keep it focused because it changes user-visible behavior.

## 10. Recommended second pull request

Title:

```text
Improve review completeness for untracked directories
```

Contents:

1. Use `git status --porcelain=v1 -uall` for review status paths or add an equivalent option.
2. Expand untracked directories if Git still returns directory summaries.
3. Update `show_changes`, `diff_summary`, and `read_changed_files` behavior.
4. Add tests with nested untracked directories.
5. Run build and smoke.

## 11. Recommended third pull request

Title:

```text
Harden mutation, timeout, and output retrieval edge cases
```

Contents:

1. Normalize `multi_edit` expected SHA path lookup.
2. Fix process runner spawn-error double-settle.
3. Prevent double timeout metric recording.
4. Harden output-store path containment.
5. Add targeted regression tests.
6. Run build and smoke.

## 12. Recommended fourth pull request

Title:

```text
Make compacted review output more faithful
```

Contents:

1. Preserve git diff order in compacted diff output.
2. Fix search-context match counting.
3. Improve test-log compaction fixture coverage.
4. Update output-shaper tests.
5. Run build and smoke.

## 13. Notes for future maintainers

This project should remain a local development bridge, not a provider proxy or autonomous shell wrapper. The most valuable improvements are at the MCP/tool boundary:

- better selection of context,
- smaller but reversible tool outputs,
- safer file mutation workflows,
- clearer review output,
- reliable local performance diagnostics.

Do not optimize only for fewer bytes. Optimize for fewer bytes while preserving the information an agent needs to decide what happened, where it happened, whether it failed, what to inspect next, and how to retrieve omitted detail.
