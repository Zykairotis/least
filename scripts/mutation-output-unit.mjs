#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { storeMutationDiff, retrieveStoredOutput } from "../dist/toolOutputStore.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-mout-"));
const config = loadConfig(["--root", root]);

const diff = [
  "--- a/src/game.ts",
  "+++ b/src/game.ts",
  "@@ -1,1 +1,2 @@",
  "-export const a = 1;",
  "+export const a = 1;",
  "+export const b = 2;"
].join("\n");

const key = await storeMutationDiff(config, root, "ws1", diff, {
  toolName: "write",
  changedPaths: ["src/game.ts"]
});
assert.ok(key);
assert.match(key, /^sha256:[a-f0-9]{64}$/);

// idempotent store
const key2 = await storeMutationDiff(config, root, "ws1", diff, {
  toolName: "write",
  changedPaths: ["src/game.ts"]
});
assert.equal(key2, key);

const retrieved = await retrieveStoredOutput(config, root, "ws1", key);
assert.ok(retrieved.content.includes("src/game.ts"));
assert.ok(retrieved.rawBytes > 0);

// secret-looking rejected
const secretKey = await storeMutationDiff(config, root, "ws1", "OPENAI_API_KEY=sk-realSecretValue123\n", {
  toolName: "write"
});
assert.equal(secretKey, undefined);

await fs.rm(root, { recursive: true, force: true });
console.log("mutation-output-unit: ok");
