import type { AgentJobRecord } from "./agentTypes.js";

const COMPLETE = new Set<AgentJobRecord["state"]>(["completed"]);
const ACTIVE = new Set<AgentJobRecord["state"]>(["accepted", "provisioning", "running", "resumed"]);

export interface AgentDagNode {
  taskId: string;
  jobId: string;
  state: AgentJobRecord["state"];
  dependsOn: string[];
}

export interface AgentDagPlan {
  nodes: AgentDagNode[];
  ready: string[];
  waiting: string[];
  running: string[];
  completed: string[];
  cycles: string[][];
  missingDeps: Array<{ taskId: string; dependsOn: string }>;
}

function unique(items: string[] | undefined): string[] {
  return [...new Set((items ?? []).map((item) => item.trim()).filter(Boolean))];
}

function findCycles(nodes: AgentDagNode[]): string[][] {
  const byTask = new Map(nodes.map((node) => [node.taskId, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];

  function visit(taskId: string, stack: string[]): void {
    if (visiting.has(taskId)) {
      const start = stack.indexOf(taskId);
      cycles.push([...stack.slice(start), taskId]);
      return;
    }
    if (visited.has(taskId)) return;
    const node = byTask.get(taskId);
    if (!node) return;
    visiting.add(taskId);
    for (const dep of node.dependsOn) visit(dep, [...stack, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const node of nodes) visit(node.taskId, []);
  return cycles;
}

export function planDag(jobs: AgentJobRecord[]): AgentDagPlan {
  const nodes = jobs.map((job) => ({ jobId: job.jobId, taskId: job.taskId, state: job.state, dependsOn: unique(job.dependsOn) }));
  const byTask = new Map(jobs.map((job) => [job.taskId, job]));
  const missingDeps: AgentDagPlan["missingDeps"] = [];
  const ready: string[] = [];
  const waiting: string[] = [];
  const running: string[] = [];
  const completed: string[] = [];

  for (const node of nodes) {
    if (COMPLETE.has(node.state)) {
      completed.push(node.taskId);
      continue;
    }
    if (ACTIVE.has(node.state)) running.push(node.taskId);
    const depsDone = node.dependsOn.every((dep) => {
      const depJob = byTask.get(dep);
      if (!depJob) {
        missingDeps.push({ taskId: node.taskId, dependsOn: dep });
        return false;
      }
      return COMPLETE.has(depJob.state);
    });
    if (node.dependsOn.length && !depsDone) waiting.push(node.taskId);
    else if (node.state === "planned" || node.state === "accepted") ready.push(node.taskId);
  }

  return { nodes, ready, waiting, running, completed, cycles: findCycles(nodes), missingDeps };
}

export function dependenciesSatisfied(job: AgentJobRecord, jobs: AgentJobRecord[]): boolean {
  const deps = unique(job.dependsOn);
  if (!deps.length) return true;
  const byTask = new Map(jobs.map((item) => [item.taskId, item]));
  return deps.every((dep) => byTask.get(dep)?.state === "completed");
}
