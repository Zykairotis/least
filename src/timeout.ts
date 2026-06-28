import { recordTimedOut } from "./perf.js";

export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number
  ) {
    super(`Timed out after ${timeoutMs}ms.`);
    this.name = "ToolTimeoutError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("Operation aborted.");
}

export async function withTimeout<T>(toolName: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let hardTimer: NodeJS.Timeout | undefined;
  let recordedTimeout = false;
  const recordTimeoutOnce = () => {
    if (recordedTimeout) return;
    recordedTimeout = true;
    recordTimedOut();
  };
  const softTimer = setTimeout(() => {
    const error = new ToolTimeoutError(toolName, timeoutMs);
    recordTimeoutOnce();
    controller.abort(error);
  }, timeoutMs);

  const hardStop = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => {
      const error = new ToolTimeoutError(toolName, timeoutMs);
      recordTimeoutOnce();
      reject(error);
    }, timeoutMs + 250);
  });

  try {
    return await Promise.race([fn(controller.signal), hardStop]);
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}
