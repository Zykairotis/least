# Prompt Contracts

Local agent prompts must be explicit, bounded, and auditable.

## Required prompt sections

- Task: one sentence outcome.
- Repository/context: repo name, relevant paths, branch/worktree expectations.
- Scope: what may be changed and what is out of scope.
- Constraints: style, compatibility, no deployment, no secret exposure.
- Verification: commands/checks the agent should run or explain if not run.
- Output contract: changed files, summary, tests, risks, follow-ups.

## Prompt rules

- Prefer prompt files or structured tool arguments over inline shell text.
- Do not include secrets, tokens, private keys, or credential dumps.
- Tell the agent to inspect repo instructions before editing.
- Tell the agent to make the smallest useful change.
- Tell the agent not to merge/apply changes back to the main tree.
- Tell the agent to preserve user changes and report conflicts.

## Verification language

Require one of:

```text
Run the relevant tests/checks and include exact commands plus results.
```

or:

```text
If verification cannot be run, explain why and provide a static reasoning fallback.
```

## Output contract

Ask the agent to end with:

```text
Summary:
Files changed:
Verification:
Risks:
Follow-ups:
```
