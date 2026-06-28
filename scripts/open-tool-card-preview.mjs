import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toolCardWidgetHtml } from "../dist/toolCardWidget.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.slice("--scenario=".length) || "workspace";

const mocks = {
  workspace: {
    least_tool: "open_current_workspace",
    root: repoRoot,
    workspace_id: "preview-workspace-019f047a",
    agents_loaded: true,
    agents_path: "AGENTS.example.md",
    write_mode: "safe",
    bash_mode: "safe",
    shell_backend: "child_process",
    tool_mode: "full",
    toolset: "full",
    concurrency_mode: "off",
    skill_counts: { total: 6, workspace: 1, user: 4, plugin: 1, other: 0 },
    skill_inventory: [
      { name: "code", source: "user", description: "Coding workflow guidance" },
      { name: "review", source: "workspace", description: "Workspace review skill" },
      { name: "typescript-expert", source: "user", description: "TypeScript patterns" },
      { name: "context7", source: "user", description: "Library documentation lookup" },
      { name: "github", source: "user", description: "GitHub operations" },
      { name: "plugin-helper", source: "plugin", description: "Plugin cache skill" }
    ],
    git_status: "## rebrand-to-least...origin/rebrand-to-least\n M src/toolCardWidget.ts\n M scripts/smoke.mjs\n M README.md\n?? plan/ui-refresh.md"
  },
  changes: {
    least_tool: "show_changes",
    workspace_id: "preview-workspace-019f047a",
    root: repoRoot,
    changed: true,
    staged: false,
    include_diff: true,
    summary_only: false,
    changed_files: ["M src/toolCardWidget.ts", "M scripts/open-tool-card-preview.mjs", " M README.md"],
    additions: 184,
    deletions: 42,
    compacted: true,
    rawBytes: 48210,
    visibleBytes: 11840,
    savedBytes: 36370,
    output_meta: {
      compacted: true,
      retrievalKey: "sha256:preview-key",
      retrievalHint: "retrieve_output({ key: \"sha256:preview-key\" })"
    },
    untracked_summary: {
      count: 2,
      text: "2 untracked files (1 docs, 1 plan)",
      paths: [
        { path: "plan/ui-refresh.md", kind: "docs" },
        { path: ".least/cache/tool-output/preview.txt", kind: "generated" }
      ]
    },
    diff: "diff --git a/src/toolCardWidget.ts b/src/toolCardWidget.ts\n--- a/src/toolCardWidget.ts\n+++ b/src/toolCardWidget.ts\n@@ -1,2 +1,2 @@\n-export const TOOL_CARD_URI = \"ui://widget/least-tool-card-v8.html\";\n+export const TOOL_CARD_URI = \"ui://widget/least-tool-card-v9.html\";\n@@ -24,3 +24,6 @@\n+    --nord0: #080a10;\n+    --nord8: #8fbcbb;\n"
  },
  handoff: {
    least_tool: "handoff_to_agent",
    workspace_id: "preview-workspace-019f047a",
    root: repoRoot,
    agent: "codex",
    agent_name: "Codex",
    model: "gpt-5.4",
    plan_path: ".ai-bridge/current-plan.md",
    status_path: ".ai-bridge/agent-status.md",
    diff_path: ".ai-bridge/implementation-diff.patch",
    execution_log_path: ".ai-bridge/execution-log.jsonl",
    additions: 12,
    deletions: 0,
    diff: "diff --git a/.ai-bridge/current-plan.md b/.ai-bridge/current-plan.md\n+++ b/.ai-bridge/current-plan.md\n@@ -0,0 +1,3 @@\n+# Refresh Least tool card UI\n+- Apply ultra-dark Nord theme\n+- Show compaction and untracked summaries\n"
  }
};

const mock = mocks[scenario] || mocks.workspace;

const html = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  "<title>Least Tool Card Preview (" + scenario + ")</title>",
  "<style>",
  "html,body{margin:0;min-height:100%;background:#030407;color:#c8d0dc;font-family:Segoe UI,sans-serif;}",
  ".preview-shell{max-width:920px;margin:0 auto;padding:28px 20px 40px;background:#030407;}",
  ".preview-note{margin:0 0 16px;color:#6d8faa;font-size:12px;}",
  ".preview-note code{color:#7ab8b6;font-family:ui-monospace,monospace;}",
  "</style>",
  `<script>window.openai = { toolOutput: ${JSON.stringify(mock)} };</script>`,
  "</head>",
  "<body>",
  '<div class="preview-shell">',
  '<p class="preview-note">Preview scenario: <code>' + scenario + '</code>. Try <code>--scenario=changes</code> or <code>--scenario=handoff</code>.</p>',
  toolCardWidgetHtml,
  "</div>",
  "</body>",
  "</html>"
].join("\n");

const out = path.join(os.tmpdir(), `least-tool-card-preview-${scenario}.html`);
await fs.writeFile(out, html, "utf8");

if (process.platform === "win32") {
  spawn("cmd", ["/c", "start", "", out], { detached: true, stdio: "ignore" }).unref();
} else if (process.platform === "darwin") {
  spawn("open", [out], { detached: true, stdio: "ignore" }).unref();
} else {
  spawn("xdg-open", [out], { detached: true, stdio: "ignore" }).unref();
}

console.log(`Opened tool card preview (${scenario}): ${out}`);