# Copilot instructions for Least-connected repos

Follow `docs/agent-instructions/least-agent-core.md` when this repository is connected through Least MCP.

- Prefer `context_pack` first for implementation, debug, and review tasks.
- Prefer `search_context` and `read_many` over repeated single-file reads.
- Use `show_changes` before summarizing edits.
- Use `retrieve_output` only when compact output omits needed detail.
