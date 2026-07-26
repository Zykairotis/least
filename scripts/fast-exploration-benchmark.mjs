import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { workspaceSummary } from "../dist/workspaceOps.js";
import { listWorkspaceFiles } from "../dist/filesOps.js";
import { searchWorkspace, searchWorkspaceContext } from "../dist/searchOps.js";
import { readManyTextFiles } from "../dist/fsOps.js";
import { shapeTextOutput } from "../dist/outputShaper.js";
import { storeToolOutput, retrieveStoredOutput } from "../dist/toolOutputStore.js";
import { contextPack } from "../dist/contextPackOps.js";

function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

function byteMetrics(text) {
  const rawBytes = Buffer.byteLength(text, "utf8");
  return {
    rawBytes,
    visibleBytes: rawBytes,
    savedBytes: 0,
    compacted: false,
    estimatedTokensBefore: estimateTokens(rawBytes),
    estimatedTokensAfter: estimateTokens(rawBytes)
  };
}

async function shapedMetrics(config, workspace, toolName, kind, text, options = {}) {
  const rawBytes = Buffer.byteLength(text, "utf8");
  const shaped = await shapeTextOutput(
    config,
    { kind, text, rawBytes, toolName, ...options },
    { mode: "compact", maxVisibleBytes: 12_000, workspaceId: workspace.id, workspaceRoot: workspace.root }
  );
  return {
    rawBytes: shaped.meta.rawBytes,
    visibleBytes: shaped.meta.visibleBytes,
    savedBytes: shaped.meta.savedBytes,
    compacted: shaped.meta.compacted,
    retrievalKey: shaped.meta.retrievalKey,
    estimatedTokensBefore: shaped.meta.estimatedTokensBefore,
    estimatedTokensAfter: shaped.meta.estimatedTokensAfter
  };
}

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  const elapsedMs = Math.round(performance.now() - start);
  return { label, elapsedMs, result };
}

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-benchmark-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    await fs.writeFile(
      path.join(root, "src", `module-${i}.ts`),
      `export const value${i} = ${i};\nexport const sharedSymbol = "persistVolumeAnalysis";\n`,
      "utf8"
    );
  }
  await fs.writeFile(path.join(root, "scripts", "worker.ts"), 'export const worker = "backfill";\n', "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# benchmark\n", "utf8");
  return root;
}

const root = await makeRepo();
const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspaces = new WorkspaceManager(config);
const workspace = workspaces.openWorkspace(root);

const scenarios = [];

scenarios.push(
  await timed("open_current_workspace_fast", async () =>
    workspaceSummary(config, guard, workspace, {
      includeTree: false,
      includeSkills: false,
      includeGlobalSkills: false,
      includeRecentCommits: false
    })
  )
);

scenarios.push(
  await timed("files_candidate_discovery", async () =>
    listWorkspaceFiles(config, guard, workspace, {
      glob: "src/**/*.ts",
      maxResults: 100
    })
  )
);

scenarios.push(
  await timed("files_candidate_discovery_warm", async () =>
    listWorkspaceFiles(config, guard, workspace, {
      glob: "src/**/*.ts",
      maxResults: 100
    })
  )
);

scenarios.push(
  await timed("search_symbol", async () =>
    searchWorkspace(config, guard, workspace, {
      query: "persistVolumeAnalysis",
      root: "src",
      maxResults: 20
    })
  )
);

scenarios.push(
  await timed("search_symbol_warm", async () =>
    searchWorkspace(config, guard, workspace, {
      query: "persistVolumeAnalysis",
      root: "src",
      maxResults: 20
    })
  )
);

scenarios.push(
  await timed("search_context_symbol", async () =>
    searchWorkspaceContext(config, guard, workspace, {
      query: "persistVolumeAnalysis",
      root: "src",
      beforeLines: 1,
      afterLines: 1,
      maxResults: 5
    })
  )
);

scenarios.push(
  await timed("read_many_three_files", async () =>
    readManyTextFiles(config, guard, workspace, [
      { path: "src/module-0.ts" },
      { path: "src/module-1.ts" },
      { path: "scripts/worker.ts" }
    ])
  )
);

const largeSearchText = (await searchWorkspaceContext(config, guard, workspace, {
  query: "sharedSymbol",
  maxResults: 80,
  beforeLines: 2,
  afterLines: 4
})).text;

scenarios.push(
  await timed("search_context_compact", async () => {
    const metrics = await shapedMetrics(config, workspace, "search_context", "search", largeSearchText);
    return { ...metrics, count: 80 };
  })
);

const largeDiff = Array.from({ length: 120 }, (_, i) => `diff --git a/src/module-${i}.ts b/src/module-${i}.ts\n--- a/src/module-${i}.ts\n+++ b/src/module-${i}.ts\n@@ -1,2 +1,3 @@\n+changed ${i}\n export const value${i} = ${i};`).join("\n");
scenarios.push(
  await timed("git_diff_compact", async () => shapedMetrics(config, workspace, "git_diff", "git_diff", largeDiff))
);

const largeTestLog = [
  "FAIL src/module.test.ts > sharedSymbol > should persist",
  "AssertionError: expected 1 to be 2",
  "    at Object.<anonymous> (src/module.test.ts:42:11)",
  "expected 2",
  "received 1",
  "Tests: 1 failed, 39 passed, 40 total"
].join("\n").repeat(120);

scenarios.push(
  await timed("test_log_compact", async () => shapedMetrics(config, workspace, "bash", "test_log", largeTestLog, { exitCode: 1 }))
);

scenarios.push(
  await timed("context_pack_profile_edit", async () =>
    contextPack(config, guard, workspace, {
      task: "find sharedSymbol usage",
      query: "sharedSymbol",
      profile: "edit",
      maxFiles: 10,
      maxSnippets: 8,
      maxBytes: config.maxReadBytes * 2
    })
  )
);

const retrievalPayload = "retrieval-check\n".repeat(400);
const retrievalKey = await storeToolOutput(config, workspace.root, workspace.id, "benchmark", "text", retrievalPayload);
scenarios.push(
  await timed("retrieve_output_by_key", async () => {
    const retrieved = await retrieveStoredOutput(config, workspace.root, workspace.id, retrievalKey, { maxBytes: 20_000 });
    return byteMetrics(retrieved.content);
  })
);

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  scenarios: scenarios.map(({ label, elapsedMs, result }) => ({
    label,
    elapsedMs,
    backend: result.backend ?? result.used,
    count: result.count ?? result.matches?.length ?? result.files?.length ?? result.candidateFiles?.length,
    truncated: Boolean(result.truncated),
    rawBytes: result.rawBytes ?? byteMetrics(result.text ?? "").rawBytes,
    visibleBytes: result.visibleBytes ?? byteMetrics(result.text ?? "").visibleBytes,
    savedBytes: result.savedBytes ?? 0,
    compacted: Boolean(result.compacted),
    retrievalKeyPresent: Boolean(result.retrievalKey),
    estimatedTokensBefore: result.estimatedTokensBefore ?? estimateTokens(result.rawBytes ?? 0),
    estimatedTokensAfter: result.estimatedTokensAfter ?? estimateTokens(result.visibleBytes ?? 0)
  })),
  totalMs: scenarios.reduce((sum, item) => sum + item.elapsedMs, 0),
  toolCallsForExplorationTask: 4
};

console.log(JSON.stringify(report, null, 2));
console.error(`fast-exploration-benchmark: ok (${report.totalMs}ms total)`);
