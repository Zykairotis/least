import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleWorkflowRequest } from '../dist/workflowRunner.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-workflow-video-study-'));
const workspace = { id: 'smoke', root };
const settings = {
  enabled: true,
  allowed: ['video-study'],
  defaultDryRun: true,
  maxStepsDefault: 3,
  maxStepsHardLimit: 20,
  requireConfirmationForBulk: true,
  stateDir: '.ai-bridge/workflows'
};

const input = {
  source: 'D:\\Trading\\Order Flow & Footprint\\DeepCharts Course (Fabio & Andrea)- 2025',
  project: 'default',
  course: 'Order Flow & Footprint',
  module: 'DeepCharts Course (Fabio & Andrea)- 2025',
  lesson: 'Fabio1',
  mode: 'time-window',
  window_scope: '0-30',
  outputs: ['obsidian', 'anki', 'images']
};

const planned = await handleWorkflowRequest(workspace, settings, {
  action: 'plan',
  workflowId: 'video-study',
  input,
  dryRun: true,
  maxSteps: 3,
  confirm: false
});
assert.equal(planned.workflowId, 'video-study');
assert.equal(planned.status, 'planned');
assert.ok(planned.artifacts.state_dir);
assert.ok(planned.verification.length > 0);

const run = await handleWorkflowRequest(workspace, settings, {
  action: 'run',
  workflowId: 'video-study',
  input,
  dryRun: true,
  maxSteps: 3,
  confirm: false
});
assert.equal(run.stepsRun.length, 3);
assert.equal(run.status, 'paused');
assert.ok(run.stepsRemaining > 0);
assert.ok(run.verification.some((row) => row.step === 'evidence-00-00-00-10'));

console.log('workflow-video-study-smoke: ok');
