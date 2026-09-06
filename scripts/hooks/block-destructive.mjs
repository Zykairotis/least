#!/usr/bin/env node
/**
 * Least PreBash / PreToolUse(bash) safety hook.
 *
 * Blocks catastrophic shell patterns inspired by Claude Code deny rules
 * (~/.claude/settings.json) while still allowing trusted local tooling
 * such as agent-browser under --yolo.
 *
 * Stdin:  JSON hook payload
 * Stdout: { decision: "allow"|"deny", reason?: string }
 */
import { createInterface } from "node:readline";

async function readStdinJson() {
  const chunks = [];
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    chunks.push(line);
  }
  const raw = chunks.join("\n").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _parseError: true, raw };
  }
}

function compact(command) {
  return String(command ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/** @type {Array<{ re: RegExp, reason: string }>} */
const RULES = [
  // Claude-style system deletes
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/|\/\*|~\/\*|~(\s|$)|\/etc|\/var|\/usr|\/boot|\/bin|\/sbin|\/lib|\/sys|\/proc|\/dev)/i, reason: "rm -rf of system/home root paths" },
  { re: /\brm\s+-[^\n]*\s+\/\s*$/i, reason: "rm targeting filesystem root" },
  { re: /\brm\s+-[^\n]*\s+\/\*/i, reason: "rm of /*" },
  // Disk destruction
  { re: /\bmkfs(\.|$|\s)/i, reason: "mkfs filesystem format" },
  { re: /\bwipefs\b/i, reason: "wipefs" },
  { re: /\bdd\b[^\n]*\bif=/i, reason: "dd if= raw device read/write" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "dd of=/dev/*" },
  { re: />\s*\/dev\/sd[a-z]/i, reason: "redirect into block device" },
  // Priv + remote code
  { re: /(^|\s)(sudo|doas)\s+/i, reason: "privilege escalation (sudo/doas)" },
  { re: /(^|\s)su\s+/i, reason: "privilege escalation (su)" },
  { re: /curl\b[^|\n]*\|\s*(ba)?sh\b/i, reason: "curl | sh remote code execution" },
  { re: /wget\b[^|\n]*\|\s*(ba)?sh\b/i, reason: "wget | sh remote code execution" },
  { re: /(^|\s)eval\s+/i, reason: "eval of arbitrary code" },
  // Destructive git
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { re: /\bgit\s+push\b[^\n]*--force\b/i, reason: "git push --force" },
  { re: /\bgit\s+push\b[^\n]*\s-f(\s|$)/i, reason: "git push -f" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: "git clean -f" },
  // System power / fork bomb
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "system power control" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
  // World-writable root
  { re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/i, reason: "chmod 777 /" },
  { re: /\bchown\s+-R\b[^\n]*\s\/(\s|$)/i, reason: "chown -R … /" }
];

function decide(payload) {
  if (payload?._parseError) {
    return { decision: "deny", reason: "Hook received invalid JSON payload." };
  }
  const toolName = payload?.toolName ?? "";
  const input = payload?.toolInput ?? {};
  // Only gate bash-shaped inputs.
  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : "";
  if (!command) {
    // Non-bash tools: allow (PreToolUse may match other tools if misconfigured).
    if (toolName && toolName !== "bash" && toolName !== "Bash") {
      return { decision: "allow" };
    }
    return { decision: "allow" };
  }

  const normalized = compact(command);
  for (const { re, reason } of RULES) {
    if (re.test(normalized)) {
      return {
        decision: "deny",
        reason: `Blocked destructive command (${reason}): ${normalized}`
      };
    }
  }
  return { decision: "allow" };
}

const payload = await readStdinJson();
process.stdout.write(`${JSON.stringify(decide(payload))}\n`);
