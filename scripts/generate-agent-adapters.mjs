import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRel = "docs/agent-instructions/least-agent-core.md";
const canonicalPath = path.join(repoRoot, canonicalRel);

const adapters = [
  {
    path: ".cursor/rules/least.mdc",
    content: `---
description: Least MCP workflow guidance for Cursor agents
globs:
alwaysApply: false
---

Follow the canonical Least agent instructions in \`${canonicalRel}\`.

Highlights:

- Start with \`context_pack\` for non-trivial repo tasks.
- Prefer \`search_context\`, \`read_many\`, and \`show_changes\` over shell browsing.
- Use \`retrieve_output\` only when compact tool output is insufficient.
- Use \`least_perf\`, \`least_gain\`, and \`least_discover\` when tuning Least itself.
`
  },
  {
    path: ".github/copilot-instructions.md",
    content: `# Copilot instructions for Least-connected repos

Follow \`${canonicalRel}\` when this repository is connected through Least MCP.

- Prefer \`context_pack\` first for implementation, debug, and review tasks.
- Prefer \`search_context\` and \`read_many\` over repeated single-file reads.
- Use \`show_changes\` before summarizing edits.
- Use \`retrieve_output\` only when compact output omits needed detail.
`
  },
  {
    path: ".windsurf/rules/least.md",
    content: `Follow \`${canonicalRel}\` for Least MCP workflows in this repository.
`
  },
  {
    path: ".clinerules/least.md",
    content: `Follow \`${canonicalRel}\` for Least MCP workflows in this repository.
`
  }
];

await fs.access(canonicalPath);
for (const adapter of adapters) {
  const target = path.join(repoRoot, adapter.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, adapter.content, "utf8");
  console.log(`wrote ${adapter.path}`);
}

console.log("generate-agent-adapters: ok");