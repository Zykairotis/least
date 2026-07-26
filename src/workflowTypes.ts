import type { Workspace } from "./guard.js";

export type WorkflowAction = "plan" | "run" | "resume" | "status" | "cancel";
export type WorkflowStatus = "planned" | "awaiting_confirmation" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkflowSettings {
  enabled?: boolean;
  allowed?: string[];
  defaultDryRun?: boolean;
  maxStepsDefault?: number;
  maxStepsHardLimit?: number;
  requireConfirmationForBulk?: boolean;
  stateDir?: string;
  localMcpAllowlist?: Record<string, { enabled?: boolean; tools?: string[] }>;
}

export interface WorkflowRequest {
  action: WorkflowAction;
  workflowId: string;
  runId?: string;
  input: Record<string, unknown>;
  dryRun: boolean;
  maxSteps: number;
  confirm: boolean;
  confirmToken?: string;
}

export interface WorkflowStep {
  id: string;
  title: string;
  capability?: string;
  window?: string;
  sideEffect?: boolean;
  requiresConfirmation?: boolean;
  status?: "pending" | "done" | "skipped" | "blocked";
  detail?: Record<string, unknown>;
}

export interface WorkflowPlan {
  workflowId: string;
  title: string;
  summary: string;
  steps: WorkflowStep[];
  requiredCapabilities: string[];
  confirmationRequired: boolean;
  confirmationReason?: string;
  nextAction: string;
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown>;
  dryRun: boolean;
  completedSteps: string[];
  nextStepIndex: number;
  plan: WorkflowPlan;
  lastResult?: WorkflowRunResult;
  error?: string;
}

export interface WorkflowRunResult {
  workflowId: string;
  runId: string;
  status: WorkflowStatus;
  dryRun: boolean;
  stepsRun: WorkflowStep[];
  stepsRemaining: number;
  confirmationRequired: boolean;
  confirmationReason?: string;
  artifacts: Record<string, unknown>;
  verification: Array<Record<string, unknown>>;
  nextAction: string;
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  description: string;
  plan(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkflowPlan> | WorkflowPlan;
}

export interface WorkflowContext {
  workspace: Workspace;
  settings: Required<Pick<WorkflowSettings, "maxStepsDefault" | "maxStepsHardLimit" | "requireConfirmationForBulk">> & WorkflowSettings;
}

