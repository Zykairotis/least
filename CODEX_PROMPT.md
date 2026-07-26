Read .ai-bridge/current-plan.md and execute it in small, reviewable steps.

When creating or fully replacing multiple files, prefer Least `write_many` (or one multi-file patch) over many single-file writes. Prefer `response_mode=summary` during implementation and call `show_changes` once after a mutation batch. Use `multi_edit` for exact in-place edits and `apply_patch` for patch-form changes.

After each meaningful change, update .ai-bridge/codex-status.md with:

- what changed
- files touched
- tests, lint, or typecheck commands run
- results
- blockers or questions
- what ChatGPT or another reviewer should review next

Keep .ai-bridge/decisions.md aligned with implementation choices. Do not overwrite .ai-bridge/current-plan.md unless explicitly asked.
