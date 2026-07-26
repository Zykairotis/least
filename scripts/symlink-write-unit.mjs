import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-symlink-write-'));
await fs.writeFile(path.join(root, 'target.txt'), 'safe\n');
await fs.symlink(path.join(root, 'target.txt'), path.join(root, 'alias.txt'));
const config = loadConfig(['--root', root]);
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).openWorkspace(root);
assert.throws(() => guard.resolve(workspace, 'alias.txt', { forWrite: true }), /symbolic link/);
assert.equal(guard.resolve(workspace, 'target.txt', { forWrite: true }).relPath, 'target.txt');
console.log('symlink-write-unit: ok');
