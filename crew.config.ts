import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@clipboard-health/groundcrew";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(repoRoot).replace(/\\/g, "/");
const worktreeDir = path.join(repoRoot, ".ai-bridge", "groundcrew-worktrees").replace(/\\/g, "/");

export default {
  sources: [{ kind: "linear", enabled: false }],
  workspace: {
    projectDir,
    worktreeDir,
    knownRepositories: ["least", "Zk-Tz"],
  },
  workspaceKind: "tmux",
  agents: {
    default: "codex",
    definitions: {
      codex: {
        cmd: "codex --yolo",
        color: "#10b981",
      },
      "piv-build": {
        cmd: "piv --piv-mode build --piv-allow-bash",
        color: "#a855f7",
      },
      "claude-code": {
        cmd: "claude",
        color: "#f59e0b",
      },
      "grok-build": {
        cmd: "agent --yolo",
        color: "#f97316",
      },
    },
  },
  local: {
    runner: "none",
  },
  defaults: {
    hooks: {
      prepareWorktree: "true",
    },
  },
} satisfies Config;
