import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type PerfWindowName = "session" | "lifetime";

interface ToolInvocationMetrics {
  toolName: string;
  workspaceId?: string;
  startedAt: number;
  totalMs: number;
  guardMs: number;
  fsMs: number;
  childProcessMs: number;
  childProcessSpawnCount: number;
  outputBytes: number;
  rawBytes: number;
  modelVisibleBytes: number;
  structuredBytes: number;
  savedBytes: number;
  compacted: boolean;
  compactionFallbacks: number;
  retrievalKeyPresent: boolean;
  cacheHits: number;
  cacheMisses: number;
  timedOut: boolean;
  partial: boolean;
  error: boolean;
  backends: Set<string>;
}

interface ToolAggregate {
  toolName: string;
  calls: number;
  errors: number;
  timeouts: number;
  partials: number;
  cacheHits: number;
  cacheMisses: number;
  childProcessSpawnCount: number;
  totalMs: number;
  guardMs: number;
  fsMs: number;
  childProcessMs: number;
  outputBytes: number;
  rawBytes: number;
  modelVisibleBytes: number;
  structuredBytes: number;
  savedBytes: number;
  compactions: number;
  compactionFallbacks: number;
  retrievals: number;
  maxOutputBytes: number;
  maxRawBytes: number;
  maxVisibleBytes: number;
  maxDurationMs: number;
  backends: Set<string>;
  durations: number[];
}

interface CompactionEvent {
  toolName: string;
  kind: string;
  rawBytes: number;
  visibleBytes: number;
  savedBytes: number;
  compacted: boolean;
  fallback: boolean;
  retrievalKeyPresent?: boolean;
}

interface GainWindowState {
  rawBytesProcessed: number;
  visibleBytesEmitted: number;
  savedBytes: number;
  compactions: number;
  compactionFallbacks: number;
  retrievals: number;
  byToolKind: Map<string, { rawBytes: number; visibleBytes: number; savedBytes: number }>;
  missedCompactionTools: Map<string, number>;
  largeRawNoCompactor: Map<string, number>;
}

interface PerfWindowState {
  startedAt: number;
  tools: Map<string, ToolAggregate>;
  gain: GainWindowState;
  slowestCalls: Array<{ tool: string; durationMs: number; workspaceId?: string; timedOut: boolean; partial: boolean }>;
  largestOutputs: Array<{ tool: string; outputBytes: number; rawBytes: number; modelVisibleBytes: number; structuredBytes: number }>;
  largestVisibleOutputs: Array<{ tool: string; rawBytes: number; modelVisibleBytes: number; savedBytes: number }>;
}

const MAX_SAMPLES_PER_TOOL = 256;
const MAX_TOP_CALLS = 12;
const perfContext = new AsyncLocalStorage<ToolInvocationMetrics>();

function createGainState(): GainWindowState {
  return {
    rawBytesProcessed: 0,
    visibleBytesEmitted: 0,
    savedBytes: 0,
    compactions: 0,
    compactionFallbacks: 0,
    retrievals: 0,
    byToolKind: new Map(),
    missedCompactionTools: new Map(),
    largeRawNoCompactor: new Map()
  };
}

function createWindowState(): PerfWindowState {
  return {
    startedAt: Date.now(),
    tools: new Map(),
    gain: createGainState(),
    slowestCalls: [],
    largestOutputs: [],
    largestVisibleOutputs: []
  };
}

let sessionState = createWindowState();
let lifetimeState = createWindowState();

function currentInvocation(): ToolInvocationMetrics | undefined {
  return perfContext.getStore();
}

function trimTop<T>(items: T[], compare: (left: T, right: T) => number): T[] {
  items.sort(compare);
  if (items.length > MAX_TOP_CALLS) {
    items.length = MAX_TOP_CALLS;
  }
  return items;
}

