#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function mergePath(parts) {
  return [...new Set(parts.flatMap((chunk) => chunk.split(path.delimiter)).map((entry) => entry.trim()).filter(Boolean))].join(path.delimiter);
}

function repoRootDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function nativeZellijDir() {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const zellijDir = path.join(localAppData, "Zellij");
  return fs.existsSync(path.join(zellijDir, "zellij.exe")) ? zellijDir : undefined;
}

function groundcrewBinDir() {
  const groundcrewBin = path.join(repoRootDir(), "scripts", "groundcrew-bin");
  return fs.existsSync(groundcrewBin) ? groundcrewBin : undefined;
}

export function refreshWindowsPath() {
  if (process.platform !== "win32") return process.env.PATH ?? "";
  const parts = [process.env.PATH ?? "", process.env.Path ?? "", process.env.path ?? ""];
  const zellijDir = nativeZellijDir();
  if (zellijDir) parts.unshift(zellijDir);
  process.env.PATH = mergePath(parts);
  return process.env.PATH;
}

/** Groundcrew zellij tabs spawn POSIX `sh`; prefer WSL shims ahead of native zellij. */
export function refreshGroundcrewWindowsPath() {
  if (process.platform !== "win32") return refreshWindowsPath();
  const parts = [process.env.PATH ?? "", process.env.Path ?? "", process.env.path ?? ""];
  const zellijDir = nativeZellijDir();
  if (zellijDir) parts.unshift(zellijDir);
  const shimDir = groundcrewBinDir();
  if (shimDir) parts.push(shimDir);
  process.env.PATH = mergePath(parts);
  return process.env.PATH;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("ensure-windows-agent-path.mjs")) {
  refreshWindowsPath();
}
