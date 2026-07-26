import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeWorkflowRunId, saveWorkflowState, loadWorkflowState } from '../dist/workflowState.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-workflow-state-'));
const workspace = { id: 'test', root };
const settings = { stateDir: '.ai-bridge/workflows' };
const runId = makeWorkflowRunId('video-study', new Date('2026-07-05T00:00:00Z'));

const state = {
  runId,
  workflowId: 'video-study',
  status: 'planned',
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
  input: { lesson: 'Fabio1' },
  dryRun: true,
  completedSteps: [],
  nextStepIndex: 0,
  plan: {
    workflowId: 'video-study',
    title: 'Video study: Fabio1',
    summary: 'test',
    steps: [{ id: 'check-db', title: 'Check DB' }],
    requiredCapabilities: ['video_rag.check_db'],
    confirmationRequired: false,
    nextAction: 'run'
  }
};

await saveWorkflowState(workspace, settings, state);
const loaded = await loadWorkflowState(workspace, settings, runId);
assert.equal(loaded.runId, runId);
assert.equal(loaded.workflowId, 'video-study');
assert.equal(loaded.plan.steps[0].id, 'check-db');

const resultMd = await fs.readFile(path.join(root, '.ai-bridge', 'workflows', runId, 'result.md'), 'utf8');
assert.match(resultMd, /Workflow Run/);
assert.match(resultMd, /check-db/);

console.log('workflow-state-unit: ok');

