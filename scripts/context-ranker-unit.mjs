import assert from "node:assert/strict";
import { rankContextFiles, suggestedNextCalls } from "../dist/contextRanker.js";

const ranked = rankContextFiles({
  task: "fix auth middleware",
  query: "auth",
  profile: "edit",
  candidates: ["src/server.ts", "src/auth.ts", "src/auth.test.ts", "package-lock.json", "README.md"],
  changedFiles: ["src/auth.ts"]
});

assert.equal(ranked[0]?.path, "src/auth.ts", "changed exact-hit file should rank first");
assert.ok(ranked.some((item) => item.path === "src/auth.test.ts"), "test adjacency should remain in results");
const lockfile = ranked.find((item) => item.path === "package-lock.json");
const top = ranked[0];
assert.ok(lockfile && top && lockfile.score < top.score, "lockfile should be penalized");

const reviewRanked = rankContextFiles({
  task: "review PR",
  profile: "review",
  candidates: ["src/foo.ts", "src/bar.ts"],
  changedFiles: ["src/bar.ts"]
});
assert.equal(reviewRanked[0]?.path, "src/bar.ts");

const next = suggestedNextCalls("review", reviewRanked);
assert.ok(next.length >= 2);

const importRanked = rankContextFiles({
  task: "trace imports",
  profile: "edit",
  candidates: ["src/server.ts", "src/auth.ts", "src/config.ts"],
  importNeighbors: ["src/config.ts"]
});
const configNeighbor = importRanked.find((item) => item.path === "src/config.ts");
assert.ok(configNeighbor?.scoreBreakdown?.importNeighborScore, "import neighbor score should be set");
assert.ok(configNeighbor?.reason.includes("import neighbor"), "import neighbor reason should be present");

console.log("context-ranker-unit: ok");