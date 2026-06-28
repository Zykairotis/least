import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

console.log('smoke: dashboard unit...');
spawnSync(process.execPath, ['scripts/dashboard-unit.mjs'], { stdio: 'inherit', cwd: process.cwd() });

console.log('smoke: dashboard smoke...');
spawnSync(process.execPath, ['scripts/dashboard-smoke.mjs'], { stdio: 'inherit', cwd: process.cwd() });

console.log('smoke: dashboard build smoke...');
spawnSync(process.execPath, ['scripts/dashboard-build-smoke.mjs'], { stdio: 'inherit', cwd: process.cwd() });

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(encode(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-smoke-'));
await fs.writeFile(path.join(tmp, 'demo.txt'), 'alpha\nread\nread\nomega\n', 'utf8');
await fs.writeFile(path.join(tmp, 'config.txt'), 'OPENAI_API_KEY=sk-realSecretValue123\n', 'utf8');
await fs.writeFile(path.join(tmp, 'AGENTS.md'), '# Smoke Agents\n\n- Preserve demo.txt.\n', 'utf8');
await fs.mkdir(path.join(tmp, '.codex', 'skills', 'smoke-skill'), { recursive: true });
await fs.writeFile(path.join(tmp, '.codex', 'skills', 'smoke-skill', 'SKILL.md'), [
  '---',
  'name: smoke-skill',
  'description: Smoke test skill discovery.',
  '---',
  '',
  '# Smoke Skill',
  ''
].join('\n'), 'utf8');
await fs.mkdir(path.join(tmp, '.agents', 'skills', 'smoke-skill'), { recursive: true });
await fs.writeFile(path.join(tmp, '.agents', 'skills', 'smoke-skill', 'SKILL.md'), [
  '---',
  'name: smoke-skill',
  'description: Duplicate smoke test skill discovery.',
  '---',
  '',
  '# Duplicate Smoke Skill',
  ''
].join('\n'), 'utf8');
await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
  scripts: {
    'build:clients': "node -e \"console.log('clients ok')\""
  }
}, null, 2), 'utf8');
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'least-outside-'));
await fs.writeFile(path.join(outside, 'secret.txt'), 'do-not-read', 'utf8');
let symlinkEscapePath = 'secret-link.txt';
try {
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(tmp, symlinkEscapePath));
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  symlinkEscapePath = 'secret-link-dir/secret.txt';
  await fs.symlink(outside, path.join(tmp, 'secret-link-dir'), 'junction');
}
for (const args of [['init'], ['add', 'demo.txt', 'AGENTS.md', 'package.json']]) {
  const result = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}
const commitResult = spawnSync('git', ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'initial smoke fixture'], { cwd: tmp, encoding: 'utf8' });
if (commitResult.status !== 0) {
  throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
}

const client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, LEAST_ROOT: tmp, LEAST_ALLOWED_ROOTS: tmp, LEAST_WIDGET_DOMAIN: 'https://widgets.least.test' }
});