function recordInvocation(windowState: PerfWindowState, invocation: ToolInvocationMetrics): void {
  const existing = windowState.tools.get(invocation.toolName);
  const aggregate: ToolAggregate =
    existing ??
    {
      toolName: invocation.toolName,
      calls: 0,
      errors: 0,
      timeouts: 0,
      partials: 0,
      cacheHits: 0,
      cacheMisses: 0,
      childProcessSpawnCount: 0,
      totalMs: 0,
      guardMs: 0,
      fsMs: 0,
      childProcessMs: 0,
      outputBytes: 0,
      rawBytes: 0,
      modelVisibleBytes: 0,
      structuredBytes: 0,
      savedBytes: 0,
      compactions: 0,
      compactionFallbacks: 0,
      retrievals: 0,
      maxOutputBytes: 0,
      maxRawBytes: 0,
      maxVisibleBytes: 0,
      maxDurationMs: 0,
      backends: new Set<string>(),
      durations: []
    };
  aggregate.calls += 1;
  if (invocation.error) aggregate.errors += 1;
  if (invocation.timedOut) aggregate.timeouts += 1;
  if (invocation.partial) aggregate.partials += 1;
  aggregate.cacheHits += invocation.cacheHits;
  aggregate.cacheMisses += invocation.cacheMisses;
  aggregate.childProcessSpawnCount += invocation.childProcessSpawnCount;
  aggregate.totalMs += invocation.totalMs;
  aggregate.guardMs += invocation.guardMs;
  aggregate.fsMs += invocation.fsMs;
  aggregate.childProcessMs += invocation.childProcessMs;
  aggregate.outputBytes += invocation.outputBytes;
  aggregate.rawBytes += invocation.rawBytes;
  aggregate.modelVisibleBytes += invocation.modelVisibleBytes;
  aggregate.structuredBytes += invocation.structuredBytes;
  aggregate.savedBytes += invocation.savedBytes;
  if (invocation.compacted) aggregate.compactions += 1;
  aggregate.compactionFallbacks += invocation.compactionFallbacks;
  if (invocation.retrievalKeyPresent) aggregate.retrievals += 1;
  aggregate.maxOutputBytes = Math.max(aggregate.maxOutputBytes, invocation.outputBytes);
  aggregate.maxRawBytes = Math.max(aggregate.maxRawBytes, invocation.rawBytes);
  aggregate.maxVisibleBytes = Math.max(aggregate.maxVisibleBytes, invocation.modelVisibleBytes);
  aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, invocation.totalMs);
  for (const backend of invocation.backends) aggregate.backends.add(backend);
  aggregate.durations.push(invocation.totalMs);
  if (aggregate.durations.length > MAX_SAMPLES_PER_TOOL) {
    aggregate.durations.splice(0, aggregate.durations.length - MAX_SAMPLES_PER_TOOL);
  }
  windowState.tools.set(invocation.toolName, aggregate);

  windowState.slowestCalls = trimTop(
    [
      ...windowState.slowestCalls,
      {
        tool: invocation.toolName,
        durationMs: invocation.totalMs,
        workspaceId: invocation.workspaceId,
        timedOut: invocation.timedOut,
        partial: invocation.partial
      }
    ],
    (left, right) => right.durationMs - left.durationMs
  );
  windowState.largestOutputs = trimTop(
    [
      ...windowState.largestOutputs,
      {
        tool: invocation.toolName,
        outputBytes: invocation.outputBytes,
        rawBytes: invocation.rawBytes,
        modelVisibleBytes: invocation.modelVisibleBytes,
        structuredBytes: invocation.structuredBytes
      }
    ],
    (left, right) => right.outputBytes - left.outputBytes
  );
  windowState.largestVisibleOutputs = trimTop(
    [
      ...windowState.largestVisibleOutputs,
      {
        tool: invocation.toolName,
        rawBytes: invocation.rawBytes,
        modelVisibleBytes: invocation.modelVisibleBytes,
        savedBytes: invocation.savedBytes
      }
    ],
    (left, right) => right.modelVisibleBytes - left.modelVisibleBytes
  );
}

