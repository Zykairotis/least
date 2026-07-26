# Least Workflows

Least workflows expose a small orchestration surface for larger local tasks.

The first public tool is:

```text
workflow
```

It supports:

- `plan`
- `run`
- `resume`
- `status`
- `cancel`

Workflows are designed to keep the public tool list small while internal steps can use allowlisted capabilities, helper scripts, and selected local MCP tools.

## Safety Defaults

- dry-run by default
- bounded `max_steps`
- persisted run state under `.ai-bridge/workflows`
- workflow id allowlist
- confirmation gates for bulk/live side effects

## Structured tools first (local-dev)

For common workflows outside named orchestration, models should prefer structured tools over raw bash:

- HTTP/API: `local_http_json` or `api_smoke_suite`
- Docker: `docker_compose_*`
- Tests: `run_vitest` or `run_package_script`
- Files: `read` / `read_many` / `write` / `edit`
- Git review: `show_changes` / `git_status`

Raw bash is fallback-only. `--yolo` does not override platform-side blocks of raw command payloads.

## Current Pilot

`video-study` plans bounded video-study work for Video RAG, Obsidian, Anki, and selected optimized images. Phase 1 is a dry-run/control-flow implementation; live adapters are added after the workflow shell is stable.

