# Workflow Contract

Use the Least `workflow` tool with these fields:

```jsonc
{
  "action": "plan | run | resume | status | cancel",
  "workflow_id": "video-study",
  "run_id": "optional-existing-run-id",
  "dry_run": true,
  "max_steps": 3,
  "confirm": false,
  "input": {}
}
```

Default to `dry_run=true` for planning. Use live runs only after scope is clear.

Useful input fields:

- `source`: URL, file, or folder.
- `project`: Video RAG project, usually `default`.
- `course`, `module`, `lesson`: optional scoping hints.
- `mode`: `single-lesson`, `time-window`, `study-batch`, or `overview-batch`.
- `window_scope`: `0-30`, `30-60`, or comma-separated windows.
- `outputs`: `obsidian`, `anki`, `images`, optional `todoist`.

