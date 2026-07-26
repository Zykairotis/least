import type { LeastConfig } from "./config.js";
import { recordCompaction } from "./perf.js";
import { storeToolOutput } from "./toolOutputStore.js";
import { compactText } from "./outputCompactors/textCompactor.js";
import { compactSearch } from "./outputCompactors/searchCompactor.js";
import { compactGitDiff } from "./outputCompactors/gitDiffCompactor.js";
import { compactShowChanges } from "./outputCompactors/showChangesCompactor.js";
import { compactTestLog, detectShellLogKind } from "./outputCompactors/testLogCompactor.js";
import { compactJson } from "./outputCompactors/jsonCompactor.js";

export type OutputKind =
  | "search"
  | "git_diff"
  | "git_status"
  | "show_changes"
  | "test_log"
  | "lint_log"
  | "tsc_log"
  | "json"
  | "code"
  | "text";

export type OutputMode = "raw" | "compact" | "compressed";

export interface OutputShapeOptions {
  mode?: OutputMode;
  maxVisibleBytes: number;
  preserveLines?: boolean;
  retrievalEnabled?: boolean;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface OutputCompactorInput {
  kind: OutputKind;
  text: string;
  rawBytes: number;
  toolName: string;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface OutputCompactorResult {
  content: string;
  summary?: string;
  mode: "raw" | "compact" | "truncated";
  rawBytes: number;
  visibleBytes: number;
  savedBytes: number;
  reason: string;
  warnings: string[];
}

export interface ShapedOutputMeta {
  mode: "raw" | "compact" | "truncated";
  rawBytes: number;
  visibleBytes: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  savedBytes: number;
  savedTokensEstimate: number;
  retrievalKey?: string;
  retrievalHint?: string;
  compacted: boolean;
  summary?: string;
  reason?: string;
}

const RAW_THRESHOLD_BYTES = 8_192;

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function compactionEnabledForKind(config: LeastConfig, kind: OutputKind): boolean {
  if (kind === "search") return config.compactSearch;
  if (kind === "git_diff") return config.compactGitDiff;
  if (kind === "test_log" || kind === "lint_log" || kind === "tsc_log" || kind === "text") return config.compactShell;
  if (kind === "show_changes" || kind === "git_status") return true;
  return false;
}

function shouldCompact(config: LeastConfig, kind: OutputKind, rawBytes: number, mode?: OutputMode): boolean {
  const effectiveMode = mode ?? config.outputMode;
  if (rawBytes < RAW_THRESHOLD_BYTES) return false;
  if (effectiveMode === "raw") return false;
  if (effectiveMode === "compressed") return true;
  if (effectiveMode === "compact") return compactionEnabledForKind(config, kind);
  return false;
}

function runCompactor(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
  switch (input.kind) {
    case "search":
      return compactSearch(input, maxVisibleBytes);
    case "git_diff":
      return compactGitDiff(input, maxVisibleBytes);
    case "show_changes":
    case "git_status":
      return compactShowChanges(input, maxVisibleBytes);
    case "test_log":
    case "lint_log":
    case "tsc_log":
      return compactTestLog(input, maxVisibleBytes);
    case "json":
      return compactJson(input, maxVisibleBytes);
    default:
      return compactText(input, maxVisibleBytes);
  }
}

export async function shapeTextOutput(
  config: LeastConfig,
  input: OutputCompactorInput,
  options: OutputShapeOptions
): Promise<{ content: string; meta: ShapedOutputMeta }> {
  const rawBytes = input.rawBytes || Buffer.byteLength(input.text, "utf8");
  const maxVisible = options.maxVisibleBytes;

  if (!shouldCompact(config, input.kind, rawBytes, options.mode)) {
    const visibleBytes = Buffer.byteLength(input.text, "utf8");
    const meta: ShapedOutputMeta = {
      mode: "raw",
      rawBytes,
      visibleBytes,
      estimatedTokensBefore: estimateTokens(rawBytes),
      estimatedTokensAfter: estimateTokens(visibleBytes),
      savedBytes: 0,
      savedTokensEstimate: 0,
      compacted: false
    };
    recordCompaction({ rawBytes, visibleBytes, savedBytes: 0, compacted: false, fallback: false, kind: input.kind, toolName: input.toolName });
    return { content: input.text, meta };
  }

  const result = runCompactor(input, maxVisible);
  const fallback = result.visibleBytes >= rawBytes;
  const finalContent = fallback ? input.text : result.content;
  const visibleBytes = fallback ? rawBytes : result.visibleBytes;
  const savedBytes = fallback ? 0 : result.savedBytes;
  const mode = fallback ? "raw" : result.mode;

  let retrievalKey: string | undefined;
  if (!fallback && options.retrievalEnabled !== false && options.workspaceId && options.workspaceRoot && (mode === "compact" || mode === "truncated")) {
    retrievalKey = await storeToolOutput(config, options.workspaceRoot, options.workspaceId, input.toolName, input.kind, input.text, visibleBytes);
  }

  const meta: ShapedOutputMeta = {
    mode,
    rawBytes,
    visibleBytes,
    estimatedTokensBefore: estimateTokens(rawBytes),
    estimatedTokensAfter: estimateTokens(visibleBytes),
    savedBytes,
    savedTokensEstimate: estimateTokens(rawBytes) - estimateTokens(visibleBytes),
    retrievalKey,
    retrievalHint: retrievalKey ? `retrieve_output({ key: "${retrievalKey}" })` : undefined,
    compacted: !fallback,
    summary: result.summary,
    reason: fallback ? "compactor fallback" : result.reason
  };

  recordCompaction({
    rawBytes,
    visibleBytes,
    savedBytes,
    compacted: !fallback,
    fallback,
    kind: input.kind,
    toolName: input.toolName,
    retrievalKeyPresent: Boolean(retrievalKey)
  });

  return { content: finalContent, meta };
}

export function shellKindFromCommand(command: string): OutputKind {
  return detectShellLogKind(command);
}