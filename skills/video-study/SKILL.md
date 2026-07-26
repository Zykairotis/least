---
name: video-study
description: Use Least's workflow tool to plan, run, resume, and verify video-study workflows with Video RAG, Obsidian, Anki, selected optimized images, and optional Todoist tasks.
---

# Video Study

Use this skill when the user wants to study a video/course folder, create Obsidian notes, make Anki cards, use timestamp images, or resume a previous video-study run.

## Core Rule

Use the Least `workflow` tool. Do not call raw local MCP servers or arbitrary shell commands directly for the workflow.

## Default Tool Call

```json
{
  "action": "plan",
  "workflow_id": "video-study",
  "dry_run": true,
  "max_steps": 3,
  "input": {
    "source": "PATH_OR_URL",
    "project": "default",
    "mode": "time-window",
    "window_scope": "0-30",
    "outputs": ["obsidian", "anki", "images"]
  }
}
```

## Procedure

1. Start with `workflow action=plan`.
2. Confirm scope before live/bulk side effects.
3. Use `run` only with bounded `max_steps`.
4. Use `resume` with `run_id` to continue.
5. Use `status` with `run_id` to inspect progress.

## Guardrails

- DB check first; do not ingest before checking indexed status.
- Long videos use 10-minute windows.
- Select only useful timestamp images.
- Optimize/crop image copies before using them in notes/cards.
- Search existing Anki cards first and skip duplicates.
- Pause before more than 50 new cards or whole-course deep batches.
- Todoist is off unless explicitly requested.

## References

- `references/workflow-contract.md`
- `references/anki-rules.md`
- `references/image-selection.md`

