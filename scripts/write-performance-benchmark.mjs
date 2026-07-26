#!/usr/bin/env node
/**
 * Write-performance benchmark for Least mutation paths.
 *
 * Usage:
 *   node scripts/write-performance-benchmark.mjs
 *   node scripts/write-performance-benchmark.mjs --quick
 *   node scripts/write-performance-benchmark.mjs --json
 *   node scripts/write-performance-benchmark.mjs --concurrency=8
 *
 * Do not commit generated output. Temp data lives under .ai-bridge/bench and is cleaned up.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const quick = args.includes("--quick");
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const fixedConcurrency = concurrencyArg ? Number(concurrencyArg.split("=")[1]) : undefined;

function parseList(flag, fallback) {
  const raw = args.find((a) => a.startsWith(`${flag}=`));
  if (!raw) return fallback;
  return raw
    .slice(flag.length + 1)
    .split(",")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
}

const FILE_COUNTS = quick ? [1, 20, 100] : parseList("--counts", [1, 4, 20, 100]);
// Keep multi-file matrix to modest sizes so quick mode stays under ~30s.
const FILE_SIZES = quick
  ? [2 * 1024, 50 * 1024]
  : parseList("--sizes", [2 * 1024, 64 * 1024, 512 * 1024, 900 * 1024]);
const CONCURRENCIES = fixedConcurrency
  ? [fixedConcurrency]
  : quick
    ? [1, 8]
    : parseList("--concurrencies", [1, 2, 4, 8, 16]);

function deterministicContent(sizeBytes, seed) {
  // O(n) construction — never re-measure length inside a growing loop.
  const header = `// seed=${seed}\n`;
  const line = `export const x_${seed} = ${seed};\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  const headerBytes = Buffer.byteLength(header, "utf8");
  if (sizeBytes <= headerBytes) return header.slice(0, sizeBytes);
  const need = sizeBytes - headerBytes;
  const repeats = Math.ceil(need / lineBytes) + 1;
  return Buffer.from(header + line.repeat(repeats), "utf8").subarray(0, sizeBytes).toString("utf8");
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mem() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed };
}

async function mapWithConcurrency(items, limit, fn) {
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function sequentialTransaction(root, files) {
  // Baseline-style: read original, mkdir, write temp, rename — sequential
  const originals = new Map();
  const temps = new Map();
  try {
    for (const file of files) {
      const abs = path.join(root, file.rel);
      let original;
      try {
        original = await fs.readFile(abs);
      } catch {
        original = undefined;
      }
      originals.set(abs, original);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.bench-${process.pid}.tmp`);
      await fs.writeFile(temp, file.content, { encoding: "utf8", flag: "wx" });
      temps.set(abs, temp);
    }
    for (const file of files) {
      const abs = path.join(root, file.rel);
      await fs.rename(temps.get(abs), abs);
      temps.delete(abs);
    }
  } finally {
    await Promise.allSettled([...temps.values()].map((t) => fs.unlink(t)));
  }
}

/**
 * Production-like prepared path: originals + buffers already known from preflight.
 * Does not re-read targets. Parallel mkdir + temp writes; sequential renames.
 */
