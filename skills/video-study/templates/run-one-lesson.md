# Run One Lesson

```jsonc
{
  "action": "run",
  "workflow_id": "video-study",
  "dry_run": false,
  "max_steps": 3,
  "confirm": true,
  "input": {
    "source": "<folder-or-file>",
    "project": "default",
    "course": "<course>",
    "module": "<module>",
    "lesson": "<lesson>",
    "mode": "time-window",
    "window_scope": "0-30",
    "outputs": ["obsidian", "anki", "images"]
  }
}
```

