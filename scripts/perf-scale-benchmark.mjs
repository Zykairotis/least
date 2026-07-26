import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { workspaceSummary } from "../dist/workspaceOps.js";
import { listWorkspaceFiles } from "../dist/filesOps.js";
import { searchWorkspace, searchWorkspaceContext } from "../dist/searchOps.js";
import { readManyTextFiles } from "../dist/fsOps.js";
import { contextPack } from "../dist/contextPackOps.js";
import { shapeTextOutput } from "../dist/outputShaper.js";
import { gitDiff } from "../dist/gitOps.js";

const sizeMap = {
  tiny: 50,
  small: 500,
  medium: 5000,
  large: 25000
};

function parseArg(name, fallback) {
  const token = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!token) return fallback;
  return token.slice(name.length + 3);
}

async function makeRepo(repoSize) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `least-scale-${repoSize}-`));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# scale benchmark\n", "utf8");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "scale-benchmark", scripts: { test: "echo ok", build: "tsc -p tsconfig.json" }, dependencies: { react: "18.0.0" } }, null, 2),
    "utf8"
  );
  for (let index = 0; index < repoSize; index += 1) {
    await fs.writeFile(
      path.join(root, "src", `module-${index}.ts`),
      `export const value${index} = ${index};\nexport function handler${index}() { return "persistScaleSymbol"; }\n`,
      "utf8"
    );
    if (index % 10 === 0) {
      await fs.writeFile(path.join(root, "docs", `doc-${index}.md`), `# Doc ${index}\n\npersistScaleSymbol appears here.\n`, "utf8");
    }
  }
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "scale-benchmark@example.com"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Scale Benchmark"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

function estimateTokens(bytes) {
  return Math.ceil(Number(bytes ?? 0) / 4);
}

function outputMetrics(result) {
  if (!result || typeof result !== "object") return {};
  const rawBytes = result.rawBytes;
  const visibleBytes = result.visibleBytes;
  return {
    rawBytes,
    visibleBytes,
    savedBytes: result.savedBytes,
    compacted: result.compacted,
    retrievalKeyPresent: Boolean(result.retrievalKey),
    estimatedTokensBefore: result.estimatedTokensBefore ?? estimateTokens(rawBytes),
    estimatedTokensAfter: result.estimatedTokensAfter ?? estimateTokens(visibleBytes)
  };
}

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  return {
    label,
    elapsedMs: Math.round(performance.now() - start),
    backend: result?.backend ?? result?.used,
    count: result?.count ?? result?.matches?.length ?? result?.files?.length ?? result?.candidateFiles?.length,
    truncated: Boolean(result?.truncated),
    ...outputMetrics(result)
  };
}

const repoSizeLabel = parseArg("repo-size", "small");
if (!(repoSizeLabel in sizeMap)) {
  throw new Error(`Unsupported repo size: ${repoSizeLabel}`);
}

const root = await makeRepo(sizeMap[repoSizeLabel]);
const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspaces = new WorkspaceManager(config);
const workspace = workspaces.openWorkspace(root);

const scenarios = [];
scenarios.push(
  await timed("open_current_workspace_cold", async () =>
    workspaceSummary(config, guard, workspace, { includeTree: false, includeSkills: false, includeGlobalSkills: false, includeRecentCommits: false })
  )
);
scenarios.push(await timed("files_cold", async () => listWorkspaceFiles(config, guard, workspace, { glob: "src/**/*.ts", maxResults: 1000 })));
scenarios.push(await timed("files_warm", async () => listWorkspaceFiles(config, guard, workspace, { glob: "src/**/*.ts", maxResults: 1000 })));
scenarios.push(await timed("search_cold", async () => searchWorkspace(config, guard, workspace, { query: "persistScaleSymbol", maxResults: 25 })));
scenarios.push(await timed("search_context", async () => searchWorkspaceContext(config, guard, workspace, { query: "persistScaleSymbol", maxResults: 10, beforeLines: 1, afterLines: 1 })));
scenarios.push(
  await timed("read_many_20", async () =>
    readManyTextFiles(
      config,
      guard,
      workspace,
      Array.from({ length: 20 }, (_, index) => ({ path: `src/module-${index}.ts` })),
      { concurrency: 8, includeSha256: false, includeTotalLines: false }
    )
  )
);
scenarios.push(
  await timed("context_pack", async () =>
    contextPack(config, guard, workspace, {
      task: "find persistScaleSymbol handlers",
      query: "persistScaleSymbol",
      profile: "explore",
      maxFiles: 12,
      maxSnippets: 8,
      maxBytes: config.maxReadBytes * 2,
      includeGitStatus: true,
      includePackageContext: true
    })
  )
);

scenarios.push(
  await timed("large_search_compact", async () => {
    const search = await searchWorkspaceContext(config, guard, workspace, {
      query: "persistScaleSymbol",
      maxResults: 50,
      beforeLines: 2,
      afterLines: 3
    });
    const rawBytes = Buffer.byteLength(search.text, "utf8");
    const shaped = await shapeTextOutput(
      config,
      { kind: "search", text: search.text, rawBytes, toolName: "search_context" },
      { mode: "compact", maxVisibleBytes: 10_000, workspaceId: workspace.id, workspaceRoot: workspace.root }
    );
    return {
      count: search.matches.length,
      rawBytes: shaped.meta.rawBytes,
      visibleBytes: shaped.meta.visibleBytes,
      savedBytes: shaped.meta.savedBytes,
      compacted: shaped.meta.compacted,
      retrievalKey: shaped.meta.retrievalKey,
      estimatedTokensBefore: shaped.meta.estimatedTokensBefore,
      estimatedTokensAfter: shaped.meta.estimatedTokensAfter
    };
  })
);

scenarios.push(
  await timed("large_diff_compact", async () => {
    const rawDiff = await gitDiff(config, guard, workspace);
    const rawBytes = Buffer.byteLength(rawDiff, "utf8");
    const shaped = await shapeTextOutput(
      config,
      { kind: "git_diff", text: rawDiff, rawBytes, toolName: "git_diff" },
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
  })
);

const report = {
  generatedAt: new Date().toISOString(),
  repoSize: repoSizeLabel,
  fileCount: sizeMap[repoSizeLabel],
  platform: process.platform,
  scenarios,
  totalMs: scenarios.reduce((sum, scenario) => sum + scenario.elapsedMs, 0)
};

console.log(JSON.stringify(report, null, 2));
