export type AgentLifecycleState =
  | "planned"
  | "accepted"
  | "provisioning"
  | "recovery-required"
  | "orphaned"
  | "running"
  | "completed"
  | "resumed"
  | "interrupted"
  | "failed-to-launch"
  | "timeout-soft"
  | "timeout-hard"
  | "cancelled"
  | "missing"
  | "unknown";

export type AgentTerminalBackendId = "zellij" | "tmux" | "logs" | "none";

export type AgentLaunchPhase =
  | "accepted"
  | "provisioning"
  | "groundcrew-setup"
  | "terminal-detected"
  | "recovery-required"
  | "orphaned"
  | "running"
  | "completed"
  | "failed";

export interface AgentLaunchState {
  phase: AgentLaunchPhase;
  acceptedAt?: string;
  startedAt?: string;
  setupStartedAt?: string;
  setupFinishedAt?: string;
  lastUpdateAt?: string;
  error?: string;
}

export interface AgentTerminalMetadata {
  backend: AgentTerminalBackendId;
  sessionName?: string;
  paneId?: string;
  tabId?: number;
  tabName?: string;
  paneTitle?: string;
  paneCommand?: string;
  paneCwd?: string;
  attachCommand?: string;
  watchCommand?: string;
  tailCommand?: string;
  stdoutLog?: string;
  stderrLog?: string;
  eventsLog?: string;
  exited?: boolean;
  exitStatus?: number | null;
  inferred?: boolean;
  warnings?: string[];
}

export interface AgentWatchdogState {
  deadlineAt: string;
  idleDeadlineAt: string;
  lastActivityAt: string;
  lastOutputAt?: string;
  lastOutputHash?: string;
  lastRunStateHash?: string;
  lastCheckedAt?: string;
  timedOutAt?: string;
  timeoutReason?: "wall-clock" | "idle";
  interruptAttemptedAt?: string;
  interruptError?: string;
}

export interface AgentJobRecord {
  jobId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  workspaceRoot: string;
  agent: string;
  repository: string;
  title: string;
  promptFile: string;
  state: AgentLifecycleState;
  idempotencyKey?: string;
  requestHash?: string;
  launch?: AgentLaunchState;
  timeoutMs: number;
  idleTimeoutMs: number;
  watchdog?: AgentWatchdogState;
  groundcrew?: {
    worktreeDir?: string;
    branchName?: string;
    workspaceName?: string;
    runState?: Record<string, unknown>;
  };
  terminal?: AgentTerminalMetadata;
  detail?: string;
}

export interface AgentPlanInput {
  workspaceId: string;
  workspaceRoot: string;
  agent?: string;
  repository: string;
  title: string;
  prompt: string;
  mode?: string;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export interface AgentStartInput extends AgentPlanInput {
  taskId?: string;
  idempotencyKey?: string;
  waitForLaunch?: boolean;
  startupWaitMs?: number;
}

export interface AgentStatusInput {
  workspaceId: string;
  workspaceRoot: string;
  jobId?: string;
  taskId?: string;
  enforceTimeouts?: boolean;
}

export interface AgentCancelInput extends AgentStatusInput {
  reason?: string;
}

export interface AgentResumeInput extends AgentStatusInput {
  fresh?: boolean;
}

export interface AgentCleanupInput {
  workspaceId: string;
  workspaceRoot: string;
  jobId?: string;
  taskId?: string;
  olderThan?: string;
  dryRun?: boolean;
  cleanWorktrees?: boolean;
  force?: boolean;
}

export interface GroundcrewRuntime {
  loadConfig: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  setupWorkspace: (config: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>;
  interruptWorkspace: (config: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>;
  readRunState: (config: Record<string, unknown>, task: string) => Record<string, unknown> | undefined;
  resumeWorkspace?: (config: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>;
  cleanupWorkspace?: (config: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>;
}
