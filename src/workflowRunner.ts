import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import { getWorkflowDefinition, listWorkflowDefinitions } from "./workflowRegistry.js";
import { appendWorkflowEvent, loadWorkflowState, makeWorkflowRunId, saveWorkflowState, workflowRunDir } from "./workflowState.js";
import type { WorkflowRequest, WorkflowRunResult, WorkflowRunState, WorkflowSettings, WorkflowStep } from "./workflowTypes.js";

export function effectiveWorkflowSettings(settings?: WorkflowSettings): Required<Pick<WorkflowSettings, "enabled" | "defaultDryRun" | "maxStepsDefault" | "maxStepsHardLimit" | "requireConfirmationForBulk" | "stateDir">> & WorkflowSettings {
  return {
    enabled: settings?.enabled ?? true,
    allowed: settings?.allowed ?? ["video-study"],
    defaultDryRun: settings?.defaultDryRun ?? true,
    maxStepsDefault: Math.max(1, Math.min(settings?.maxStepsDefault ?? 3, 50)),
    maxStepsHardLimit: Math.max(1, Math.min(settings?.maxStepsHardLimit ?? 20, 200)),
    requireConfirmationForBulk: settings?.requireConfirmationForBulk ?? true,
    stateDir: settings?.stateDir ?? ".ai-bridge/workflows",
    localMcpAllowlist: settings?.localMcpAllowlist ?? {}
  };
}

export function listWorkflows(settings?: WorkflowSettings): Array<Record<string, unknown>> {
  const effective = effectiveWorkflowSettings(settings);
  const allowed = new Set(effective.allowed ?? []);
  return listWorkflowDefinitions().map((workflow) => ({
    id: workflow.id,
    title: workflow.title,
    description: workflow.description,
    enabled: effective.enabled && (allowed.size === 0 || allowed.has(workflow.id))
  }));
}

export async function handleWorkflowRequest(workspace: Workspace, settings: WorkflowSettings | undefined, request: WorkflowRequest): Promise<WorkflowRunResult> {
  const effective = effectiveWorkflowSettings(settings);
  if (!effective.enabled) throw new LeastError("Workflows are disabled by settings.");
  const allowed = new Set(effective.allowed ?? []);
  if (allowed.size > 0 && !allowed.has(request.workflowId)) {
    throw new LeastError(`Workflow is not allowlisted: ${request.workflowId}`);
  }
  const workflow = getWorkflowDefinition(request.workflowId);
  if (!workflow) throw new LeastError(`Unknown workflow: ${request.workflowId}`);

  if (request.maxSteps > effective.maxStepsHardLimit) {
    throw new LeastError(`max_steps ${request.maxSteps} exceeds workflow hard limit ${effective.maxStepsHardLimit}.`);
  }

  if (request.action === "status") {
    if (!request.runId) throw new LeastError("workflow status requires run_id.");
    const state = await loadWorkflowState(workspace, effective, request.runId);
    return state.lastResult ?? resultFromState(workspace, effective, state, []);
  }

  if (request.action === "resume") {
    if (!request.runId) throw new LeastError("workflow resume requires run_id.");
    const state = await loadWorkflowState(workspace, effective, request.runId);
    return runState(workspace, effective, { ...state, dryRun: request.dryRun }, request);
  }

  if (request.action === "cancel") {
    if (!request.runId) throw new LeastError("workflow cancel requires run_id.");
    const state = await loadWorkflowState(workspace, effective, request.runId);
    state.status = "cancelled";
    state.updatedAt = new Date().toISOString();
    state.lastResult = resultFromState(workspace, effective, state, []);
    await saveWorkflowState(workspace, effective, state);
    await appendWorkflowEvent(workspace, effective, state.runId, { type: "cancelled" });
    return state.lastResult;
  }

  const plan = await workflow.plan(request.input, { workspace, settings: effective });
  const now = new Date().toISOString();
  const state: WorkflowRunState = {
    runId: request.runId || makeWorkflowRunId(workflow.id),
    workflowId: workflow.id,
    status: plan.confirmationRequired && !request.dryRun && !request.confirm ? "awaiting_confirmation" : "planned",
    createdAt: now,
    updatedAt: now,
    input: request.input,
    dryRun: request.dryRun,
    completedSteps: [],
    nextStepIndex: 0,
    plan
  };

  if (request.action === "plan" || state.status === "awaiting_confirmation") {
    state.lastResult = resultFromState(workspace, effective, state, []);
    await saveWorkflowState(workspace, effective, state);
    await appendWorkflowEvent(workspace, effective, state.runId, { type: request.action, status: state.status });
    return state.lastResult;
  }

  return runState(workspace, effective, state, request);
}

