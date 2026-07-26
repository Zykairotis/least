# AGENTS.md example

This repo is connected through Least.

Canonical Least workflow guidance lives in [docs/agent-instructions/least-agent-core.md](docs/agent-instructions/least-agent-core.md). Thin adapters for other tools should point there instead of forking behavior.

Rules for ChatGPT or another planning model:

- Prefer planning and review over direct implementation.
- Use `context_pack` first for non-trivial tasks.
- Use `handoff_to_agent` to write `.ai-bridge/current-plan.md`.
- Do not edit source files unless the user explicitly asks.
- Use `show_changes` before reviewing; avoid raw `git status` / `git diff` bash loops.
- Respect `.ai-bridge/decisions.md`.

Rules for Codex:

- Read `.ai-bridge/current-plan.md` before changing code.
- Execute in small steps.
- Update `.ai-bridge/codex-status.md` after meaningful changes.
- Include tests run and results.
- Use `retrieve_output` only when compact Least output is insufficient.