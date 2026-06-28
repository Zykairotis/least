import { JSDOM } from "jsdom";
import { toolCardWidgetHtml } from "../dist/toolCardWidget.js";

const mock = {
  least_tool: "open_workspace",
  root: "X:/least",
  workspace_id: "test-id-1234567890abcdef",
  agents_loaded: true,
  agents_path: "AGENTS.md",
  write_mode: "safe",
  bash_mode: "safe",
  shell_backend: "child_process",
  tool_mode: "full",
  toolset: "full",
  concurrency_mode: "off",
  skill_counts: { total: 2, workspace: 1, user: 1, plugin: 0 },
  skill_inventory: [{ name: "code", source: "user", description: "test" }],
  git_status: "## rebrand-to-least...origin/rebrand-to-least\n M src/toolCardWidget.ts\n?? plan/ui.md",
  tree: "src/\nscripts/\nREADME.md"
};

const errors = [];
const dom = new JSDOM(
  `<!DOCTYPE html><html><body><script>window.openai = { toolOutput: ${JSON.stringify(mock)} };</script>${toolCardWidgetHtml}</body></html>`,
  {
    runScripts: "dangerously",
    resources: "usable",
    beforeParse(window) {
      window.openai = { toolOutput: mock };
      window.addEventListener("error", (event) => {
        errors.push(event.error?.stack || event.message || String(event.error));
      });
    }
  }
);

const root = dom.window.document.getElementById("root");
const html = root?.innerHTML || "";

if (errors.length) {
  console.error("RUNTIME ERRORS:\n", errors.join("\n---\n"));
  process.exit(1);
}

if (!html.includes("Workspace") || html.includes("Waiting for tool result")) {
  console.error("Widget did not render workspace card.");
  console.error(html.slice(0, 500));
  process.exit(1);
}

console.log("Widget runtime check passed (" + html.length + " chars rendered)");