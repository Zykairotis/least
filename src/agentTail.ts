import type { AgentJobRecord } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { tailAgentTerminal } from "./agentTerminalBackend.js";
import type { TerminalTailOptions, TerminalTailResult } from "./agentTerminalTypes.js";

export type AgentTailOptions = TerminalTailOptions;
export type AgentTailResult = TerminalTailResult;

export async function tailAgentJob(workspace: Pick<Workspace, "root">, job: AgentJobRecord, options: AgentTailOptions = {}): Promise<AgentTailResult> {
  return await tailAgentTerminal(workspace, job, options);
}