function recordGainEvent(windowState: PerfWindowState, event: CompactionEvent): void {
  const gain = windowState.gain;
  gain.rawBytesProcessed += event.rawBytes;
  gain.visibleBytesEmitted += event.visibleBytes;
  gain.savedBytes += event.savedBytes;
  if (event.compacted) gain.compactions += 1;
  if (event.fallback) gain.compactionFallbacks += 1;
  if (event.retrievalKeyPresent) gain.retrievals += 1;
  const bucketKey = `${event.toolName}:${event.kind}`;
  const bucket = gain.byToolKind.get(bucketKey) ?? { rawBytes: 0, visibleBytes: 0, savedBytes: 0 };
  bucket.rawBytes += event.rawBytes;
  bucket.visibleBytes += event.visibleBytes;
  bucket.savedBytes += event.savedBytes;
  gain.byToolKind.set(bucketKey, bucket);
  if (event.rawBytes >= 8192 && !event.compacted) {
    gain.largeRawNoCompactor.set(event.toolName, (gain.largeRawNoCompactor.get(event.toolName) ?? 0) + 1);
  }
  if (event.fallback) {
    gain.missedCompactionTools.set(event.toolName, (gain.missedCompactionTools.get(event.toolName) ?? 0) + 1);
  }
}

export function recordCompaction(event: CompactionEvent): void {
  const invocation = currentInvocation();
  if (invocation) {
    invocation.rawBytes = Math.max(invocation.rawBytes, event.rawBytes);
    invocation.modelVisibleBytes = event.visibleBytes;
    invocation.savedBytes += event.savedBytes;
    invocation.compacted = invocation.compacted || event.compacted;
    if (event.fallback) invocation.compactionFallbacks += 1;
    invocation.retrievalKeyPresent = invocation.retrievalKeyPresent || Boolean(event.retrievalKeyPresent);
  }
  recordGainEvent(sessionState, event);
  recordGainEvent(lifetimeState, event);
}

export function recordRetrieval(): void {
  const invocation = currentInvocation();
  if (invocation) invocation.retrievalKeyPresent = true;
  sessionState.gain.retrievals += 1;
  lifetimeState.gain.retrievals += 1;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function textFromUnknownContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function noteToolResultShape(result: unknown): void {
  const invocation = currentInvocation();
  if (!invocation || !result || typeof result !== "object") return;
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  const text = textFromUnknownContent(result);
  invocation.modelVisibleBytes = Buffer.byteLength(text, "utf8");
  // Prefer handler-supplied byte counts; only JSON.stringify when needed for large-result accounting sample.
  let usedHandlerBytes = false;
  if (record.isError === true) invocation.error = true;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const shape = structured as Record<string, unknown>;
    const backend = shape.used ?? shape.backend;
    if (typeof backend === "string" && backend) invocation.backends.add(backend);
    if (shape.partial === true) invocation.partial = true;
    if (shape.timed_out === true || shape.timedOut === true) invocation.timedOut = true;
    if (shape.cache_hit === true || shape.cacheHit === true) invocation.cacheHits += 1;
    if (shape.cache_miss === true || shape.cacheMiss === true) invocation.cacheMisses += 1;
    const rawBytes = shape.rawBytes ?? shape.raw_bytes;
    if (typeof rawBytes === "number" && Number.isFinite(rawBytes)) invocation.rawBytes = Math.max(invocation.rawBytes, rawBytes);
    const visibleBytes = shape.visibleBytes ?? shape.visible_bytes ?? shape.model_visible_bytes;
    if (typeof visibleBytes === "number" && Number.isFinite(visibleBytes)) {
      invocation.modelVisibleBytes = visibleBytes;
      usedHandlerBytes = true;
    }
    const structuredBytesHint = shape.structuredBytes ?? shape.structured_bytes;
    if (typeof structuredBytesHint === "number" && Number.isFinite(structuredBytesHint)) {
      invocation.structuredBytes = structuredBytesHint;
      usedHandlerBytes = true;
    }
    const outputBytesHint = shape.outputBytes ?? shape.output_bytes;
    if (typeof outputBytesHint === "number" && Number.isFinite(outputBytesHint)) {
      invocation.outputBytes = outputBytesHint;
      usedHandlerBytes = true;
    }
    const savedBytes = shape.savedBytes ?? shape.saved_bytes;
    if (typeof savedBytes === "number" && Number.isFinite(savedBytes)) invocation.savedBytes += savedBytes;
    if (shape.compacted === true) invocation.compacted = true;
    if (shape.retrievalKeyPresent === true || shape.retrieval_key) invocation.retrievalKeyPresent = true;
    const outputMeta = shape.output_meta;
    if (outputMeta && typeof outputMeta === "object" && !Array.isArray(outputMeta)) {
      const meta = outputMeta as Record<string, unknown>;
      if (typeof meta.rawBytes === "number") invocation.rawBytes = Math.max(invocation.rawBytes, meta.rawBytes);
      if (typeof meta.visibleBytes === "number") {
        invocation.modelVisibleBytes = meta.visibleBytes;
        usedHandlerBytes = true;
      }
      if (typeof meta.savedBytes === "number") invocation.savedBytes += meta.savedBytes;
      if (meta.compacted === true) invocation.compacted = true;
      if (meta.retrievalKey) invocation.retrievalKeyPresent = true;
    }
  }
  // Avoid full JSON.stringify of large structured/content payloads when handlers already
  // reported visible/output sizes. Sample expensive accounting only when needed.
  if (!usedHandlerBytes || invocation.structuredBytes === 0) {
    if (structured && typeof structured === "object") {
      // Cheap structural estimate: prefer model-visible text length over full re-serialize.
      invocation.structuredBytes = invocation.structuredBytes || invocation.modelVisibleBytes;
    }
  }
  if (!usedHandlerBytes || invocation.outputBytes === 0) {
    invocation.outputBytes = invocation.outputBytes || invocation.modelVisibleBytes + invocation.structuredBytes;
  }
  if (!invocation.rawBytes) invocation.rawBytes = invocation.modelVisibleBytes;
}

