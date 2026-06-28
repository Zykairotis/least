import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { collectManifestRoots, parseSkillManifest } = await import('../dist/skillManifest.js');
const { loadSettings } = await import('../dist/settings.js');

/** Assertion helper */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 1. No manifest in settings → empty roots
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-manifest-none-'));
  const settings = loadSettings({ workspaceRoot: tmp });
  const result = collectManifestRoots(settings, tmp);
  assert(result.roots.length === 0, `expected empty roots, got ${result.roots.length}`);
  assert(result.warnings.length === 0, `expected no warnings, got ${JSON.stringify(result.warnings)}`);
}

// 2. Manifest with workspace source
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-manifest-ws-'));
  await fs.mkdir(path.join(tmp, 'skills', 'my-skill'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'skills', 'my-skill', 'SKILL.md'), '# My Skill\n\nname: my-skill\n', 'utf8');
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'skills.yaml'), [
    'version: 1',
    'sources:',
    '  - id: workspace-skills',
    '    path: skills',
    '    trust: workspace',
    '    enabled: true'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    skills: { manifest: '.least/skills.yaml' }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const result = collectManifestRoots(settings, tmp);
  assert(result.roots.length >= 1, `expected at least 1 root, got ${result.roots.length}`);
  const found = result.roots.some((r) => r.replace(/\\/g, '/').includes('skills'));
  assert(found, `expected roots to include skills dir, got ${JSON.stringify(result.roots)}`);
}

// 3. External source without trust is skipped
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-manifest-ext-skip-'));
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'least-external-skills-'));
  await fs.mkdir(path.join(externalDir, 'ext-skill'), { recursive: true });
  await fs.writeFile(path.join(externalDir, 'ext-skill', 'SKILL.md'), '# External Skill\n\nname: ext-skill\n', 'utf8');
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'skills.yaml'), [
    'version: 1',
    'sources:',
    `  - id: external-source`,
    `    path: "${externalDir.replace(/\\/g, '/')}"`,
    '    trust: external',
    '    enabled: true'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    skills: { manifest: '.least/skills.yaml', allowExternalSources: false }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const result = collectManifestRoots(settings, tmp);
  // External source without trust should be skipped
  assert(result.roots.length === 0, `expected 0 roots for skipped external, got ${result.roots.length}`);
}

// 4. External source with trust is loaded
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-manifest-ext-trust-'));
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'least-external-trusted-'));
  await fs.mkdir(path.join(externalDir, 'ext-skill'), { recursive: true });
  await fs.writeFile(path.join(externalDir, 'ext-skill', 'SKILL.md'), '# External Skill\n\nname: ext-skill\n', 'utf8');
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'skills.yaml'), [
    'version: 1',
    'sources:',
    `  - id: external-source`,
    `    path: "${externalDir.replace(/\\/g, '/')}"`,
    '    trust: external',
    '    enabled: true'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    skills: { manifest: '.least/skills.yaml', allowExternalSources: true }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const result = collectManifestRoots(settings, tmp);
  assert(result.roots.length >= 1, `expected at least 1 root with trust, got ${result.roots.length}`);
  const found = result.roots.some((r) => r.replace(/\\/g, '/').includes(externalDir.replace(/\\/g, '/')));
  assert(found, `expected roots to include external dir, got ${JSON.stringify(result.roots)}`);
}

// 5. Overrides parsed correctly
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-manifest-overrides-'));
  await fs.mkdir(path.join(tmp, 'skills', 'my-skill'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'skills', 'my-skill', 'SKILL.md'), '# My Skill\n\nname: my-skill\n', 'utf8');
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'skills.yaml'), [
    'version: 1',
    'sources:',
    '  - id: workspace-skills',
    '    path: skills',
    '    trust: workspace',
    '    enabled: true',
    'overrides:',
    '  my-skill:',
    '    visibility: name-only',
    '  deploy:',
    '    visibility: off'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    skills: { manifest: '.least/skills.yaml' }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const result = collectManifestRoots(settings, tmp);
  assert(result.overrides['my-skill']?.visibility === 'name-only', `expected name-only override, got ${JSON.stringify(result.overrides['my-skill'])}`);
  assert(result.overrides['deploy']?.visibility === 'off', `expected off override, got ${JSON.stringify(result.overrides['deploy'])}`);
}

// 6. Disabled source is ignored
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-manifest-disabled-'));
  await fs.mkdir(path.join(tmp, 'skills', 'disabled-skill'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'skills', 'disabled-skill', 'SKILL.md'), '# Disabled Skill\n\nname: disabled-skill\n', 'utf8');
  await fs.mkdir(path.join(tmp, '.least'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.least', 'skills.yaml'), [
    'version: 1',
    'sources:',
    '  - id: disabled-ws',
    '    path: skills',
    '    trust: workspace',
    '    enabled: false'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tmp, '.least', 'settings.json'), JSON.stringify({
    skills: { manifest: '.least/skills.yaml' }
  }), 'utf8');
  const settings = loadSettings({ workspaceRoot: tmp });
  const result = collectManifestRoots(settings, tmp);
  assert(result.roots.length === 0, `expected 0 roots for disabled source, got ${result.roots.length}`);
}

console.log('✓ skills manifest unit tests passed');