async function runState(workspace: Workspace, settings: WorkflowSettings, state: WorkflowRunState, request: WorkflowRequest): Promise<WorkflowRunResult> {
  if (state.plan.confirmationRequired && !state.dryRun && !request.confirm) {
    state.status = "awaiting_confirmation";
    state.updatedAt = new Date().toISOString();
    state.lastResult = resultFromState(workspace, settings, state, []);
    await saveWorkflowState(workspace, settings, state);
    return state.lastResult;
  }

  state.status = "running";
  const stepsRun: WorkflowStep[] = [];
  const max = Math.max(1, request.maxSteps);
  for (let i = state.nextStepIndex; i < state.plan.steps.length && stepsRun.length < max; i += 1) {
    const step = { ...state.plan.steps[i] };
    if (state.dryRun && step.sideEffect) {
      step.status = "skipped";
      step.detail = { ...(step.detail ?? {}), reason: "dry_run_side_effect_preview" };
    } else {
      step.status = "done";
      step.detail = { ...(step.detail ?? {}), dry_run: state.dryRun, simulated: true };
    }
    stepsRun.push(step);
    state.completedSteps.push(step.id);
    state.nextStepIndex = i + 1;
  }

  state.status = state.nextStepIndex >= state.plan.steps.length ? "completed" : "paused";
  state.updatedAt = new Date().toISOString();
  state.lastResult = resultFromState(workspace, settings, state, stepsRun);
  await saveWorkflowState(workspace, settings, state);
  await appendWorkflowEvent(workspace, settings, state.runId, { type: "run", status: state.status, steps: stepsRun.map((step) => step.id) });
  return state.lastResult;
}

function resultFromState(workspace: Workspace, settings: WorkflowSettings, state: WorkflowRunState, stepsRun: WorkflowStep[]): WorkflowRunResult {
  const next = state.plan.steps[state.nextStepIndex];
  return {
    workflowId: state.workflowId,
    runId: state.runId,
    status: state.status,
    dryRun: state.dryRun,
    stepsRun,
    stepsRemaining: Math.max(0, state.plan.steps.length - state.nextStepIndex),
    confirmationRequired: state.status === "awaiting_confirmation" || Boolean(state.plan.confirmationRequired && !state.dryRun),
    confirmationReason: state.plan.confirmationReason,
    artifacts: {
      state_dir: workflowRunDir(workspace, settings, state.runId),
      plan_title: state.plan.title,
      required_capabilities: state.plan.requiredCapabilities
    },
    verification: verificationRows(state, stepsRun),
    nextAction: next ? `Continue from ${next.id}: ${next.title}` : "Workflow complete."
  };
}

function verificationRows(state: WorkflowRunState, stepsRun: WorkflowStep[]): Array<Record<string, unknown>> {
  const source = stepsRun.length ? stepsRun : state.plan.steps.slice(0, Math.min(state.plan.steps.length, 8));
  return source.map((step) => ({
    step: step.id,
    window: step.window ?? "",
    capability: step.capability ?? "",
    status: step.status ?? (state.completedSteps.includes(step.id) ? "done" : "pending"),
    side_effect: Boolean(step.sideEffect),
    title: step.title
  }));
}

