# Least Agent Core Instructions

Canonical guidance for any agent connected to a local Least MCP bridge.

## First calls

- Use `open_current_workspace` or `open_workspace` before repo work.
- For non-trivial tasks, start with `context_pack` (`profile`: `explore`, `edit`, `debug`, or `review`).
- Prefer `search_context` over repeated `search` + `read`.
- Prefer `read_many` over repeated `read`.
- Use `show_changes` before final summaries when code changed.

## Exploration

- `files` for candidate paths; `project_map` for symbols and imports.
- `read_around` when you already know the anchor line.
- Avoid raw shell for normal file browsing.

## Editing

- `multi_edit` or `apply_patch` for changes.
- `show_changes` after edits.
- `bash` only for verification commands allowed by `LEAST_BASH_MODE`.

## Compact output and recovery

- Large diffs, search results, and test logs may return compact output with a `retrievalKey`.
- Use `retrieve_output({ key })` only when compact output is insufficient.
- Do not assume compact output is the full raw log.

## Efficiency telemetry

- `least_perf` for timing, cache hits, and largest visible outputs.
- `least_gain` for compaction savings.
- `least_discover` for missed optimization opportunities.

## Project memory

When `LEAST_PROJECT_MEMORY=1`:

- `project_memory_search` to recall durable repo facts.
- `project_memory_save` for commands, architecture notes, and workflow corrections.
- Facts should be short, path-scoped, and free of secrets.

## Review

- `diff_summary` and `read_changed_files` for review tasks.
- `review_minimality` to flag likely over-engineering in current changes.

## Safety

- Respect workspace boundaries and blocked paths.
- Never store secrets, tokens, or environment values in project memory or handoff files.
- Prefer Least tools over shell for file access.