export async function measuredToolCall<T>(toolName: string, workspaceId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const invocation: ToolInvocationMetrics = {
    toolName,
    workspaceId,
    startedAt: performance.now(),
    totalMs: 0,
    guardMs: 0,
    fsMs: 0,
    childProcessMs: 0,
    childProcessSpawnCount: 0,
    outputBytes: 0,
    rawBytes: 0,
    modelVisibleBytes: 0,
    structuredBytes: 0,
    savedBytes: 0,
    compacted: false,
    compactionFallbacks: 0,
    retrievalKeyPresent: false,
    cacheHits: 0,
    cacheMisses: 0,
    timedOut: false,
    partial: false,
    error: false,
    backends: new Set<string>()
  };
  return perfContext.run(invocation, async () => {
    try {
      const result = await fn();
      noteToolResultShape(result);
      return result;
    } catch (error) {
      invocation.error = true;
      throw error;
    } finally {
      invocation.totalMs = performance.now() - invocation.startedAt;
      recordInvocation(sessionState, invocation);
      recordInvocation(lifetimeState, invocation);
    }
  });
}

function addTiming(field: "guardMs" | "fsMs" | "childProcessMs", durationMs: number): void {
  const invocation = currentInvocation();
  if (!invocation || !Number.isFinite(durationMs) || durationMs <= 0) return;
  invocation[field] += durationMs;
}

export function recordGuardTiming(durationMs: number): void {
  addTiming("guardMs", durationMs);
}

export function recordFsTiming(durationMs: number): void {
  addTiming("fsMs", durationMs);
}

export function recordChildProcessTiming(durationMs: number): void {
  addTiming("childProcessMs", durationMs);
}

export function recordChildProcessSpawn(backend?: string): void {
  const invocation = currentInvocation();
  if (!invocation) return;
  invocation.childProcessSpawnCount += 1;
  if (backend) invocation.backends.add(backend);
}

export function recordCacheOutcome(hit: boolean): void {
  const invocation = currentInvocation();
  if (!invocation) return;
  if (hit) invocation.cacheHits += 1;
  else invocation.cacheMisses += 1;
}

export function recordBackend(backend: string): void {
  const invocation = currentInvocation();
  if (!invocation || !backend) return;
  invocation.backends.add(backend);
}

export function recordTimedOut(): void {
  const invocation = currentInvocation();
  if (!invocation) return;
  invocation.timedOut = true;
}

