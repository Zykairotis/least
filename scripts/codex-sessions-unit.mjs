import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { listCodexSessions, readCodexSession } from '../dist/codexSessions.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-session-workspace-'));
const codexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'least-codex-home-'));
const sessionDir = path.join(codexDir, 'sessions', '2026', '07', '26');
await fs.mkdir(sessionDir, { recursive: true });
const id = '11111111-2222-4333-8444-555555555555';
const source = path.join(sessionDir, `rollout-${id}.jsonl`);
await fs.writeFile(source, [
  { timestamp: '2026-07-26T10:00:00Z', type: 'session_meta', payload: { id, cwd: root } },
  { timestamp: '2026-07-26T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Port useful features' }] } },
  { timestamp: '2026-07-26T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'read' } },
  { timestamp: '2026-07-26T10:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Done' }] } }
].map(JSON.stringify).join('\n') + '\n');

const previousMode = process.env.LEAST_CODEX_SESSIONS;
const previousDir = process.env.LEAST_CODEX_DIR;
process.env.LEAST_CODEX_SESSIONS = 'read';
process.env.LEAST_CODEX_DIR = codexDir;
try {
  const config = loadConfig(['--root', root]);
  const listed = await listCodexSessions(config);
  assert.equal(listed.sessions[0]?.session_id, id);
  const read = await readCodexSession(config, { sessionId: id, direction: 'tail', maxMessages: 10 });
  assert.equal(read.messages.at(-1)?.content, 'Done');
  assert.match(read.text, /Port useful features/);
  await assert.rejects(() => readCodexSession(config, { sourcePath: path.join(root, 'outside.jsonl') }), /outside|ENOENT/);
} finally {
  if (previousMode === undefined) delete process.env.LEAST_CODEX_SESSIONS; else process.env.LEAST_CODEX_SESSIONS = previousMode;
  if (previousDir === undefined) delete process.env.LEAST_CODEX_DIR; else process.env.LEAST_CODEX_DIR = previousDir;
}
console.log('codex-sessions-unit: ok');