async function preparedConcurrentTransaction(prepared, concurrency) {
  const parentDirs = [...new Set(prepared.map((p) => path.dirname(p.abs)))];
  await mapWithConcurrency(parentDirs, concurrency, async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  });

  const temps = new Map();
  await mapWithConcurrency(prepared, concurrency, async (item) => {
    const temp = path.join(
      path.dirname(item.abs),
      `.${path.basename(item.abs)}.benchp-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
    );
    await fs.writeFile(temp, item.buffer, { flag: "wx" });
    temps.set(item.abs, temp);
  });

  try {
    for (const item of prepared) {
      await fs.rename(temps.get(item.abs), item.abs);
      temps.delete(item.abs);
    }
  } finally {
    await Promise.allSettled([...temps.values()].map((t) => fs.unlink(t)));
  }
}

async function directOverwrite(abs, content) {
  await fs.writeFile(abs, content, "utf8");
}

function localDiff(oldText, newText, relPath, maxChars = 60_000) {
  if (oldText === newText) return { diff: `No changes`, additions: 0, deletions: 0 };
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const additions = Math.max(0, newLines.length - suffix - prefix);
  const deletions = Math.max(0, oldLines.length - suffix - prefix);
  let diff = `--- a/${relPath}\n+++ b/${relPath}\n@@ ... @@\n`;
  for (let i = prefix; i < oldLines.length - suffix; i += 1) diff += `-${oldLines[i]}\n`;
  for (let i = prefix; i < newLines.length - suffix; i += 1) diff += `+${newLines[i]}\n`;
  if (diff.length > maxChars) diff = diff.slice(0, maxChars);
  return { diff, additions, deletions };
}

async function timeAsync(fn, runs = 3) {
  const samples = [];
  // warmup
  await fn();
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
    samples
  };
}

async function main() {
  const benchRoot = path.join(repoRoot, ".ai-bridge", "bench", `write-perf-${Date.now()}`);
  await fs.mkdir(benchRoot, { recursive: true });
  const results = {
    createdAt: new Date().toISOString(),
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "default",
    node: process.version,
    platform: process.platform,
    scenarios: []
  };

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  try {
    // --- Transaction comparison matrix ---
    for (const count of FILE_COUNTS) {
      for (const size of FILE_SIZES.filter((s) => s <= 64 * 1024 || count <= 20)) {
        for (const concurrency of CONCURRENCIES) {
          const seqDir = path.join(benchRoot, `seq-${count}-${size}-${concurrency}`);
          const parDir = path.join(benchRoot, `par-${count}-${size}-${concurrency}`);
          await fs.mkdir(seqDir, { recursive: true });
          await fs.mkdir(parDir, { recursive: true });

          const files = Array.from({ length: count }, (_, i) => ({
            rel: `f${String(i).padStart(4, "0")}.ts`,
            content: deterministicContent(size, i)
          }));

          // Pre-create for overwrite path and capture originals once (preflight).
          const parPreparedBase = [];
          for (const f of files) {
            const seqAbs = path.join(seqDir, f.rel);
            const parAbs = path.join(parDir, f.rel);
            const seedContent = deterministicContent(size, iSeed(f.rel));
            await fs.mkdir(path.dirname(seqAbs), { recursive: true });
            await fs.mkdir(path.dirname(parAbs), { recursive: true });
            await fs.writeFile(seqAbs, seedContent, "utf8");
            await fs.writeFile(parAbs, seedContent, "utf8");
            parPreparedBase.push({
              abs: parAbs,
              original: Buffer.from(seedContent, "utf8")
            });
          }

          // Precompute alternating immutable generations OUTSIDE timed sections.
          // Alternating A/B avoids "same content" renames without re-encoding mid-timer.
          const seqGenA = files.map((f, i) => ({
            rel: f.rel,
            content: deterministicContent(size, i + 10_000)
          }));
          const seqGenB = files.map((f, i) => ({
            rel: f.rel,
            content: deterministicContent(size, i + 20_000)
          }));
          const parGenA = parPreparedBase.map((base, i) => ({
            abs: base.abs,
            buffer: Buffer.from(deterministicContent(size, i + 30_000), "utf8"),
            original: base.original
          }));
          const parGenB = parPreparedBase.map((base, i) => ({
            abs: base.abs,
            buffer: Buffer.from(deterministicContent(size, i + 40_000), "utf8"),
            original: base.original
          }));
          let seqToggle = 0;
          let parToggle = 0;

          const before = mem();
          const seqTiming = await timeAsync(async () => {
            const gen = seqToggle++ % 2 === 0 ? seqGenA : seqGenB;
            await sequentialTransaction(seqDir, gen);
          }, quick ? 2 : 3);

          const parTiming = await timeAsync(async () => {
            const gen = parToggle++ % 2 === 0 ? parGenA : parGenB;
            await preparedConcurrentTransaction(gen, concurrency);
          }, quick ? 2 : 3);
          const after = mem();

          const totalBytes = count * size;
          const speedup = seqTiming.p50 > 0 ? seqTiming.p50 / parTiming.p50 : 0;
          const scenario = {
            kind: "atomic_multi_write",
            files: count,
            sizeBytes: size,
            concurrency,
            sequential_ms: seqTiming,
            prepared_concurrent_ms: parTiming,
            speedup_p50: Number(speedup.toFixed(2)),
            files_per_sec_par: Number(((count / (parTiming.p50 / 1000))).toFixed(1)),
            mb_per_sec_par: Number(((totalBytes / 1e6) / (parTiming.p50 / 1000)).toFixed(2)),
            rss_before: before.rss,
            rss_after: after.rss,
            heap_before: before.heapUsed,
            heap_after: after.heapUsed
          };
          results.scenarios.push(scenario);
        }
      }
    }

    // --- Large overwrite + local diff (suffix-only change keeps O(n) prefix scan cheap) ---
    for (const size of quick ? [510 * 1024] : [490 * 1024, 510 * 1024, 900 * 1024]) {
      const dir = path.join(benchRoot, `large-${size}`);
      await fs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, "big.ts");
      const base = deterministicContent(size - 64, 1);
      const oldContent = base + "OLD_MARKER_" + "x".repeat(32);
      const newContent = base + "NEW_MARKER_" + "y".repeat(32);
      await fs.writeFile(abs, oldContent, "utf8");

      const writeTiming = await timeAsync(async () => {
        await directOverwrite(abs, newContent);
        await directOverwrite(abs, oldContent);
      }, quick ? 2 : 3);

      const diffTiming = await timeAsync(async () => {
        localDiff(oldContent, newContent, "big.ts");
      }, quick ? 3 : 5);

      const hashTiming = await timeAsync(async () => {
        createHash("sha256").update(Buffer.from(newContent, "utf8")).digest("hex");
      }, quick ? 3 : 5);

      results.scenarios.push({
        kind: "large_overwrite_local",
        sizeBytes: size,
        direct_write_ms: writeTiming,
        local_diff_ms: diffTiming,
        hash_ms: hashTiming,
        estimated_full_path_ms: {
          p50: Number((writeTiming.p50 / 2 + diffTiming.p50 + hashTiming.p50).toFixed(3))
        }
      });
    }

    // --- Summary vs full-diff cost (local simulation, new file) ---
    {
      const size = quick ? 16 * 1024 : 100 * 1024;
      const oldC = "";
      const newC = deterministicContent(size, 42);
      const summaryTiming = await timeAsync(async () => {
        const buf = Buffer.from(newC, "utf8");
        createHash("sha256").update(buf).digest("hex");
        // no diff
      }, 5);
      const fullTiming = await timeAsync(async () => {
        const buf = Buffer.from(newC, "utf8");
        createHash("sha256").update(buf).digest("hex");
        localDiff(oldC, newC, "game.ts");
      }, 5);
      const fullDiff = localDiff(oldC, newC, "game.ts");
      results.scenarios.push({
        kind: "response_mode_cost",
        sizeBytes: size,
        summary_ms: summaryTiming,
        full_diff_ms: fullTiming,
        full_diff_bytes: Buffer.byteLength(fullDiff.diff, "utf8"),
        summary_response_bytes_estimate: 350,
        // Current contract: preview in structured only; text stays metadata-sized.
        full_response_structured_preview_bytes: Buffer.byteLength(fullDiff.diff, "utf8"),
        full_response_text_estimate_bytes: 400,
        legacy_duplicated_response_bytes_estimate: Buffer.byteLength(fullDiff.diff, "utf8") * 2
      });
    }

    histogram.disable();
    results.event_loop = {
      min_ns: histogram.min,
      max_ns: histogram.max,
      mean_ns: histogram.mean,
      p99_ns: histogram.percentile(99)
    };
  } finally {
    await fs.rm(benchRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  if (jsonOnly) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("Least write-performance benchmark");
  console.log(`UV_THREADPOOL_SIZE=${results.uvThreadpoolSize} node=${results.node}`);
  console.log("");
  console.log("| kind | files | size | conc | seq p50 | par p50 | speedup | files/s |");
  console.log("|------|------:|-----:|-----:|--------:|--------:|--------:|--------:|");
  for (const s of results.scenarios) {
    if (s.kind !== "atomic_multi_write") continue;
    console.log(
      `| atomic | ${s.files} | ${s.sizeBytes} | ${s.concurrency} | ${s.sequential_ms.p50.toFixed(2)} | ${s.prepared_concurrent_ms.p50.toFixed(2)} | ${s.speedup_p50}× | ${s.files_per_sec_par} |`
    );
  }
  console.log("");
  for (const s of results.scenarios) {
    if (s.kind === "large_overwrite_local") {
      console.log(
        `large ${s.sizeBytes}B: write p50=${s.direct_write_ms.p50.toFixed(2)}ms local_diff p50=${s.local_diff_ms.p50.toFixed(2)}ms hash p50=${s.hash_ms.p50.toFixed(2)}ms est=${s.estimated_full_path_ms.p50}ms`
      );
    }
    if (s.kind === "response_mode_cost") {
      console.log(
        `response_mode ${s.sizeBytes}B: summary p50=${s.summary_ms.p50.toFixed(2)}ms full p50=${s.full_diff_ms.p50.toFixed(2)}ms full_diff_bytes=${s.full_diff_bytes}`
      );
    }
  }
  console.log("");
  console.log("--- JSON ---");
  console.log(JSON.stringify(results, null, 2));
}

function iSeed(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 10_000;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
