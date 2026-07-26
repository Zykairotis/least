import { videoStudyWorkflow } from "./workflows/videoStudy/index.js";
import type { WorkflowDefinition } from "./workflowTypes.js";

const WORKFLOWS: WorkflowDefinition[] = [videoStudyWorkflow];

export function listWorkflowDefinitions(): WorkflowDefinition[] {
  return [...WORKFLOWS];
}

export function getWorkflowDefinition(id: string): WorkflowDefinition | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}

