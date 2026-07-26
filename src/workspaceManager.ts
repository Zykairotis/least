import type { LeastConfig } from "./config.js";
import { WorkspaceManager } from "./guard.js";

const workspaceManagers = new Map<string, WorkspaceManager>();

function workspaceManagerKey(config: LeastConfig): string {
  return JSON.stringify({
    defaultRoot: config.defaultRoot,
    allowedRoots: [...config.allowedRoots].sort(),
    contextDir: config.contextDir
  });
}

export function getSharedWorkspaceManager(config: LeastConfig): WorkspaceManager {
  const key = workspaceManagerKey(config);
  const existing = workspaceManagers.get(key);
  if (existing) return existing;
  const manager = new WorkspaceManager(config);
  workspaceManagers.set(key, manager);
  return manager;
}