await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'least-smoke', version: '0.1.0' }
});
client.notify('notifications/initialized');
const tools = await client.request('tools/list', {});
const toolNames = tools.tools.map((tool) => tool.name);
for (const expected of ['server_config', 'least_inventory', 'least_perf', 'least_gain', 'least_discover', 'retrieve_output', 'context_pack', 'review_minimality', 'list_workspaces', 'open_current_workspace', 'open_workspace', 'files', 'tree', 'search', 'search_context', 'read', 'read_many', 'json_query', 'load_skill', 'write', 'edit', 'bash', 'shell', 'show_changes', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
  if (!toolNames.includes(expected)) throw new Error(`missing tool: ${expected}`);
}
const toolCardUri = 'ui://widget/least-tool-card-v8.html';
const toolCardAliasUri = 'ui://widget/least-tool-card-v9.html';
const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
function expectSchemaProperty(toolName, propertyName) {
  const properties = toolsByName.get(toolName)?.inputSchema?.properties ?? {};
  if (!Object.prototype.hasOwnProperty.call(properties, propertyName)) {
    throw new Error(`${toolName} schema missing ${propertyName}: ${JSON.stringify(toolsByName.get(toolName)?.inputSchema)}`);
  }
}
for (const lockedTool of ['write', 'edit', 'bash', 'shell']) {
  expectSchemaProperty(lockedTool, 'lease_token');
}
function hasWidgetMeta(name) {
  const meta = toolsByName.get(name)?._meta ?? {};
  return meta.ui?.resourceUri === toolCardUri || meta['openai/outputTemplate'] === toolCardUri;
}
async function expectToolError(name, args, pattern) {
  const result = await client.request('tools/call', { name, arguments: args });
  if (!result.isError) {
    throw new Error(`${name} unexpectedly succeeded`);
  }
  const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
  if (pattern && !pattern.test(text)) {
    throw new Error(`${name} error did not match ${pattern}: ${text}`);
  }
}
for (const visualTool of ['open_current_workspace', 'open_workspace', 'write', 'edit', 'show_changes', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex']) {
  if (!hasWidgetMeta(visualTool)) throw new Error(`${visualTool} should render the Least widget`);
}
for (const quietTool of ['server_config', 'least_inventory', 'list_workspaces', 'workspace_snapshot', 'tree', 'search', 'load_skill', 'read', 'bash', 'git_status', 'git_diff', 'read_handoff', 'codex_context']) {
  if (hasWidgetMeta(quietTool)) throw new Error(`${quietTool} should stay data-only without widget metadata`);
}
const resources = await client.request('resources/list', {});
const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
if (!toolCard) throw new Error(`missing tool-card resource: ${toolCardUri}`);
const toolCardAlias = resources.resources.find((resource) => resource.uri === toolCardAliasUri);
if (!toolCardAlias) throw new Error(`missing tool-card alias resource: ${toolCardAliasUri}`);
if (toolCard.mimeType !== 'text/html;profile=mcp-app') throw new Error(`unexpected tool-card mime type: ${toolCard.mimeType}`);
const widget = await client.request('resources/read', { uri: toolCardUri });
const widgetText = widget.contents?.[0]?.text ?? '';
const widgetMeta = widget.contents?.[0]?._meta ?? {};
if (!widgetText.includes('Waiting for tool result') || !widgetText.includes('renderWorkspace') || !widgetText.includes('details class="fold"') || !widgetText.includes('ui/notifications/tool-result')) {
  throw new Error('tool-card widget resource did not include expected Apps bridge code');
}
if (!widgetMeta.ui?.csp || !widgetMeta['openai/widgetCSP']) {
  throw new Error('tool-card widget resource did not expose standard and ChatGPT CSP metadata');
}
if (widgetMeta.ui?.domain !== 'https://widgets.least.test' || widgetMeta['openai/widgetDomain'] !== 'https://widgets.least.test') {
  throw new Error('tool-card widget resource did not expose standard and ChatGPT widget domain metadata');
}
const serverConfig = await client.request('tools/call', { name: 'server_config', arguments: {} });
for (const expected of ['files', 'search_context', 'read_many', 'json_query']) {
  if (!serverConfig.structuredContent.registeredTools?.includes?.(expected)) {
    throw new Error(`server_config did not report registered tool ${expected}`);
  }
}
const current = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false, include_skills: true } });
const realTmp = await fs.realpath(tmp);
if (current.structuredContent.root !== realTmp) throw new Error(`open_current_workspace opened ${current.structuredContent.root}, expected ${realTmp}`);
if (current.structuredContent.least_tool !== 'open_current_workspace') throw new Error('tool result was not tagged for widget rendering');
if (current.structuredContent.tool_mode !== 'full') throw new Error(`open_current_workspace did not expose tool_mode: ${current.structuredContent.tool_mode}`);
if (!current.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'smoke-skill')) {
  throw new Error('open_current_workspace did not discover workspace skill inventory');
}
await expectToolError('load_skill', { name: 'smoke-skill', source: 'workspace' }, /Multiple skills named smoke-skill/);
const loadedSkill = await client.request('tools/call', {
  name: 'load_skill',
  arguments: {
    name: 'smoke-skill',
    source: 'workspace',
    path: '$WORKSPACE/.codex/skills/smoke-skill/SKILL.md'
  }
});
if (loadedSkill.structuredContent.skill?.name !== 'smoke-skill' || !loadedSkill.structuredContent.text?.includes('# Smoke Skill')) {
  throw new Error('load_skill did not return bounded SKILL.md content for smoke-skill');
}
await expectToolError('load_skill', { name: 'missing-skill' }, /Skill not found/);
const inventory = await client.request('tools/call', { name: 'least_inventory', arguments: { include_global_skills: false, include_mcp_servers: false } });
if (inventory.structuredContent.least_tool !== 'least_inventory') throw new Error('inventory result was not tagged for widget rendering');
const opened = await client.request('tools/call', { name: 'open_workspace', arguments: { root: tmp, include_tree: true } });
const ws = opened.structuredContent.workspace_id;
const openedByPath = await client.request('tools/call', { name: 'open_workspace', arguments: { path: tmp, include_tree: false } });
if (openedByPath.structuredContent.workspace_id !== ws) {
  throw new Error(`open_workspace path alias returned ${openedByPath.structuredContent.workspace_id}, expected ${ws}`);
}
await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'demo.txt' } });
const secretRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'config.txt' } });
const secretPayload = JSON.stringify(secretRead);
if (secretPayload.includes('sk-realSecretValue123') || !secretPayload.includes('[REDACTED_SECRET]')) {
  throw new Error('read did not redact secret-looking content');
}
await expectToolError('write', { workspace_id: ws, path: 'notes.md', content: 'OPENAI_API_KEY=sk-realSecretValue123\n' }, /Secret-looking content is blocked/);
await client.request('tools/call', {
  name: 'write',
  arguments: {
    workspace_id: ws,
    path: 'env-ref.js',
    content: 'const TOKEN = process.env.TOKEN;\nconst OPENAI_API_KEY = process.env.OPENAI_API_KEY;\nconst apiToken = getToken();\n'
  }
});
const envRefRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'env-ref.js' } });
const envRefPayload = JSON.stringify(envRefRead);
if (envRefPayload.includes('[REDACTED_SECRET]')) {
  throw new Error('env-var token references were incorrectly redacted as literal secrets');
}
const symlinkRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: symlinkEscapePath } });
if (!symlinkRead.isError) throw new Error('symlink escape read was not blocked');
await client.request('tools/call', { name: 'edit', arguments: { workspace_id: ws, path: 'demo.txt', old_text: 'read\nread', new_text: 'read\nwrite' } });
const changes = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: ws } });
if (!changes.structuredContent.changed || !changes.structuredContent.diff.includes('demo.txt')) {
  throw new Error('show_changes did not report the edited demo.txt diff');
}
const demoChanges = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: ws, path: 'demo.txt' } });
if (!demoChanges.structuredContent.changed || !demoChanges.structuredContent.changed_files?.some?.((line) => line.includes('demo.txt'))) {
  throw new Error(`path-scoped show_changes did not report demo.txt: ${JSON.stringify(demoChanges.structuredContent.changed_files)}`);
}
if (demoChanges.structuredContent.changed_files?.some?.((line) => line.includes('env-ref.js'))) {
  throw new Error(`path-scoped show_changes leaked unrelated env-ref.js status: ${JSON.stringify(demoChanges.structuredContent.changed_files)}`);
}
const cleanPathChanges = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: ws, path: 'package.json' } });
if (cleanPathChanges.structuredContent.changed || cleanPathChanges.structuredContent.changed_files?.length || cleanPathChanges.structuredContent.diff.includes('demo.txt')) {
  throw new Error(`path-scoped show_changes leaked unrelated changes: ${JSON.stringify(cleanPathChanges.structuredContent)}`);
}
const codexContext = await client.request('tools/call', { name: 'codex_context', arguments: { workspace_id: ws, target_path: 'demo.txt' } });
if (!codexContext.structuredContent.agents_files.includes('AGENTS.md')) throw new Error('codex_context did not include AGENTS.md');
if (codexContext.structuredContent.agents_files.length !== 1) throw new Error(`codex_context returned duplicate AGENTS files: ${codexContext.structuredContent.agents_files.join(', ')}`);
if (!codexContext.content?.[0]?.text?.includes('Smoke Agents')) throw new Error('codex_context did not include AGENTS.md content');
await client.request('tools/call', { name: 'bash', arguments: { workspace_id: ws, command: 'pwd' } });
await expectToolError('bash', { workspace_id: ws, command: 'find /tmp' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'find . -fprint leaked.txt' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'git show HEAD:.env' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'ls $HOME' }, /blocked/i);
const clientBuild = await client.request('tools/call', { name: 'bash', arguments: { workspace_id: ws, command: 'npm run build:clients', timeout_ms: 60000 } });
if (!clientBuild.content?.[0]?.text?.includes('clients ok')) {
  throw new Error('safe bash did not run npm run build:clients');
}
const exported = await client.request('tools/call', { name: 'export_pro_context', arguments: { workspace_id: ws, selected_paths: ['demo.txt'], max_files: 4, max_total_bytes: 80000 } });
if (exported.structuredContent.path !== '.ai-bridge/pro-context.md') throw new Error('export_pro_context wrote an unexpected path');
await fs.stat(path.join(tmp, '.ai-bridge', 'pro-context.md'));
const agentHandoff = await client.request('tools/call', {
  name: 'handoff_to_agent',
  arguments: {
    workspace_id: ws,
    agent: 'opencode',
    model: 'provider/cheap-model',
    title: 'Smoke agent plan',
    plan: '- Verify demo.txt contains write.'
  }
});
if (agentHandoff.structuredContent.agent !== 'opencode') throw new Error('handoff_to_agent did not preserve target agent');
const escapedHandoff = await client.request('tools/call', {
  name: 'handoff_to_agent',
  arguments: {
    workspace_id: ws,
    agent: 'opencode',
    model: 'foo; touch /tmp/pwned',
    title: 'Escaped model plan',
    plan: '- Verify shell hints quote model names.'
  }
});
const escapedPrompt = escapedHandoff.content?.find?.((part) => part.type === 'text')?.text ?? '';
if (!escapedPrompt.includes("--model 'foo; touch /tmp/pwned'")) {
  throw new Error(`handoff_to_agent did not shell-quote the model hint: ${escapedPrompt}`);
}
if (escapedPrompt.includes('--model foo; touch')) {
  throw new Error(`handoff_to_agent exposed an unquoted model hint: ${escapedPrompt}`);
}
for (const bridgeFile of ['agent-status.md', 'implementation-diff.patch', 'execution-log.jsonl']) {
  await fs.stat(path.join(tmp, '.ai-bridge', bridgeFile));
}
const handoffContext = await client.request('tools/call', { name: 'read_handoff', arguments: { workspace_id: ws } });
for (const expectedFile of ['.ai-bridge/agent-status.md', '.ai-bridge/implementation-diff.patch', '.ai-bridge/execution-log.jsonl']) {
  if (!handoffContext.structuredContent.files.includes(expectedFile)) {
    throw new Error(`read_handoff did not include ${expectedFile}`);
  }
}
await client.request('tools/call', { name: 'handoff_to_codex', arguments: { workspace_id: ws, title: 'Smoke Codex plan', plan: '- Verify demo.txt contains write.', append: true } });
await fs.writeFile(path.join(tmp, '.ai-bridge', 'current-plan.md'), 'x'.repeat(190000), 'utf8');
await expectToolError('handoff_to_agent', {
  workspace_id: ws,
  agent: 'opencode',
  title: 'Oversized append plan',
  plan: '- This append should fail before loading the existing plan.',
  append: true
}, /File is too large/);

