import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { isHookCommandTrusted, getHooksForEvent } = await import('../dist/hooks.js');
const { loadSettings } = await import('../dist/settings.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Trust tests ─────────────────────────────────────────────────

// 1. Project hook without allowProjectHooks is not trusted
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-hook-trust1-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.local.json'), JSON.stringify({
    hooks: { enabled: true, allowProjectHooks: false }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const trusted = isHookCommandTrusted(
    { type: 'command', command: '.least/hooks/pre-bash.js' },
    settings,
    tmp
  );
  assert(!trusted.trusted, `expected not trusted, got ${JSON.stringify(trusted)}`);
}

// 2. Project hook with allowProjectHooks is trusted
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-hook-trust2-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.local.json'), JSON.stringify({
    hooks: { enabled: true, allowProjectHooks: true }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const trusted = isHookCommandTrusted(
    { type: 'command', command: '.least/hooks/pre-bash.js' },
    settings,
    tmp
  );
  assert(trusted.trusted, `expected trusted, got ${JSON.stringify(trusted)}`);
}

// 3. Hooks disabled → not trusted
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-hook-trust3-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.local.json'), JSON.stringify({
    hooks: { enabled: false }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const trusted = isHookCommandTrusted(
    { type: 'command', command: '.least/hooks/pre-bash.js' },
    settings,
    tmp
  );
  assert(!trusted.trusted, `expected not trusted (hooks disabled), got ${JSON.stringify(trusted)}`);
}

// 4. Workspace-relative hook resolving outside workspace is not trusted
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-hook-trust4-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.local.json'), JSON.stringify({
    hooks: { enabled: true, allowProjectHooks: true }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const trusted = isHookCommandTrusted(
    { type: 'command', command: '../../tmp/evil.js' },
    settings,
    tmp
  );
  assert(!trusted.trusted, `expected not trusted (escape), got ${JSON.stringify(trusted)}`);
}

// ── getHooksForEvent tests ──────────────────────────────────────

// 5. Hooks match event correctly
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-hook-event5-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    hooks: {
      enabled: true,
      PreToolUse: [
        { matcher: 'bash', type: 'command', command: '.least/hooks/pre-bash.js', timeoutMs: 3000 }
      ],
      PostToolUse: [
        { matcher: 'write', type: 'command', command: '.least/hooks/audit.js', timeoutMs: 3000 }
      ]
    }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const preHooks = getHooksForEvent('PreToolUse', settings, tmp, 'bash');
  const postHooks = getHooksForEvent('PostToolUse', settings, tmp, 'write');
  assert(preHooks.length === 1, `expected 1 PreToolUse hook, got ${preHooks.length}`);
  assert(postHooks.length === 1, `expected 1 PostToolUse hook, got ${postHooks.length}`);
  assert(preHooks[0].command.includes('pre-bash.js'), `expected pre-bash.js, got ${preHooks[0].command}`);
  const unrelated = getHooksForEvent('PreRead', settings, tmp);
  assert(unrelated.length === 0, `expected 0 PreRead hooks, got ${unrelated.length}`);
}

// 6. Hooks with no matcher match any event
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-hook-event6-'));
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    hooks: {
      enabled: true,
      PreToolUse: [
        { type: 'command', command: '.least/hooks/any.js', timeoutMs: 3000 }
      ]
    }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const preBash = getHooksForEvent('PreToolUse', settings, tmp, 'bash');
  assert(preBash.length === 1, `expected 1 hook without matcher, got ${preBash.length}`);
}

console.log('✓ hooks unit tests passed');
