# Implementation Prompt Template

Task: {{task}}

Repository/context:
{{repository_context}}

Scope:
- Change only files needed for the task.
- Keep work inside the assigned worktree.
- Preserve existing user changes.
- Do not deploy, publish, release, rotate secrets, or edit production state.

Instructions:
1. Inspect repository instructions and relevant files before editing.
2. Make the smallest correct implementation.
3. Add or update tests only when directly useful.
4. Run relevant verification commands. If unable, explain why.
5. Do not merge, rebase, or apply changes outside the worktree.

Output contract:

```text
Summary:
Files changed:
Verification:
Risks:
Follow-ups:
```
