import type { OutputCompactorInput, OutputCompactorResult } from "../outputShaper.js";
import { compactText } from "./textCompactor.js";

const FAIL_RE = /(?:FAIL|✖|×|failed|AssertionError|Expected|Received|error TS\d+|✗)/i;
const TEST_NAME_RE = /(?:✓|✗|×|PASS|FAIL)\s+(.+)|(?:FAIL|PASS)\s+(.+)/;
const STACK_RE = /^\s+at\s+/;

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = STACK_RE.test(line) ? line.replace(/\(\d+:\d+\)/, "(?:)") : line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function compactTestLog(input: OutputCompactorInput, maxVisibleBytes: number): OutputCompactorResult {
  const rawBytes = input.rawBytes;
  const exitCode = input.exitCode;
  const failed = Boolean(input.timedOut) || (typeof exitCode === "number" && exitCode !== 0);
  const lines = input.text.split("\n");

  if (!failed && Buffer.byteLength(input.text, "utf8") > maxVisibleBytes) {
    const tail = lines.slice(-8).join("\n");
    const content = `Command succeeded. Output compacted (${rawBytes} raw bytes).\n\nLast lines:\n${tail}`;
    const visibleBytes = Buffer.byteLength(content, "utf8");
    return {
      content,
      summary: "Success summary",
      mode: "compact",
      rawBytes,
      visibleBytes,
      savedBytes: Math.max(0, rawBytes - visibleBytes),
      reason: "success compaction",
      warnings: []
    };
  }

  if (!failed) {
    return compactText(input, maxVisibleBytes);
  }

  const failingTests: string[] = [];
  const errors: string[] = [];
  const stacks: string[] = [];
  let inExpected = false;
  const expectedBlocks: string[] = [];

  for (const line of lines) {
    const testMatch = line.match(TEST_NAME_RE);
    if (testMatch && FAIL_RE.test(line)) {
      failingTests.push((testMatch[1] ?? testMatch[2] ?? line).trim());
    }
    if (FAIL_RE.test(line)) errors.push(line);
    if (STACK_RE.test(line)) stacks.push(line);
    if (/Expected:|Received:/i.test(line)) {
      inExpected = true;
      expectedBlocks.push(line);
    } else if (inExpected && (line.trim() === "" || /^=+$/.test(line))) {
      inExpected = false;
    } else if (inExpected) {
      expectedBlocks.push(line);
    }
  }

  const parts = [
    `Test/log compaction: exit=${exitCode ?? "null"}${input.timedOut ? " (timed out)" : ""}`,
    failingTests.length ? `\nFailing tests:\n${[...new Set(failingTests)].slice(0, 12).map((t) => `  - ${t}`).join("\n")}` : "",
    errors.length ? `\nErrors:\n${dedupeLines(errors).slice(0, 15).join("\n")}` : "",
    expectedBlocks.length ? `\nExpected/Received:\n${expectedBlocks.slice(0, 20).join("\n")}` : "",
    stacks.length ? `\nStack (workspace frames):\n${dedupeLines(stacks).slice(0, 12).join("\n")}` : "",
    `\nFinal summary:\n${lines.slice(-6).join("\n")}`
  ];
  let content = parts.filter(Boolean).join("\n");
  if (Buffer.byteLength(content, "utf8") > maxVisibleBytes) {
    content = content.slice(0, maxVisibleBytes) + "\n...[test log compact truncated]";
  }
  const visibleBytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    summary: `${failingTests.length} failing tests preserved`,
    mode: "compact",
    rawBytes,
    visibleBytes,
    savedBytes: Math.max(0, rawBytes - visibleBytes),
    reason: "failure preservation",
    warnings: []
  };
}

export function detectShellLogKind(command: string | undefined): "test_log" | "tsc_log" | "lint_log" | "text" {
  const cmd = (command ?? "").toLowerCase().trim();
  if (/(?:npm test|pnpm test|yarn test|bun test|pytest|go test|cargo test|vitest|jest)/.test(cmd)) return "test_log";
  if (/(?:tsc|typecheck|npm run typecheck|pnpm run typecheck)/.test(cmd)) return "tsc_log";
  if (/(?:eslint|biome|ruff|clippy|lint)/.test(cmd)) return "lint_log";
  return "text";
}