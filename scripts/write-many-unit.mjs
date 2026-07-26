#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { writeManyFiles } from "../dist/writeManyOps.js";
import { combineDiffParts } from "../dist/mutationTypes.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-wm-"));
const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).openWorkspace(root);

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

// --- create 100 files atomically ---
{
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `gen/f${String(i).padStart(3, "0")}.ts`,
    content: `export const n = ${i};\n`
  }));
  const result = await writeManyFiles(config, guard, workspace, files, {
    responseMode: "summary",
    concurrency: 8
  });
  assert.equal(result.changed_files, 100);
  assert.equal(result.created_files, 100);
  assert.equal(result.overwritten_files, 0);
  assert.equal(result.response_mode, "summary");
  assert.equal(result.storageDiff, undefined);
  assert.equal(result.diff_stats_computed, false);
  assert.equal(result.additions, null);
  assert.equal(result.impact, "structure");
  const sample = await fs.readFile(path.join(root, "gen/f042.ts"), "utf8");
  assert.equal(sample, "export const n = 42;\n");
  assert.equal(result.files[42].sha256, sha("export const n = 42;\n"));
}

// --- overwrite with expected sha ---
{
  const pathRel = "gen/f000.ts";
  const before = await fs.readFile(path.join(root, pathRel), "utf8");
  const result = await writeManyFiles(
    config,
    guard,
    workspace,
    [{ path: pathRel, content: "export const n = 999;\n", expectedSha256: sha(before) }],
    { responseMode: "summary" }
  );
  assert.equal(result.overwritten_files, 1);
  assert.equal(result.created_files, 0);
  assert.equal(result.impact, "content");
}

// --- stale sha rejects all ---
{
  let failed = false;
  const before0 = await fs.readFile(path.join(root, "gen/f001.ts"), "utf8");
  const before1 = await fs.readFile(path.join(root, "gen/f002.ts"), "utf8");
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [
        { path: "gen/f001.ts", content: "changed1\n", expectedSha256: sha(before0) },
        { path: "gen/f002.ts", content: "changed2\n", expectedSha256: "deadbeef".repeat(8) }
      ],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /Stale write/);
  }
  assert.equal(failed, true);
  assert.equal(await fs.readFile(path.join(root, "gen/f001.ts"), "utf8"), before0);
  assert.equal(await fs.readFile(path.join(root, "gen/f002.ts"), "utf8"), before1);
}

// --- duplicate paths rejected ---
{
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [
        { path: "dup.ts", content: "a\n" },
        { path: "dup.ts", content: "b\n" }
      ],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /Duplicate write_many target/);
  }
  assert.equal(failed, true);
}

// --- secret blocked ---
{
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "secret.ts", content: "OPENAI_API_KEY=sk-realSecretValue123\n" }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /Secret-looking content/);
  }
  assert.equal(failed, true);
}

// --- expect_absent ---
{
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "gen/f000.ts", content: "nope\n", expectAbsent: true }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /expect_absent/);
  }
  assert.equal(failed, true);
}

// --- overwrite=false ---
{
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "gen/f000.ts", content: "nope\n", overwrite: false }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /overwrite=false/);
  }
  assert.equal(failed, true);
}

// --- compact / full modes produce storage + preview diffs ---
{
  const compact = await writeManyFiles(
    config,
    guard,
    workspace,
    [{ path: "modes/a.ts", content: "one\n" }],
    { responseMode: "compact_diff" }
  );
  assert.ok(compact.storageDiff);
  assert.ok(compact.previewDiff);
  const full = await writeManyFiles(
    config,
    guard,
    workspace,
    [{ path: "modes/a.ts", content: "two\n" }],
    { responseMode: "full_diff" }
  );
  assert.ok(full.storageDiff);
  assert.ok((full.additions ?? 0) >= 1 || (full.deletions ?? 0) >= 1);
}

// --- create_dirs=false rejects missing parent before any write ---
{
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "missing_parent/child.txt", content: "x\n", createDirs: false }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /create_dirs=false|Parent directory does not exist/);
  }
  assert.equal(failed, true);
  await assert.rejects(
    () => fs.access(path.join(root, "missing_parent/child.txt")),
    /ENOENT/
  );
}

// --- create_dirs=false succeeds when parent exists ---
{
  await fs.mkdir(path.join(root, "existing_parent"), { recursive: true });
  const result = await writeManyFiles(
    config,
    guard,
    workspace,
    [{ path: "existing_parent/child.txt", content: "ok\n", createDirs: false }],
    { responseMode: "summary" }
  );
  assert.equal(result.created_files, 1);
  assert.equal(await fs.readFile(path.join(root, "existing_parent/child.txt"), "utf8"), "ok\n");
}

