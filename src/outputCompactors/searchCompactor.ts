import type { OutputCompactorInput, OutputCompactorResult } from "../outputShaper.js";

interface FileGroup {
  path: string;
  snippets: Array<{ startLine: number; endLine: number; text: string }>;
  matchCount: number;
}

function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function parsePathLineText(line: string): { path: string; line: number; text: string } | null {
  const match = line.match(/:(\d+):\s(.*)$/);
  if (!match || match.index === undefined) return null;
  const path = line.slice(0, match.index);
  if (!path) return null;
  return { path, line: Number(match[1]), text: match[2] ?? "" };
}

function parseContextHeader(line: string): { path: string; line: number } | null {
  const header = line.match(/^###\s+(.+):(\d+)\s*$/);
  if (!header) return null;
  return { path: header[1] ?? "", line: Number(header[2]) };
}

function parseRangeHeader(line: string): { path: string; startLine: number; endLine: number; text: string } | null {
  const header = line.match(/^(.+)-(\d+)-(\d+):\s?(.*)$/);
  if (!header) return null;
  return {
    path: header[1] ?? "",
    startLine: Number(header[2]),
    endLine: Number(header[3]),
    text: header[4] ?? ""
  };
}

function addSnippet(group: FileGroup, startLine: number, endLine: number, text: string, isMatch: boolean): void {
  group.snippets.push({ startLine, endLine, text });
  if (isMatch) group.matchCount += 1;
}

function getGroup(groups: Map<string, FileGroup>, filePath: string): FileGroup {
  const group = groups.get(filePath) ?? { path: filePath, snippets: [], matchCount: 0 };
  groups.set(filePath, group);
  return group;
}

function parseSearchOutput(text: string): { groups: FileGroup[]; totalMatches: number } {
  const groups = new Map<string, FileGroup>();
  let currentPath = "";
  let totalMatches = 0;
  let inContextBlock = false;

  for (const rawLine of text.split("\n")) {
    const line = stripControlChars(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inContextBlock = false;
      currentPath = "";
      continue;
    }

    const contextHeader = parseContextHeader(trimmed);
    if (contextHeader) {
      currentPath = contextHeader.path;
      inContextBlock = true;
      const group = getGroup(groups, currentPath);
      addSnippet(group, contextHeader.line, contextHeader.line, "", false);
      continue;
    }

    const rangeHeader = parseRangeHeader(trimmed);
    if (rangeHeader) {
      currentPath = rangeHeader.path;
      inContextBlock = true;
      const group = getGroup(groups, currentPath);
      addSnippet(group, rangeHeader.startLine, rangeHeader.endLine, rangeHeader.text, false);
      continue;
    }

    const pathLine = parsePathLineText(trimmed);
    if (pathLine) {
      currentPath = pathLine.path;
      inContextBlock = false;
      const group = getGroup(groups, currentPath);
      addSnippet(group, pathLine.line, pathLine.line, pathLine.text, true);
      totalMatches += 1;
      continue;
    }

    if (inContextBlock && currentPath) {
      const contextLine = trimmed.match(/^(\d+)([-:])\s?(.*)$/);
      if (contextLine) {
        const lineNum = Number(contextLine[1]);
        const isMatch = contextLine[2] === ":";
        const group = getGroup(groups, currentPath);
        if (isMatch) {
          addSnippet(group, lineNum, lineNum, contextLine[3] ?? "", true);
          totalMatches += 1;
        } else {
          const last = group.snippets[group.snippets.length - 1];
          if (last) {
            last.endLine = Math.max(last.endLine, lineNum);
            last.text = last.text ? `${last.text}\n${trimmed}` : trimmed;
          } else {
            addSnippet(group, lineNum, lineNum, contextLine[3] ?? "", false);
          }
        }
        continue;
      }
      const group = getGroup(groups, currentPath);
      const last = group.snippets[group.snippets.length - 1];
      if (last) last.text += `\n${trimmed}`;
    }
  }

  return { groups: [...groups.values()], totalMatches };
}

function collapseSnippets(snippets: FileGroup["snippets"]): FileGroup["snippets"] {
  if (snippets.length <= 3) return snippets;
  const out: FileGroup["snippets"] = [snippets[0] as FileGroup["snippets"][number]];
  for (let i = 1; i < snippets.length; i += 1) {
    const prev = out[out.length - 1];
    const cur = snippets[i];
    if (!prev || !cur) continue;
    if (cur.startLine - prev.endLine <= 3) {
      prev.endLine = cur.endLine;
      prev.text += `\n${cur.text}`;
    } else {
      out.push(cur);
    }
  }
  return out.slice(0, 6);
}

export function compactSearch(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
  const cleaned = stripControlChars(input.text);
  const rawBytes = input.rawBytes;
  if (Buffer.byteLength(cleaned, "utf8") <= maxVisibleBytes) {
    return {
      content: cleaned,
      mode: "raw",
      rawBytes,
      visibleBytes: Buffer.byteLength(cleaned, "utf8"),
      savedBytes: 0,
      reason: "below threshold",
      warnings: []
    };
  }

  const { groups, totalMatches } = parseSearchOutput(cleaned);
  if (!groups.length) {
    return {
      content: cleaned.slice(0, maxVisibleBytes),
      mode: "truncated",
      rawBytes,
      visibleBytes: Math.min(rawBytes, maxVisibleBytes),
      savedBytes: Math.max(0, rawBytes - maxVisibleBytes),
      reason: "unparsed search output",
      warnings: []
    };
  }

  const sorted = groups.sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));
  const maxFiles = 12;
  const shown = sorted.slice(0, maxFiles);
  const omittedFiles = sorted.length - shown.length;
  const omittedMatches = sorted.slice(maxFiles).reduce((sum, g) => sum + g.matchCount, 0);

  const lines: string[] = [
    `Search compacted: ${totalMatches} matches in ${groups.length} files -> showing ${shown.length} files.`
  ];
  for (const group of shown) {
    lines.push("", `${group.path} - ${group.matchCount} matches`);
    for (const snippet of collapseSnippets(group.snippets)) {
      lines.push(`  L${snippet.startLine}-L${snippet.endLine}: ${snippet.text.split("\n")[0] ?? ""}`);
      const extra = snippet.text.split("\n").slice(1);
      if (extra.length) lines.push(`    ${extra.join("\n    ")}`);
    }
  }
  if (omittedFiles > 0) {
    lines.push("", `Omitted: ${omittedFiles} files, ${omittedMatches} matches. Use retrieve_output for the full result.`);
  }

  let content = lines.join("\n");
  if (Buffer.byteLength(content, "utf8") > maxVisibleBytes) {
    content = content.slice(0, maxVisibleBytes) + "\n...[search compact truncated]";
  }
  const visibleBytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    summary: `Showing ${shown.length}/${groups.length} files`,
    mode: "compact",
    rawBytes,
    visibleBytes,
    savedBytes: Math.max(0, rawBytes - visibleBytes),
    reason: "grouped by file",
    warnings: omittedFiles > 0 ? [`Omitted ${omittedFiles} files`] : []
  };
}