const contextPack = await client.request('tools/call', {
  name: 'context_pack',
  arguments: { workspace_id: ws, task: 'find read usage', query: 'read', profile: 'edit', max_files: 5 }
});
if (!contextPack.content?.[0]?.text?.includes('Context Pack')) {
  throw new Error('context_pack did not return a context pack summary');
}

const leastGain = await client.request('tools/call', { name: 'least_gain', arguments: { workspace_id: ws } });
if (!leastGain.content?.[0]?.text?.includes('Least gain')) {
  throw new Error('least_gain did not return a gain summary');
}

const leastDiscover = await client.request('tools/call', { name: 'least_discover', arguments: { workspace_id: ws } });
if (!leastDiscover.content?.[0]?.text?.includes('Least discover')) {
  throw new Error('least_discover did not return a discover summary');
}

const minimality = await client.request('tools/call', { name: 'review_minimality', arguments: { workspace_id: ws, max_findings: 5 } });
if (!minimality.content?.[0]?.text?.includes('Heuristic minimality review')) {
  throw new Error('review_minimality did not return a review summary');
}

const largeBash = await client.request('tools/call', {
  name: 'bash',
  arguments: { workspace_id: ws, command: 'node -e "console.log(String.fromCharCode(97).repeat(20000))"' }
});
const retrievalKey = largeBash.structuredContent?.output_meta?.retrievalKey;
if (retrievalKey) {
  const retrieved = await client.request('tools/call', {
    name: 'retrieve_output',
    arguments: { workspace_id: ws, key: retrievalKey, max_bytes: 30_000 }
  });
  if (!retrieved.content?.[0]?.text?.includes('aaaa')) {
    throw new Error('retrieve_output did not return stored bash output');
  }
}