export function recordPartial(): void {
  const invocation = currentInvocation();
  if (!invocation) return;
  invocation.partial = true;
}

export function getLeastPerfSnapshot(windowName: PerfWindowName = "session"): Record<string, unknown> {
  const state = windowName === "lifetime" ? lifetimeState : sessionState;
  const tools = [...state.tools.values()]
    .map((tool) => ({
      tool: tool.toolName,
      calls: tool.calls,
      errors: tool.errors,
      timeouts: tool.timeouts,
      partials: tool.partials,
      avg_ms: Math.round((tool.totalMs / Math.max(1, tool.calls)) * 100) / 100,
      p95_ms: Math.round(percentile(tool.durations, 95) * 100) / 100,
      max_ms: Math.round(tool.maxDurationMs * 100) / 100,
      guard_ms_avg: Math.round((tool.guardMs / Math.max(1, tool.calls)) * 100) / 100,
      fs_ms_avg: Math.round((tool.fsMs / Math.max(1, tool.calls)) * 100) / 100,
      child_process_ms_avg: Math.round((tool.childProcessMs / Math.max(1, tool.calls)) * 100) / 100,
      cache_hit_rate:
        tool.cacheHits + tool.cacheMisses > 0
          ? Math.round((tool.cacheHits / (tool.cacheHits + tool.cacheMisses)) * 1000) / 1000
          : undefined,
      child_process_spawn_count: tool.childProcessSpawnCount,
      avg_output_bytes: Math.round(tool.outputBytes / Math.max(1, tool.calls)),
      max_output_bytes: tool.maxOutputBytes,
      avg_raw_bytes: Math.round(tool.rawBytes / Math.max(1, tool.calls)),
      max_raw_bytes: tool.maxRawBytes,
      avg_model_visible_bytes: Math.round(tool.modelVisibleBytes / Math.max(1, tool.calls)),
      max_model_visible_bytes: tool.maxVisibleBytes,
      avg_saved_bytes: Math.round(tool.savedBytes / Math.max(1, tool.calls)),
      total_saved_bytes: tool.savedBytes,
      compactions: tool.compactions,
      compaction_fallbacks: tool.compactionFallbacks,
      retrievals: tool.retrievals,
      avg_structured_bytes: Math.round(tool.structuredBytes / Math.max(1, tool.calls)),
      backends: [...tool.backends].sort()
    }))
    .sort((left, right) => right.p95_ms - left.p95_ms || right.avg_ms - left.avg_ms);

  const totals = tools.reduce(
    (acc, tool) => {
      acc.calls += Number(tool.calls ?? 0);
      acc.errors += Number(tool.errors ?? 0);
      acc.timeouts += Number(tool.timeouts ?? 0);
      acc.partials += Number(tool.partials ?? 0);
      acc.child_process_spawn_count += Number(tool.child_process_spawn_count ?? 0);
      return acc;
    },
    { calls: 0, errors: 0, timeouts: 0, partials: 0, child_process_spawn_count: 0 }
  );

  return {
    window: windowName,
    started_at: new Date(state.startedAt).toISOString(),
    totals,
    tools,
    slowest_calls: state.slowestCalls.map((item) => ({
      tool: item.tool,
      duration_ms: Math.round(item.durationMs * 100) / 100,
      workspace_id: item.workspaceId,
      timed_out: item.timedOut,
      partial: item.partial
    })),
    largest_outputs: state.largestOutputs.map((item) => ({
      tool: item.tool,
      output_bytes: item.outputBytes,
      raw_bytes: item.rawBytes,
      model_visible_bytes: item.modelVisibleBytes,
      structured_bytes: item.structuredBytes
    })),
    largest_visible_outputs: state.largestVisibleOutputs.map((item) => ({
      tool: item.tool,
      raw_bytes: item.rawBytes,
      model_visible_bytes: item.modelVisibleBytes,
      saved_bytes: item.savedBytes
    })),
    gain: {
      raw_bytes_processed: state.gain.rawBytesProcessed,
      visible_bytes_emitted: state.gain.visibleBytesEmitted,
      saved_bytes: state.gain.savedBytes,
      estimated_token_reduction:
        state.gain.rawBytesProcessed > 0
          ? Math.round((1 - state.gain.visibleBytesEmitted / state.gain.rawBytesProcessed) * 1000) / 1000
          : 0,
      compactions: state.gain.compactions,
      compaction_fallbacks: state.gain.compactionFallbacks,
      retrievals: state.gain.retrievals,
      top_savers: [...state.gain.byToolKind.entries()]
        .map(([key, value]) => ({ key, ...value }))
        .sort((a, b) => b.savedBytes - a.savedBytes)
        .slice(0, 8)
    }
  };
}

