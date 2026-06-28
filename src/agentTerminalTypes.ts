import type { AgentTerminalBackendId, AgentTerminalMetadata } from "./agentTypes.js";

export interface TerminalBackendDetection {
  backend: AgentTerminalBackendId;
  available: boolean;
  version?: string;
  detail?: string;
  warnings: string[];
  capabilities?: Record<string, boolean>;
}

export interface TerminalTailOptions {
  lines?: number;
  includeAnsi?: boolean;
}

export type TerminalTailSource = "zellij" | "tmux" | "logs" | "none";

export interface TerminalTailResult {
  job_id: string;
  task_id: string;
  source: TerminalTailSource;
  text: string;
  lines: number;
  truncated: boolean;
  target?: string;
  session_name?: string;
  pane_id?: string;
  attempted_targets: string[];
  attach_hint?: string;
  watch_hint?: string;
  tail_hint?: string;
  error?: string;
}

export interface AgentTerminalSession {
  backend: AgentTerminalBackendId;
  sessionName?: string;
  paneId?: string;
  tabId?: number;
  tabName?: string;
  title?: string;
  command?: string;
  cwd?: string;
  exited?: boolean;
  exitStatus?: number | null;
  attachCommand?: string;
  watchCommand?: string;
  tailCommand?: string;
  source?: "discovered" | "job" | "logs";
}

export interface AttachHintResult {
  job_id: string;
  task_id: string;
  backend: AgentTerminalBackendId;
  terminal?: AgentTerminalMetadata;
  attach_commands: string[];
  watch_commands: string[];
  tail_commands: string[];
  fallback_commands: string[];
  warnings: string[];
}
