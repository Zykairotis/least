import assert from "node:assert/strict";
import vm from "node:vm";
import { loadConfig } from "../dist/config.js";
import { shapeTextOutput } from "../dist/outputShaper.js";
import { compactSearch } from "../dist/outputCompactors/searchCompactor.js";
import { compactGitDiff } from "../dist/outputCompactors/gitDiffCompactor.js";
import { compactTestLog } from "../dist/outputCompactors/testLogCompactor.js";
import { toolCardWidgetHtml } from "../dist/toolCardWidget.js";

const config = loadConfig(["--root", process.cwd()]);

const small = await shapeTextOutput(
  config,
  { kind: "text", text: "hello", rawBytes: 5, toolName: "test" },
  { maxVisibleBytes: 1000, workspaceId: "ws", workspaceRoot: process.cwd() }
);
assert.equal(small.meta.mode, "raw", "small output stays raw");

const bigText = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
const big = await shapeTextOutput(
  config,
  { kind: "text", text: bigText, rawBytes: Buffer.byteLength(bigText, "utf8"), toolName: "bash", command: "npm test", exitCode: 1 },
  { mode: "compact", maxVisibleBytes: 4000, workspaceId: "ws", workspaceRoot: process.cwd() }
);
assert.ok(big.meta.compacted, "large bash output should compact");
assert.ok(big.meta.visibleBytes <= big.meta.rawBytes, "compacted output should not grow");

const searchInput = [
  "src/a.ts:10: alpha",
  "src/a.ts:11: context",
  "src/b.ts:4: alpha beta",
  ...Array.from({ length: 100 }, (_, i) => `src/c${i}.ts:${i + 1}: hit`)
].join("\n");
const search = compactSearch({ kind: "search", text: searchInput, rawBytes: Buffer.byteLength(searchInput, "utf8"), toolName: "search_context" }, 800);
assert.ok(search.visibleBytes <= search.rawBytes);
assert.ok(search.mode === "compact" || search.mode === "truncated", "search output should compact under small budget");

const diffInput = `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,4 @@\n+  "scripts": { "test": "npm test" }\n`;
const diff = compactGitDiff({ kind: "git_diff", text: diffInput.repeat(400), rawBytes: Buffer.byteLength(diffInput.repeat(400), "utf8"), toolName: "git_diff" }, 5000);
assert.ok(diff.visibleBytes <= diff.rawBytes);

const failLog = "FAIL src/x.test.ts\nAssertionError: expected 1 to equal 2\nExpected: 2\nReceived: 1\n    at Object.<anonymous> (src/x.test.ts:4:5)\n".repeat(80);
const testLog = compactTestLog({ kind: "test_log", text: failLog, rawBytes: Buffer.byteLength(failLog, "utf8"), toolName: "bash", command: "npm test", exitCode: 1 }, 6000);
assert.match(testLog.content, /FAIL|AssertionError|Expected/i);

const truncatedOnly = compactTestLog(
  {
    kind: "test_log",
    text: "ok line\n".repeat(4000),
    rawBytes: 40_000,
    toolName: "bash",
    command: "npm test",
    exitCode: 0,
    truncated: true,
    timedOut: false
  },
  2000
);
assert.doesNotMatch(truncatedOnly.content, /timed out/i, "truncated shell output must not be labeled as timed out");

const timedOutLog = compactTestLog(
  {
    kind: "test_log",
    text: "partial output\n".repeat(200),
    rawBytes: 4000,
    toolName: "bash",
    command: "npm test",
    exitCode: null,
    truncated: false,
    timedOut: true
  },
  2000
);
assert.match(timedOutLog.content, /timed out/i, "actual timeouts should be labeled as timed out");

const successNoExit = compactTestLog(
  { kind: "test_log", text: Array.from({ length: 400 }, (_, i) => `ok ${i}`).join("\n"), rawBytes: 5000, toolName: "bash", command: "npm test" },
  1200
);
assert.match(successNoExit.summary ?? successNoExit.reason, /success/i);

