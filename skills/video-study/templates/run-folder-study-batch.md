# Run Folder Study Batch

Use this only after the user confirms whole-folder scope.

```jsonc
{
  "action": "run",
  "workflow_id": "video-study",
  "dry_run": false,
  "max_steps": 3,
  "confirm": true,
  "input": {
    "source": "<folder>",
    "project": "default",
    "mode": "study-batch",
    "window_scope": "0-30",
    "outputs": ["obsidian", "anki", "images"]
  }
}
```

Resume with the returned `run_id`.

