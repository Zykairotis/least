/**
 * Shared mutation response modes and helpers.
 * Separates mutation execution from diff-return policy.
 */

export type MutationResponseMode = "summary" | "compact_diff" | "full_diff";

export type DiffComputeMode = "none" | "compact" | "full";

/** Visible preview bounds (never used as the storage ceiling). */
export const COMPACT_DIFF_MAX_CHARS = 12_000;
export const FULL_DIFF_MAX_CHARS = 60_000;

/**
 * Generate/storage ceiling for complete unified diffs destined for the output store.
 * Kept at or below typical LEAST_OUTPUT_STORE_MAX_ITEM_BYTES (5_242_880).
 */
export const STORAGE_DIFF_MAX_CHARS = 5_000_000;

export const MUTATION_RESPONSE_MODES: readonly MutationResponseMode[] = [
  "summary",
  "compact_diff",
  "full_diff"
] as const;

export function isMutationResponseMode(value: unknown): value is MutationResponseMode {
  return value === "summary" || value === "compact_diff" || value === "full_diff";
}

/**
 * Resolve response_mode with include_diff compatibility.
 * - response_mode takes precedence when present
 * - include_diff: false → summary
 * - include_diff: true → full_diff
 * - default from tool when neither is set
 */
export function mutationResponseModeFromArgs(
  args: Record<string, unknown>,
  defaultMode: MutationResponseMode
): MutationResponseMode {
  const mode = args.response_mode;
  if (isMutationResponseMode(mode)) return mode;
  if (typeof args.include_diff === "boolean") {
    return args.include_diff ? "full_diff" : "summary";
  }
  return defaultMode;
}

export function diffComputeModeFromResponseMode(mode: MutationResponseMode): DiffComputeMode {
  if (mode === "summary") return "none";
  if (mode === "compact_diff") return "compact";
  return "full";
}

export function maxDiffCharsForMode(mode: MutationResponseMode, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  if (mode === "compact_diff") return COMPACT_DIFF_MAX_CHARS;
  return FULL_DIFF_MAX_CHARS;
}

export interface MutationDiffMeta {
  /** Line stats when computed; null when summary omitted them. */
  additions: number | null;
  deletions: number | null;
  changed: boolean;
  /** Whether line stats were computed. */
  statsComputed: boolean;
  /** Visible preview (bounded). Prefer structuredContent.diff_preview only. */
  preview?: string;
  /** Complete (or storage-capped) diff for output-store retrieval. */
  storageDiff?: string;
  /** True when the storage/complete diff hit a size cap. */
  storageTruncated?: boolean;
  /** True when storageDiff is complete relative to STORAGE_DIFF_MAX_CHARS. */
  complete?: boolean;
  /** True when the visible preview was truncated. */
  truncated?: boolean;
  /** @deprecated use preview — kept for older call sites */
  diff?: string;
}

export interface PreparedTextContent {
  text: string;
  buffer: Buffer;
  bytes: number;
  sha256: string;
}

export function emptyDiffMeta(): MutationDiffMeta {
  return {
    additions: null,
    deletions: null,
    changed: false,
    statsComputed: false
  };
}

export interface CombinedDiffParts {
  text: string;
  truncated: boolean;
  includedParts: number;
  omittedParts: number;
  bytes: number;
}

/**
 * Incrementally combine multi-file diff parts under a UTF-8 byte budget.
 * Stops before exceeding maxBytes (does not concat-then-slice whole payloads).
 */
export function combineDiffParts(parts: string[], maxBytes: number): CombinedDiffParts {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (!parts.length || limit <= 0) {
    return { text: "", truncated: parts.length > 0, includedParts: 0, omittedParts: parts.length, bytes: 0 };
  }
  const sep = "\n\n";
  const sepBytes = Buffer.byteLength(sep, "utf8");
  const out: string[] = [];
  let total = 0;
  let truncated = false;
  let i = 0;
  for (; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    const partBytes = Buffer.byteLength(part, "utf8");
    const extra = out.length ? sepBytes : 0;
    if (total + extra + partBytes <= limit) {
      out.push(part);
      total += extra + partBytes;
      continue;
    }
    // Fit a prefix of this part if nothing is included yet, or room remains.
    const remaining = limit - total - extra;
    if (remaining > 64) {
      const prefix = Buffer.from(part, "utf8").subarray(0, Math.max(0, remaining - 48)).toString("utf8");
      const marker = "\n...[combined diff truncated]";
      const candidate = prefix + marker;
      if (Buffer.byteLength(candidate, "utf8") <= remaining) {
        out.push(candidate);
        total += extra + Buffer.byteLength(candidate, "utf8");
      }
    }
    truncated = true;
    break;
  }
  // Count remaining non-empty parts as omitted when we stopped early.
  let omitted = 0;
  if (truncated) {
    for (let j = i; j < parts.length; j += 1) {
      if (parts[j]) omitted += 1;
    }
    // The partial first overflow part was counted in the break loop as omitted once.
    // If we included a truncated prefix, that part was still "included" as truncated.
    if (out.length && i < parts.length && parts[i]) {
      // i points at the part we partially included or skipped
      const last = out[out.length - 1] ?? "";
      if (last.includes("[combined diff truncated]")) omitted = Math.max(0, omitted - 1);
    }
  }
  const text = out.join(sep);
  return {
    text,
    truncated,
    includedParts: out.length,
    omittedParts: omitted,
    bytes: Buffer.byteLength(text, "utf8")
  };
}
