import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@clipboard-health/groundcrew";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(repoRoot).replace(/\\/g, "/");
const worktreeDir = path.join(repoRoot, ".ai-bridge", "groundcrew-worktrees").replace(/\\/g, "/");
const wslDistro = process.env.LEAST_WSL_DISTRO ?? "Arch";
const ompWrapperPath = path.join(repoRoot, "scripts", "least-omp-headless.cmd");

export default {
  sources: [{ kind: "linear", enabled: false }],
  workspace: {
    projectDir,
    worktreeDir,
    knownRepositories: ["least", "Zk-Tz"],
  },
  workspaceKind: "zellij",
  agents: {
    default: "grok-build",
    definitions: {
      "grok-build": {
        cmd: "cmd.exe /c scripts\\least-grok-headless.cmd",
        color: "#f97316",
      },
      "codex-host": {
        cmd: "codex exec --json --sandbox workspace-write",
        color: "#10b981",
        resumeArgs: "resume --last",
      },
      "codex-wsl": {
        cmd: `wsl.exe -d ${wslDistro} bash -lc 'cd "$(wslpath -a "$1")" && codex exec --json --sandbox workspace-write "$2"' bash {{worktree}}`,
        color: "#06b6d4",
        resumeArgs: "resume --last",
      },
      "oh-my-pi": {
        cmd: `cmd.exe /c "${ompWrapperPath}"`,
        color: "#a855f7",
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