client.close();

const memoryClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, LEAST_ROOT: tmp, LEAST_ALLOWED_ROOTS: tmp, LEAST_PROJECT_MEMORY: '1' }
});
await memoryClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'least-memory-smoke', version: '0.1.0' }
});
memoryClient.notify('notifications/initialized');
const memoryTools = await memoryClient.request('tools/list', {});
const memoryToolNames = memoryTools.tools.map((tool) => tool.name);
for (const expected of ['project_memory_search', 'project_memory_save', 'project_memory_update']) {
  if (!memoryToolNames.includes(expected)) throw new Error(`missing project memory tool: ${expected}`);
}
const memoryOpened = await memoryClient.request('tools/call', { name: 'open_workspace', arguments: { root: tmp, include_tree: false } });
const memoryWs = memoryOpened.structuredContent.workspace_id;
const savedMemory = await memoryClient.request('tools/call', {
  name: 'project_memory_save',
  arguments: { workspace_id: memoryWs, kind: 'command', text: 'Smoke test command is npm run smoke', paths: ['package.json'] }
});
if (!savedMemory.structuredContent?.record?.id) throw new Error('project_memory_save did not return a record id');
const memoryHits = await memoryClient.request('tools/call', {
  name: 'project_memory_search',
  arguments: { workspace_id: memoryWs, query: 'smoke', max_results: 5 }
});
if (!memoryHits.structuredContent?.records?.length) throw new Error('project_memory_search did not find saved memory');
memoryClient.close();
async function assertToolMode(mode, expected, hidden) {
  const args = ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe'];
  if (mode) args.push('--tool-mode', mode);
  const modeClient = new McpStdioClient('node', args, {
    cwd: path.resolve('.'),
    env: { ...process.env, LEAST_ROOT: tmp, LEAST_ALLOWED_ROOTS: tmp, LEAST_TOOL_MODE: '' }
  });
  await modeClient.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: `least-${mode || 'default'}-smoke`, version: '0.1.0' }
  });
  modeClient.notify('notifications/initialized');
  const modeTools = await modeClient.request('tools/list', {});
  const names = modeTools.tools.map((tool) => tool.name);
  for (const expectedName of expected) {
    if (!names.includes(expectedName)) throw new Error(`${mode || 'default'} mode missing ${expectedName}; got ${names.join(', ')}`);
  }
  for (const hiddenName of hidden) {
    if (names.includes(hiddenName)) throw new Error(`${mode || 'default'} mode should hide ${hiddenName}; got ${names.join(', ')}`);
  }
  modeClient.close();
}