export function getGainSnapshot(windowName: PerfWindowName = "session"): Record<string, unknown> {
  const state = windowName === "lifetime" ? lifetimeState : sessionState;
  const gain = state.gain;
  return {
    window: windowName,
    raw_bytes_processed: gain.rawBytesProcessed,
    visible_bytes_emitted: gain.visibleBytesEmitted,
    saved_bytes: gain.savedBytes,
    estimated_visible_token_reduction:
      gain.rawBytesProcessed > 0 ? Math.round((1 - gain.visibleBytesEmitted / gain.rawBytesProcessed) * 1000) / 10 : 0,
    top_savers: [...gain.byToolKind.entries()]
      .map(([key, value]) => ({ key, raw_bytes: value.rawBytes, visible_bytes: value.visibleBytes, saved_bytes: value.savedBytes }))
      .sort((a, b) => b.saved_bytes - a.saved_bytes)
      .slice(0, 10),
    retrievals_used: gain.retrievals,
    compactor_fallbacks: gain.compactionFallbacks
  };
}

export function getDiscoverSnapshot(windowName: PerfWindowName = "session"): Record<string, unknown> {
  const state = windowName === "lifetime" ? lifetimeState : sessionState;
  const gain = state.gain;
  const recommendations: string[] = [];
  const largeNoCompactor = [...gain.largeRawNoCompactor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (largeNoCompactor.length) {
    recommendations.push(`Tools with large raw output and no compaction: ${largeNoCompactor.map(([t, c]) => `${t}(${c})`).join(", ")}`);
  }
  const missed = [...gain.missedCompactionTools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (missed.length) {
    recommendations.push(`Repeated compactor fallbacks: ${missed.map(([t, c]) => `${t}(${c})`).join(", ")}`);
  }
  const lowCacheTools = [...state.tools.values()]
    .filter((tool) => tool.cacheHits + tool.cacheMisses >= 3 && tool.cacheHits / (tool.cacheHits + tool.cacheMisses) < 0.3)
    .map((tool) => tool.toolName);
  if (lowCacheTools.length) {
    recommendations.push(`Low cache-hit tools (unstable args?): ${lowCacheTools.join(", ")}`);
  }
  const heavyReaders = [...state.tools.values()]
    .filter((tool) => tool.toolName === "read" && tool.calls >= 4)
    .map((tool) => `read called ${tool.calls} times — consider read_many or context_pack`);
  recommendations.push(...heavyReaders);
  const searchThenRead = state.tools.get("search")?.calls && state.tools.get("read")?.calls;
  if (searchThenRead && (state.tools.get("search")?.calls ?? 0) >= 2 && (state.tools.get("read")?.calls ?? 0) >= 3) {
    recommendations.push("Repeated search + read pattern — prefer search_context or context_pack");
  }
  if (!state.tools.get("context_pack")?.calls && state.tools.get("search")?.calls) {
    recommendations.push("search used without context_pack — try context_pack first for non-trivial tasks");
  }
  return {
    window: windowName,
    missed_opportunities: {
      large_raw_no_compactor: largeNoCompactor.map(([tool, count]) => ({ tool, count })),
      compactor_fallbacks: missed.map(([tool, count]) => ({ tool, count })),
      low_cache_hit_tools: lowCacheTools
    },
    recommendations: recommendations.slice(0, 8)
  };
}

export function resetLeastPerf(windowName: PerfWindowName = "session"): void {
  if (windowName === "lifetime") {
    lifetimeState = createWindowState();
    return;
  }
  sessionState = createWindowState();
}
