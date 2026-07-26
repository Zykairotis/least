import { Worker } from "node:worker_threads";
import { recordBackend } from "./perf.js";

/**
 * Offload only when combined payload is large enough that CPU cost exceeds
 * worker startup + structured-clone cost. Normal write max is 1 MB, so
 * typical write/edit diffs stay local and avoid the ~25–50 ms cold-worker cliff.
 */
const DIFF_OFFLOAD_THRESHOLD_BYTES = 4_000_000;
const PROJECT_MAP_OFFLOAD_FILES = 250;
const PROJECT_MAP_OFFLOAD_BYTES = 500_000;

type UnifiedDiffResult = { diff: string; additions: number; deletions: number; changed: boolean };

let workerSpawnCount = 0;

export function getWorkerSpawnCount(): number {
  return workerSpawnCount;
}

export function resetWorkerSpawnCount(): void {
  workerSpawnCount = 0;
}

function runWorkerTask<TInput extends object, TOutput>(payload: TInput): Promise<TOutput> {
  return new Promise((resolve, reject) => {
    workerSpawnCount += 1;
    const worker = new Worker(new URL("./workerTask.js", import.meta.url));
    worker.once("message", (message: TOutput | { __workerError: string }) => {
      worker.terminate().catch(() => {});
      if (message && typeof message === "object" && "__workerError" in message) {
        reject(new Error(message.__workerError));
        return;
      }
      recordBackend("worker");
      resolve(message as TOutput);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
    worker.postMessage(payload);
  });
}

export function shouldOffloadUnifiedDiff(oldText: string, newText: string): boolean {
  return Buffer.byteLength(oldText, "utf8") + Buffer.byteLength(newText, "utf8") > DIFF_OFFLOAD_THRESHOLD_BYTES;
}

export function getDiffOffloadThresholdBytes(): number {
  return DIFF_OFFLOAD_THRESHOLD_BYTES;
}

export async function offloadedUnifiedDiff(
  oldText: string,
  newText: string,
  relPath: string,
  maxChars: number
): Promise<UnifiedDiffResult> {
  return runWorkerTask({
    kind: "unifiedDiff",
    oldText,
    newText,
    relPath,
    maxChars
  });
}

export function shouldOffloadProjectMap(fileCount: number, totalBytes: number): boolean {
  return fileCount > PROJECT_MAP_OFFLOAD_FILES || totalBytes > PROJECT_MAP_OFFLOAD_BYTES;
}

export async function offloadedProjectMapSymbols(
  files: Array<{ path: string; text: string }>,
  options: { includeImports: boolean; includeExports: boolean }
): Promise<Array<{ name: string; kind: string; path: string; line?: number }>> {
  return runWorkerTask({
    kind: "projectMapChunk",
    files,
    includeImports: options.includeImports,
    includeExports: options.includeExports
  });
}
