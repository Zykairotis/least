import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(args, env) {
  const result = spawnSync(process.execPath, ['scripts/least.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`Lst ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-settings-root-'));
const reuseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'least-settings-reuse-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'least-settings-home-'));
const env = { ...process.env, LEAST_HOME: home };

// Check empty settings
const empty = run(['settings', 'show', '--root', root], env);
if (!empty.includes('No saved settings')) {
  throw new Error(`expected empty settings output, got:\n${empty}`);
}

// Save a simple profile with tunnel=none to avoid hostname requirement
const saved = run(['settings', 'set', '--root', root, '--tunnel', 'none', '--tool-mode', 'full', '--toolset', 'edit'], env);
if (!saved.includes('Saved workspace settings')) {
  throw new Error(`expected settings set output, got:\n${saved}`);
}

const profile = await (async () => {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return JSON.parse(await fs.readFile(path.join(home, 'profiles', `${id}.json`), 'utf8'));
})();
if (profile.toolMode !== 'full' || profile.toolset !== 'edit') {
  throw new Error(`settings profile did not persist tool options: ${JSON.stringify(profile)}`);
}

// List
const listed = run(['settings', 'list'], env);
if (!listed.includes(root)) {
  throw new Error(`settings list missing saved profile\n${listed}`);
}

// Reuse
const reused = run(['settings', 'use', '--root', reuseRoot, '--from-root', root], env);
if (!reused.includes('Saved workspace settings from')) {
  throw new Error(`settings use did not save profile\n${reused}`);
}

// Delete
const deleted = run(['settings', 'delete', '--root', root, '--yes'], env);
if (!deleted.includes('Deleted saved settings')) {
  throw new Error(`expected settings delete output, got:\n${deleted}`);
}
run(['settings', 'delete', '--root', reuseRoot, '--yes'], env);

const afterDelete = run(['settings', 'show', '--root', root], env);
if (!afterDelete.includes('No saved settings')) {
  throw new Error(`expected empty settings after delete, got:\n${afterDelete}`);
}

console.log('✓ settings smoke test passed');

// ── Settings loader unit tests ──────────────────────────────────

const { loadSettings } = await import('../dist/settings.js');

// 1. No settings files → returns empty effective
{
  const noSettingsTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-no-settings-'));
  const result = loadSettings({ workspaceRoot: noSettingsTmp });
  if (Object.keys(result.effective).length !== 0) throw new Error(`expected empty effective settings, got ${JSON.stringify(result.effective)}`);
  if (result.loadedFiles.length !== 0) throw new Error(`expected no loaded files, got ${result.loadedFiles.join(',')}`);
  const hasProjMissing = result.missingFiles.some((f) => f.replace(/\\/g,'/').includes('.least/settings.json'));
  if (!hasProjMissing) throw new Error(`expected project settings in missingFiles, got ${result.missingFiles.join(',')}`);
}

// 2a. Invalid JSON → warning
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-settings-invalid-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), '{"permissions": { bad json }}', 'utf8');
  const result = loadSettings({ workspaceRoot: tmp });
  if (!result.warnings.some((w) => w.includes('JSON') && w.includes('Expected'))) throw new Error(`expected parse error warning, got ${JSON.stringify(result.warnings)}`);
}

// 2b. Valid JSON loads correctly
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-settings-valid-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    permissions: {
      deny: ['Bash(curl *)'],
      allow: ['Bash(npm run build)']
    }
  }), 'utf8');
  const result = loadSettings({ workspaceRoot: tmp });
  const p = result.effective.permissions;
  if (!p) throw new Error('expected permissions in effective settings');
  if (!p.deny?.includes('Bash(curl *)')) throw new Error(`expected deny rule, got ${JSON.stringify(p.deny)}`);
  if (!p.allow?.includes('Bash(npm run build)')) throw new Error(`expected allow rule, got ${JSON.stringify(p.allow)}`);
}

// 3. Project + local merge (local wins over project)
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-settings-merge-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm run build)'] },
    hooks: { enabled: true, allowProjectHooks: false }
  }), 'utf8');
  await fs.writeFile(path.join(tmp, '.least', 'settings.local.json'), JSON.stringify({
    hooks: { allowProjectHooks: true }
  }), 'utf8');
  const result = loadSettings({ workspaceRoot: tmp });
  const e = result.effective;
  if (!e.permissions?.allow?.includes('Bash(npm run build)')) throw new Error(`expected project allow in merge, got ${JSON.stringify(e.permissions)}`);
  if (e.hooks?.allowProjectHooks !== true) throw new Error(`expected local hooks allowProjectHooks=true, got ${JSON.stringify(e.hooks)}`);
  if (e.hooks?.enabled !== true) throw new Error(`expected hooks enabled from project, got ${JSON.stringify(e.hooks)}`);
  if (!result.loadedFiles.some((f) => f.replace(/\\/g,'/').includes('.least/settings.json'))) throw new Error(`expected project settings in loadedFiles, got ${result.loadedFiles.join(',')}`);
  if (!result.loadedFiles.some((f) => f.replace(/\\/g,'/').includes('.least/settings.local.json'))) throw new Error(`expected local settings in loadedFiles, got ${result.loadedFiles.join(',')}`);
}

console.log('✓ settings-loader unit tests passed');