await assertToolMode('', ['server_config', 'open_current_workspace', 'open_workspace', 'files', 'tree', 'search', 'search_context', 'read_many', 'json_query', 'load_skill', 'read', 'write', 'edit', 'bash', 'shell', 'show_changes', 'read_handoff', 'export_pro_context', 'handoff_to_agent'], ['least_inventory', 'workspace_snapshot', 'git_status', 'git_diff', 'codex_context', 'handoff_to_codex']);
await assertToolMode('minimal', ['server_config', 'open_current_workspace', 'open_workspace', 'read', 'write', 'edit', 'bash', 'shell', 'show_changes'], ['tree', 'search', 'load_skill', 'read_handoff', 'export_pro_context', 'handoff_to_agent', 'codex_context']);

const lowerAgentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'least-lower-agents-'));
await fs.writeFile(path.join(lowerAgentsRoot, 'agents.md'), '# Lowercase agents\n\n- Lowercase instruction file loaded.\n', 'utf8');
await fs.mkdir(path.join(lowerAgentsRoot, 'src'));
await fs.writeFile(path.join(lowerAgentsRoot, 'src', 'demo.ts'), 'export const demo = true;\n', 'utf8');
const lowerClient = new McpStdioClient('node', ['dist/stdio.js', '--root', lowerAgentsRoot, '--allow-root', lowerAgentsRoot, '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, LEAST_ROOT: lowerAgentsRoot, LEAST_ALLOWED_ROOTS: lowerAgentsRoot }
});
await lowerClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'least-lower-agents-smoke', version: '0.1.0' }
});
lowerClient.notify('notifications/initialized');
const lowerOpened = await lowerClient.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
if (lowerOpened.structuredContent.agents_path !== 'agents.md') {
  throw new Error(`lowercase agents.md was reported as ${lowerOpened.structuredContent.agents_path}`);
}
const lowerContext = await lowerClient.request('tools/call', { name: 'codex_context', arguments: { target_path: 'src/demo.ts', include_ai_bridge: false, include_git: false } });
if (!lowerContext.structuredContent.agents_files.includes('agents.md')) {
  throw new Error(`codex_context did not preserve lowercase agents.md: ${lowerContext.structuredContent.agents_files.join(', ')}`);
}
if (!lowerContext.content?.[0]?.text?.includes('Lowercase instruction file loaded.')) {
  throw new Error('codex_context did not include lowercase agents.md content');
}
lowerClient.close();
console.log('✓ smoke test passed');
