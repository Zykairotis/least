#!/usr/bin/env node
import process from 'node:process';
import { handleWorkflowRequest } from '../dist/workflowRunner.js';

function arg(name, fallback) {
  const pref = `--${name}=`;
  const eq = process.argv.find((item) => item.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return fallback;
}

function boolArg(name, fallback = false) {
  if (process.argv.includes(`--${name}`)) return true;
  if (process.argv.includes(`--no-${name}`)) return false;
  return fallback;
}

const action = process.argv[2] || 'plan';
const root = arg('root', process.cwd());
const workspace = { id: 'cli', root };
const settings = {
  enabled: true,
  allowed: ['video-study'],
  defaultDryRun: true,
  maxStepsDefault: Number(arg('max-steps-default', '3')),
  maxStepsHardLimit: Number(arg('max-steps-hard-limit', '20')),
  requireConfirmationForBulk: true,
  stateDir: arg('state-dir', '.ai-bridge/workflows')
};

const input = {
  source: arg('source', arg('folder', '')),
  project: arg('project', 'default'),
  course: arg('course', undefined),
  module: arg('module', undefined),
  lesson: arg('lesson', undefined),
  mode: arg('mode', 'time-window'),
  window_scope: arg('window-scope', '0-30'),
  outputs: arg('outputs', 'obsidian,anki,images').split(',').map((item) => item.trim()).filter(Boolean)
};

const result = await handleWorkflowRequest(workspace, settings, {
  action,
  workflowId: arg('workflow-id', 'video-study'),
  runId: arg('run-id', undefined),
  input,
  dryRun: boolArg('dry-run', true),
  maxSteps: Number(arg('max-steps', String(settings.maxStepsDefault))),
  confirm: boolArg('confirm', false),
  confirmToken: arg('confirm-token', undefined)
});

if (boolArg('json', false)) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# Workflow ${result.workflowId}`);
  console.log(`Run: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Dry run: ${result.dryRun}`);
  console.log(`Steps remaining: ${result.stepsRemaining}`);
  console.log('');
  for (const row of result.verification) {
    console.log(`- ${row.status}: ${row.step}${row.window ? ` (${row.window})` : ''} - ${row.title}`);
  }
  console.log('');
  console.log(`Next: ${result.nextAction}`);
}

