import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./guard.js";
import type { WorkflowRunState, WorkflowSettings } from "./workflowTypes.js";

function stateRoot(workspace: Workspace, settings: WorkflowSettings): string {
  return path.resolve(workspace.root, settings.stateDir ?? ".ai-bridge/workflows");
}

export function makeWorkflowRunId(workflowId: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${workflowId}-${stamp}-${nonce}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function workflowRunDir(workspace: Workspace, settings: WorkflowSettings, runId: string): string {
  return path.join(stateRoot(workspace, settings), runId);
}

export async function saveWorkflowState(workspace: Workspace, settings: WorkflowSettings, state: WorkflowRunState): Promise<void> {
  const dir = workflowRunDir(workspace, settings, state.runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "result.md"), workflowStateMarkdown(state), "utf8");
}

export async function loadWorkflowState(workspace: Workspace, settings: WorkflowSettings, runId: string): Promise<WorkflowRunState> {
  const file = path.join(workflowRunDir(workspace, settings, runId), "state.json");
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as WorkflowRunState;
}

export async function appendWorkflowEvent(workspace: Workspace, settings: WorkflowSettings, runId: string, event: Record<string, unknown>): Promise<void> {
  const dir = workflowRunDir(workspace, settings, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
}

export function workflowStateMarkdown(state: WorkflowRunState): string {
  const rows = state.plan.steps.map((step, index) => {
    const done = state.completedSteps.includes(step.id) ? "done" : index === state.nextStepIndex ? "next" : step.status ?? "pending";
    return `| ${step.id} | ${step.window ?? ""} | ${step.capability ?? ""} | ${done} | ${step.title} |`;
  });
  return [
    `# Workflow Run ${state.runId}`,
    "",
    `Workflow: ${state.workflowId}`,
    `Status: ${state.status}`,
    `Dry run: ${state.dryRun}`,
    `Updated: ${state.updatedAt}`,
    "",
    `## ${state.plan.title}`,
    "",
    state.plan.summary,
    "",
    "| Step | Window | Capability | Status | Title |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Next: ${state.lastResult?.nextAction ?? state.plan.nextAction}`
  ].join("\n");
}

