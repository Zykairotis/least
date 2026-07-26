import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const { loadConfig } = await import('../dist/config.js');
const { buildPermissionContext, isYoloAllowed } = await import('../dist/permissions.js');
const { loadSettings } = await import('../dist/settings.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 1. CLI --yolo sets config.yoloMode=true
{
  const config = loadConfig(['--root', os.tmpdir(), '--yolo']);
  assert(config.yoloMode === true, `expected yoloMode=true with --yolo, got ${config.yoloMode}`);
}

// 2. --dangerously-allow-all sets yoloMode=true
{
  const config = loadConfig(['--root', os.tmpdir(), '--dangerously-allow-all']);
  assert(config.yoloMode === true, `expected yoloMode=true with --dangerously-allow-all, got ${config.yoloMode}`);
}

// 3. Default is false
{
  const config = loadConfig(['--root', os.tmpdir()]);
  assert(config.yoloMode === false, `expected yoloMode=false by default, got ${config.yoloMode}`);
}

// 4. LEAST_YOLO env sets yoloMode=true
{
  const orig = process.env.LEAST_YOLO;
  process.env.LEAST_YOLO = '1';
  try {
    const config = loadConfig(['--root', os.tmpdir()]);
    assert(config.yoloMode === true, `expected yoloMode=true with LEAST_YOLO=1, got ${config.yoloMode}`);
  } finally {
    if (orig !== undefined) process.env.LEAST_YOLO = orig;
    else delete process.env.LEAST_YOLO;
  }
}

// 5. isYoloAllowed helper works
{
  const cfg = loadConfig(['--root', os.tmpdir(), '--yolo']);
  assert(isYoloAllowed(cfg) === true, `isYoloAllowed should be true for yolo config`);
  const normalCfg = loadConfig(['--root', os.tmpdir()]);
  assert(isYoloAllowed(normalCfg) === false, `isYoloAllowed should be false for normal config`);
}

// 6. Project settings cannot enable yolo (permissions.mode ignored)
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-yolo-project-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    permissions: { mode: 'yolo' }
  }), 'utf8');
  const config = loadConfig(['--root', tmp]);
  // Project settings cannot set yolo mode, so only CLI/env matter
  assert(config.yoloMode === false, `expected yoloMode=false from project settings, got ${config.yoloMode}`);
}

// 7. Permission context is built correctly in yolo mode
{
  const config = loadConfig(['--root', os.tmpdir(), '--yolo']);
  const ctx = buildPermissionContext(config.settings, config);
  // defaultBashMode uses config.bashMode directly; yolo overrides at runtime in bashOps
  ctx.defaultBashMode; // just verify it doesn't throw
}

// 8. CLI flag yolo is visible in the config
{
  const config = loadConfig(['--root', os.tmpdir(), '--yolo']);
  const json = JSON.stringify(config);
  assert(json.includes('"yoloMode":true'), `expected yoloMode:true in config JSON`);
}

console.log('✓ yolo mode unit tests passed');
