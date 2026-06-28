import path from "node:path";
import { classifyPath, type ReviewFileKind } from "./reviewOps.js";

export type ContextProfile = "explore" | "edit" | "debug" | "review";

export interface ContextSignalScores {
  queryHitScore: number;
  exactSymbolScore: number;
  pathNameScore: number;
  importNeighborScore: number;
  gitChangedScore: number;
  testAdjacencyScore: number;
  packageScriptScore: number;
  memoryScore: number;
  recentCommitScore: number;
  sizePenalty: number;
  generatedPenalty: number;
}

export interface RankedFile {
  path: string;
  score: number;
  reason: string;
  scoreBreakdown: Partial<ContextSignalScores>;
  kind: ReviewFileKind;
}

const GENERATED_KINDS = new Set<ReviewFileKind>(["generated", "lockfile", "binary", "large"]);

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((token) => token.length >= 2);
}

function isTestPath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return base.includes(".test.") || base.includes(".spec.") || relPath.includes("/__tests__/");
}

function profileWeights(profile: ContextProfile): Partial<Record<keyof ContextSignalScores, number>> {
  switch (profile) {
    case "explore":
      return { pathNameScore: 1.2, packageScriptScore: 1.5, queryHitScore: 1.0, generatedPenalty: 1.5 };
    case "edit":
      return { exactSymbolScore: 2.0, queryHitScore: 1.5, gitChangedScore: 1.2, testAdjacencyScore: 1.0 };
    case "debug":
      return { queryHitScore: 1.8, gitChangedScore: 1.5, testAdjacencyScore: 1.4, exactSymbolScore: 1.2 };
    case "review":
      return { gitChangedScore: 2.5, testAdjacencyScore: 1.2, packageScriptScore: 1.3 };
    default:
      return {};
  }
}

export function rankContextFiles(input: {
  task: string;
  query?: string;
  profile?: ContextProfile;
  candidates: string[];
  changedFiles?: string[];
  memoryPaths?: string[];
  importNeighbors?: string[];
  fileSizes?: Map<string, number>;
}): RankedFile[] {
  const profile = input.profile ?? "edit";
  const weights = profileWeights(profile);
  const taskTokens = tokenize(input.task);
  const queryTokens = tokenize(input.query ?? "");
  const changed = new Set(input.changedFiles ?? []);
  const memory = new Set(input.memoryPaths ?? []);
  const neighbors = new Set(input.importNeighbors ?? []);

  const ranked = input.candidates.map((relPath) => {
    const normalized = relPath.replace(/\\/g, "/");
    const base = path.basename(normalized).toLowerCase();
    const kind = classifyPath(normalized);
    const breakdown: Partial<ContextSignalScores> = {};

    breakdown.pathNameScore = normalized.includes("src/") ? 4 : normalized.startsWith("docs/") ? 2 : 0;
    if (base === "package.json" || base === "readme.md") breakdown.packageScriptScore = 8;
    for (const token of [...taskTokens, ...queryTokens]) {
      if (token.length >= 3 && normalized.includes(token)) breakdown.pathNameScore = (breakdown.pathNameScore ?? 0) + 2;
      if (token.length >= 3 && base.replace(/\.[^.]+$/, "") === token) breakdown.exactSymbolScore = (breakdown.exactSymbolScore ?? 0) + 12;
    }
    if (changed.has(normalized)) breakdown.gitChangedScore = 10;
    if (isTestPath(normalized)) breakdown.testAdjacencyScore = profile === "review" || profile === "debug" ? 6 : 3;
    if (neighbors.has(normalized)) breakdown.importNeighborScore = 5;
    if (memory.has(normalized)) breakdown.memoryScore = 7;
    if (GENERATED_KINDS.has(kind)) breakdown.generatedPenalty = 12;
    const size = input.fileSizes?.get(normalized);
    if (size && size > 120_000) breakdown.sizePenalty = 4;

    let score = 0;
    for (const [key, value] of Object.entries(breakdown) as Array<[keyof ContextSignalScores, number]>) {
      const weight = weights[key] ?? 1;
      if (key.endsWith("Penalty")) score -= value * weight;
      else score += value * weight;
    }

    const reasons: string[] = [];
    if (breakdown.exactSymbolScore) reasons.push("exact symbol/path match");
    if (breakdown.gitChangedScore) reasons.push("git changed");
    if (breakdown.testAdjacencyScore) reasons.push("test file");
    if (breakdown.importNeighborScore) reasons.push("import neighbor");
    if (breakdown.memoryScore) reasons.push("project memory");
    if (breakdown.packageScriptScore) reasons.push("package/docs anchor");
    if (!reasons.length) reasons.push("candidate path");

    return { path: normalized, score, reason: reasons.join(", "), scoreBreakdown: breakdown, kind };
  });

  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export function suggestedNextCalls(profile: ContextProfile, ranked: RankedFile[]): string[] {
  const top = ranked[0]?.path;
  switch (profile) {
    case "explore":
      return ["read_many on top matched source files", top ? `read_around ${top}` : "project_map", "search_context for symbols"];
    case "edit":
      return ["multi_edit or apply_patch on top file", "show_changes after edits", top ? `bash test command` : "context_pack profile=debug on failure"];
    case "debug":
      return ["bash test/lint with compact output", "retrieve_output if log compacted", "read_changed_files"];
    case "review":
      return ["show_changes summary_only=false", "read_changed_files include_untracked=false", "diff_summary"];
    default:
      return ["context_pack", "read_many"];
  }
}