const contextSearch = [
  "### src/auth.ts:42",
  "40- before",
  "41- before",
  "42: export function auth() {}",
  "43- after",
  "",
  "---",
  "",
  "### docs/readme:3",
  "3: mention auth"
].join("\n");
const contextCompact = compactSearch(
  { kind: "search", text: contextSearch, rawBytes: Buffer.byteLength(contextSearch, "utf8"), toolName: "search_context" },
  500
);
assert.ok(contextCompact.content.includes("src/auth.ts"));
assert.ok(contextCompact.content.includes("docs/readme"));
const contextPadding = Array.from({ length: 900 }, (_, i) => `${i + 1}- ${"context padding ".repeat(6)}`).join("\n");
const paddedContextSearch = ["### src/a.ts:10", contextPadding, "10: target", "11- after", "---"].join("\n");
const contextParsed = compactSearch(
  {
    kind: "search",
    text: paddedContextSearch,
    rawBytes: Buffer.byteLength(paddedContextSearch, "utf8"),
    toolName: "search_context"
  },
  500
);
assert.match(contextParsed.content, /Search compacted: 1 matches/);

const bigSearchText = Array.from({ length: 1200 }, (_, i) => `src/hit${i}.ts:${i + 1}: needle`).join("\n");
const bigSearchBytes = Buffer.byteLength(bigSearchText, "utf8");
const envBackup = {
  LEAST_OUTPUT_MODE: process.env.LEAST_OUTPUT_MODE,
  LEAST_COMPACT_SEARCH: process.env.LEAST_COMPACT_SEARCH,
  LEAST_COMPACT_SHELL: process.env.LEAST_COMPACT_SHELL
};
try {
  process.env.LEAST_OUTPUT_MODE = "raw";
  process.env.LEAST_COMPACT_SEARCH = "1";
  const rawConfig = loadConfig(["--root", process.cwd()]);
  const rawMode = await shapeTextOutput(
    rawConfig,
    { kind: "search", text: bigSearchText, rawBytes: bigSearchBytes, toolName: "search" },
    { maxVisibleBytes: 4000, workspaceId: "ws", workspaceRoot: process.cwd() }
  );
  assert.equal(rawMode.meta.compacted, false, "raw mode should not compact large search output");

  process.env.LEAST_OUTPUT_MODE = "compact";
  process.env.LEAST_COMPACT_SEARCH = "0";
  process.env.LEAST_COMPACT_SHELL = "0";
  const compactOffConfig = loadConfig(["--root", process.cwd()]);
  const compactOff = await shapeTextOutput(
    compactOffConfig,
    { kind: "search", text: bigSearchText, rawBytes: bigSearchBytes, toolName: "search" },
    { maxVisibleBytes: 4000, workspaceId: "ws", workspaceRoot: process.cwd() }
  );
  assert.equal(compactOff.meta.compacted, false, "compact mode should respect LEAST_COMPACT_SEARCH=0");

  const compactCode = await shapeTextOutput(
    compactOffConfig,
    { kind: "code", text: bigText, rawBytes: Buffer.byteLength(bigText, "utf8"), toolName: "read" },
    { maxVisibleBytes: 4000, workspaceId: "ws", workspaceRoot: process.cwd() }
  );
  assert.equal(compactCode.meta.compacted, false, "compact mode should not compact unknown/code kind by default");

  process.env.LEAST_COMPACT_SEARCH = "1";
  const compactOnConfig = loadConfig(["--root", process.cwd()]);
  const compactOn = await shapeTextOutput(
    compactOnConfig,
    { kind: "search", text: bigSearchText, rawBytes: bigSearchBytes, toolName: "search" },
    { maxVisibleBytes: 4000, workspaceId: "ws", workspaceRoot: process.cwd() }
  );
  assert.equal(compactOn.meta.compacted, true, "compact mode should compact search when enabled");

  process.env.LEAST_OUTPUT_MODE = "compressed";
  process.env.LEAST_COMPACT_SEARCH = "0";
  const compressedConfig = loadConfig(["--root", process.cwd()]);
  const unknownKind = await shapeTextOutput(
    compressedConfig,
    { kind: "code", text: bigText, rawBytes: Buffer.byteLength(bigText, "utf8"), toolName: "read" },
    { maxVisibleBytes: 4000, workspaceId: "ws", workspaceRoot: process.cwd() }
  );
  assert.equal(unknownKind.meta.compacted, true, "compressed mode should compact eligible large outputs");
} finally {
  if (envBackup.LEAST_OUTPUT_MODE === undefined) delete process.env.LEAST_OUTPUT_MODE;
  else process.env.LEAST_OUTPUT_MODE = envBackup.LEAST_OUTPUT_MODE;
  if (envBackup.LEAST_COMPACT_SEARCH === undefined) delete process.env.LEAST_COMPACT_SEARCH;
  else process.env.LEAST_COMPACT_SEARCH = envBackup.LEAST_COMPACT_SEARCH;
  if (envBackup.LEAST_COMPACT_SHELL === undefined) delete process.env.LEAST_COMPACT_SHELL;
  else process.env.LEAST_COMPACT_SHELL = envBackup.LEAST_COMPACT_SHELL;
}

const multiFileDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "+a",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "+b",
  "diff --git a/src/c.ts b/src/c.ts",
  "--- a/src/c.ts",
  "+++ b/src/c.ts",
  "@@ -1 +1 @@",
  "+c"
].join("\n").repeat(300);
const orderedDiff = compactGitDiff(
  { kind: "git_diff", text: multiFileDiff, rawBytes: Buffer.byteLength(multiFileDiff, "utf8"), toolName: "git_diff" },
  20_000
);
const aPos = orderedDiff.content.indexOf("src/a.ts");
const bPos = orderedDiff.content.indexOf("src/b.ts");
const cPos = orderedDiff.content.indexOf("src/c.ts");
assert.ok(aPos >= 0 && bPos > aPos && cPos > bPos, "compacted diff should preserve original file order in patch body");

const noExtSearch = "src/auth:10: token\nsrc/auth:12: verify\n";
const noExtCompact = compactSearch(
  { kind: "search", text: noExtSearch.repeat(40), rawBytes: Buffer.byteLength(noExtSearch.repeat(40), "utf8"), toolName: "search" },
  400
);
assert.ok(noExtCompact.content.includes("src/auth"));

const scriptMatch = toolCardWidgetHtml.match(/<script>([\s\S]*)<\/script>/);
assert.ok(scriptMatch?.[1], "tool-card widget should include inline script");
for (const toolOutput of [
  { least_tool: "open_current_workspace", root: process.cwd(), workspace_id: "ws-widget", git_status: "## main\n M src/toolCardWidget.ts", tool_mode: "full", toolset: "full", bash_mode: "safe", write_mode: "workspace" },
  { least_tool: "show_changes", changed: true, changed_files: ["M src/toolCardWidget.ts"], additions: 1, deletions: 1, status: "## main\n M src/toolCardWidget.ts" },
  { least_tool: "handoff_to_agent", agent: "codex", plan_path: ".ai-bridge/current-plan.md", additions: 1, deletions: 0 },
  { least_tool: "files", files: ["src/server.ts", "src/toolCardWidget.ts", "package.json"], count: 3, backend: "ripgrep" },
  { least_tool: "bash", command: "npm run build", exitCode: 0, stdout: "build ok\n", stderr: "", durationMs: 123 },
  { least_tool: "agent_status", job_id: "agent_demo_1234567890", task_id: "demo-task", agent: "oh-my-pi", state: "running" },
  { least_tool: "agent_attach_hint", job_id: "agent_demo_1234567890", attach_commands: [{ command: "zellij attach demo" }] }
]) {
  const root = { innerHTML: "" };
  const windowMock = { openai: { toolOutput }, parent: undefined, addEventListener() {} };
  windowMock.parent = windowMock;
  vm.runInNewContext(scriptMatch[1], { window: windowMock, document: { getElementById: () => root }, console });
  assert.match(root.innerHTML, /<article class="card">/, "tool-card widget should render without a runtime error");
}

console.log("output-shaper-unit: ok");