// --- binary existing target rejected ---
{
  const binPath = path.join(root, "binary.bin");
  await fs.writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "binary.bin", content: "text\n" }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /binary/i);
  }
  assert.equal(failed, true);
  // Unchanged
  const still = await fs.readFile(binPath);
  assert.deepEqual(still, Buffer.from([0x00, 0x01, 0x02, 0xff]));
}

// --- directory target rejected ---
{
  await fs.mkdir(path.join(root, "is-dir"), { recursive: true });
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "is-dir", content: "nope\n" }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /Not a file/i);
  }
  assert.equal(failed, true);
}

// --- oversized existing target rejected ---
{
  const bigPath = path.join(root, "huge.txt");
  // Exceed default maxWriteBytes (1e6) while staying testable.
  const oversize = "x".repeat(Math.max(config.maxWriteBytes, config.maxReadBytes) + 100);
  await fs.writeFile(bigPath, oversize, "utf8");
  let failed = false;
  try {
    await writeManyFiles(
      config,
      guard,
      workspace,
      [{ path: "huge.txt", content: "small\n" }],
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /too large/i);
  }
  assert.equal(failed, true);
}

// --- combineDiffParts global byte budget ---
{
  const parts = Array.from({ length: 20 }, (_, i) => `FILE${i}\n` + "x".repeat(20_000));
  const combined = combineDiffParts(parts, 12_000);
  assert.ok(combined.bytes <= 12_000, `combined preview must stay within budget, got ${combined.bytes}`);
  assert.equal(combined.truncated, true);
  assert.ok(combined.includedParts < 20);
  assert.ok(combined.omittedParts >= 1);
}

// --- multi-file compact_diff preview stays globally bounded ---
{
  const files = Array.from({ length: 20 }, (_, i) => ({
    path: `preview/p${i}.ts`,
    content: `export const v = ${i};\n` + "line\n".repeat(400)
  }));
  const result = await writeManyFiles(config, guard, workspace, files, {
    responseMode: "compact_diff",
    concurrency: 8
  });
  assert.ok(result.previewDiff);
  const previewBytes = Buffer.byteLength(result.previewDiff, "utf8");
  assert.ok(previewBytes <= 12_000, `previewBytes ${previewBytes} should be <= 12000`);
  assert.equal(result.diffTruncated, true);
}

// --- combined storage respects store budget ---
{
  // Many medium diffs that individually fit but would exceed store limit if concatenated raw.
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `store/s${i}.ts`,
    content: `export const s = ${i};\n` + ("const line = " + i + ";\n").repeat(2_000)
  }));
  // First create with summary
  await writeManyFiles(config, guard, workspace, files, { responseMode: "summary", concurrency: 8 });
  // Overwrite with full_diff to force storage
  const changed = files.map((f, i) => ({
    ...f,
    content: f.content.replace("export const s", "export const t") + `// ch ${i}\n`
  }));
  const result = await writeManyFiles(config, guard, workspace, changed, {
    responseMode: "full_diff",
    concurrency: 8
  });
  if (result.storageDiff) {
    assert.ok(
      Buffer.byteLength(result.storageDiff, "utf8") <= config.outputStoreMaxItemBytes,
      "combined storageDiff must fit store limit"
    );
  }
  // Preview must always be globally bounded even when many files change.
  if (result.previewDiff) {
    assert.ok(Buffer.byteLength(result.previewDiff, "utf8") <= Math.min(60_000, config.maxOutputBytes));
  }
  // If the combined storage omitted parts, complete must be false.
  // (Preview truncation alone may leave storage complete — that is allowed.)
  if (result.diffComplete === true) {
    assert.ok(result.storageDiff, "diffComplete=true requires a storage payload");
  }
}

// --- aggregate original-bytes limit ---
{
  const smallConfig = {
    ...config,
    maxWriteManyOriginalBytes: 50_000
  };
  // Create 10 files of ~10KB each (100KB originals) then try overwrite.
  const files = Array.from({ length: 10 }, (_, i) => ({
    path: `orig/o${i}.ts`,
    content: "x".repeat(10_000)
  }));
  await writeManyFiles(config, guard, workspace, files, { responseMode: "summary" });
  let failed = false;
  try {
    await writeManyFiles(
      smallConfig,
      guard,
      workspace,
      files.map((f) => ({ ...f, content: "y" })),
      { responseMode: "summary" }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /original content exceeds rollback memory limit|LEAST_MAX_WRITE_MANY_ORIGINAL/);
  }
  assert.equal(failed, true);
}

await fs.rm(root, { recursive: true, force: true });
console.log("write-many-unit: ok");
