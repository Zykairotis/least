import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { LeastError } from "./guard.js";
import { recordBackend, recordChildProcessSpawn, recordChildProcessTiming, recordPartial, recordTimedOut } from "./perf.js";
import { ToolTimeoutError } from "./timeout.js";

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
  timedOut: boolean;
}

export interface ProcessRunOptions {
  cwd: string;
  args: string[];
  command: string;
  maxOutputBytes: number;
  signal?: AbortSignal;
  backend?: string;
  allowNonZeroExit?: boolean;
}

export interface StreamLinesOptions {
  cwd: string;
  args: string[];
  command: string;
  maxLines: number;
  signal?: AbortSignal;
  backend?: string;
  bufferLines?: number;
}

export interface StreamLinesResult {
  lines: string[];
  truncated: boolean;
  timedOut: boolean;
  code: number | null;
}

export async function streamProcessLines(options: StreamLinesOptions): Promise<StreamLinesResult> {
  recordChildProcessSpawn(options.command);
  if (options.backend) recordBackend(options.backend);
  const started = performance.now();
  const buffer = Math.max(0, options.bufferLines ?? 4);
  const target = options.maxLines + buffer;

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" }
    });
    const lines: string[] = [];
    let pending = "";
    let truncated = false;
    let settled = false;

    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      recordChildProcessTiming(performance.now() - started);
      const timedOut = Boolean(options.signal?.aborted && options.signal.reason instanceof ToolTimeoutError);
      if (timedOut) recordTimedOut();
      if (timedOut || truncated) recordPartial();
      resolve({ lines, truncated, timedOut, code });
    };

    const pushLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      lines.push(trimmed);
      if (lines.length >= target) {
        truncated = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => {
      pending += String(chunk);
      let idx = pending.indexOf("\n");
      while (idx >= 0) {
        pushLine(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
        idx = pending.indexOf("\n");
        if (truncated) break;
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      recordChildProcessTiming(performance.now() - started);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (pending.trim() && !truncated) pushLine(pending);
      finalize(code);
    });
  });
}

export async function runCappedProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  recordChildProcessSpawn(options.command);
  if (options.backend) recordBackend(options.backend);
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" }
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const remainingBudget = () => Math.max(0, options.maxOutputBytes - stdoutBytes - stderrBytes);
    const appendChunk = (current: string, chunk: Buffer | string, assign: (value: string, bytes: number) => void, currentBytes: number) => {
      if (truncated) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const budget = remainingBudget();
      if (budget <= 0) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      const chunkBytes = Buffer.byteLength(text, "utf8");
      if (chunkBytes <= budget) {
        assign(current + text, currentBytes + chunkBytes);
        return;
      }
      let low = 0;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) low = mid;
        else high = mid - 1;
      }
      const slice = text.slice(0, low);
      assign(current + slice, currentBytes + Buffer.byteLength(slice, "utf8"));
      truncated = true;
      child.kill("SIGTERM");
    };

    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      recordChildProcessTiming(performance.now() - started);
      const timedOut = Boolean(options.signal?.aborted && options.signal.reason instanceof ToolTimeoutError);
      if (timedOut) recordTimedOut();
      if (timedOut || truncated) recordPartial();
      if (!options.allowNonZeroExit && !timedOut && !truncated && code && code !== 0) {
        reject(new LeastError(stderr.trim() || stdout.trim() || `${options.command} exited with status ${code}`));
        return;
      }
      resolve({ stdout, stderr, code, signal, truncated, timedOut });
    };

    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      appendChunk(stdout, chunk, (value, bytes) => {
        stdout = value;
        stdoutBytes = bytes;
      }, stdoutBytes);
    });
    child.stderr.on("data", (chunk) => {
      appendChunk(stderr, chunk, (value, bytes) => {
        stderr = value;
        stderrBytes = bytes;
      }, stderrBytes);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      recordChildProcessTiming(performance.now() - started);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      finalize(code, signal);
    });
  });
}
