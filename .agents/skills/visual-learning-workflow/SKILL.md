---
name: visual-learning-workflow
description: Visual learning workflow for studying videos/courses with Video RAG, Obsidian notes, Anki cards, selected optimized images, and optional Todoist tasks. Use for long video study, folder-based courses, timestamped image cards, and resumable learning batches.
---

# Visual Learning Workflow

Use this skill when the user wants to learn from a video, YouTube URL, local video file, or course folder and produce study artifacts.

Primary outputs:

- Video RAG queryability/checks.
- Obsidian notes with summaries, timestamps, Mermaid maps, images, and progress state.
- Anki cards with duplicate checks and useful visual cards.
- Optimized/cropped timestamp images when they help learning.
- Optional Todoist review task when explicitly requested.

## First Principle

This is a skill-level workflow. Do not expose or use a huge raw tool surface just because tools exist.

Prefer this order:

1. Use Least `workflow` if available.
2. If `workflow` is not available, use the smallest safe set of available Least tools and helper scripts.
3. Do not call arbitrary shell commands for side effects unless the user explicitly asks and Least policy allows it.

## Golden Procedure

Follow this order every time.

1. Identify scope: URL, local video, lesson, folder, time range, or resume run.
2. Check whether the source is already indexed/queryable before ingesting.
3. Report indexed/missing/ambiguous status before doing side effects.
4. Choose mode:
   - `single-lesson`: one short video/lesson.
   - `time-window`: one long video in 10-minute windows.
   - `study-batch`: multiple videos with long videos still windowed.
   - `overview-batch`: shallow pass only when the user asks for quick/overview.
5. Confirm scope before bulk work.
6. Retrieve evidence scoped to the active project/course/module/lesson.
7. For videos over 10 minutes, process windows in order: 0-10, 10-20, 20-30, etc.
8. For each window, create evidence summary, selected images, note section, and cards.
9. Search existing Anki cards first and skip duplicates.
10. Persist progress and report the next window/video to continue from.

## Least Workflow Tool Contract

When the `workflow` tool is available, call it like this first:

```jsonc
{
  "action": "plan",
  "workflow_id": "video-study",
  "dry_run": true,
  "max_steps": 3,
  "input": {
    "source": "PATH_OR_URL",
    "project": "default",
    "course": "optional course",
    "module": "optional module",
    "lesson": "optional lesson",
    "mode": "time-window",
    "window_scope": "0-30",
    "outputs": ["obsidian", "anki", "images"]
  }
}
```

Then use:

- `action=run` for bounded execution.
- `action=status` with `run_id` to inspect progress.
- `action=resume` with `run_id` to continue.
- `dry_run=true` when previewing.
- `max_steps=3` by default for long videos.
- `confirm=true` only after the user agrees to live/bulk side effects.

## Time Windows

Default for any video over 10 minutes:

- 00:00-10:00
- 10:00-20:00
- 20:00-30:00
- continue in 10-minute windows

Merge a final tail under 3 minutes into the previous window.

Per useful 10-minute window:

- sparse/simple: 2-4 Anki cards
- normal teaching: 4-8 Anki cards
- dense technical/strategy: 8-15 Anki cards
- intro/outro/admin: 0-2 Anki cards

Do not flatten a long video into 2-8 cards total unless the user explicitly requested an overview.

## Image Rules

Use images when they help memory or reasoning.

Good image candidates:

- charts
- diagrams
- footprint examples
- DOM/table views
- annotated examples
- before/after comparisons
- visual setups for scenario cards

Avoid:

- talking-head frames
- blurry frames
- repeated adjacent frames
- frames with no learning value

Default selection:

- 0-2 useful images per 10-minute window.
- More only when the visual sequence is essential.
- Optimize/crop copies before using them in Obsidian or Anki.
- Never overwrite source videos, source SRTs, or original frame files.
- Text-only cards are better than forced bad visual cards.

## Anki Rules

- Target deck must be explicit.
- Search existing cards by lesson/window before adding cards.
- Skip duplicates and report skipped count.
- Include source lesson and timestamp on every card back.
- Tag cards with workflow/course/lesson/window when possible.
- Visual cards should remain understandable even if the image fails.
- Pause before more than 50 new cards in one run unless the user explicitly confirms.

## Obsidian Rules

Create or update one note per video/lesson.

Include:

- source metadata
- summary
- timestamped evidence
- key ideas
- Mermaid map when useful
- important optimized images
- Anki card summary
- progress/resume section

Progress section shape:

```text
Processed windows:
- 00:00-10:00: note done, 6 cards, 1 image
- 10:00-20:00: note done, 8 cards, 0 images
Next: 20:00-30:00
```

Before resuming, read existing progress and continue from `Next`.

## Confirmation Gates

Ask or pause before:

- ingesting a folder
- deep-processing a whole course
- creating more than 50 cards in one run
- creating Todoist tasks in bulk
- deleting/updating existing notes/cards
- using broad/all-project searches when a scoped project should be enough

## Final Report

Always report:

- DB/index status
- run id if using Least workflow
- Obsidian note path
- Anki existing/new/skipped/final count
- optimized image count and folder
- current video/window
- next video/window to continue

Use this table for windowed work:

```text
| Video | Window | Evidence | New Cards | Skipped Duplicates | Images | Obsidian | Status |
|---|---|---:|---:|---:|---:|---|---|
```

## Example Request Normalization

If the user says “loop through this folder,” normalize to:

```text
Source: <folder>
Project: default
Mode: study-batch
Window scope: 0-30 first, then resume
Outputs: Obsidian, Anki, Images
Stop condition: pause after 3 windows or before >50 cards
Todoist: off unless requested
```

