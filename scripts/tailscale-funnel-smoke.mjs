import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForExit(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function readAll(stream) {
  let text = '';
  stream.on('data', (chunk) => {
    text += String(chunk);
  });
  return new Promise((resolve) => {
    stream.on('end', () => resolve(text));
    stream.on('close', () => resolve(text));
  });
}

function fakeTailscaleSource(options = {}) {
  const funnelStatus = options.conflictTarget
    ? { Funnel: { Targets: [{ Target: options.conflictTarget }] } }
    : { Funnel: { Targets: [] } };
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('1.82.0');
  process.exit(0);
}
if (args[0] === 'status' && args[1] === '--json') {
  console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'least-demo.example.ts.net.' } }));
  process.exit(0);
}
if (args[0] === 'funnel' && args[1] === 'status' && args[2] === '--json') {
  console.log(${JSON.stringify(JSON.stringify(funnelStatus))});
  process.exit(0);
}
if (args[0] === 'funnel' && args[1] === '--bg') {
  process.exit(0);
}
if (args[0] === 'funnel' && args[1] === 'reset') {
  process.exit(0);
}
process.exit(2);
`;
}

function proxySource() {
  return `import http from 'node:http';
const port = Number(process.env.LEAST_PROXY_PORT);
const targetPort = Number(process.env.LEAST_TARGET_PORT);
const server = http.createServer((req, res) => {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(String(error.message || error));
  });
  req.pipe(upstream);
});
server.listen(port, '127.0.0.1', () => {
  process.stderr.write('proxy-ready\\n');
});
`;
}

async function startProxy(tmp, targetPort) {
  const proxyPort = await getFreePort();
  const scriptPath = path.join(tmp, 'proxy.mjs');
  await fs.writeFile(scriptPath, proxySource(), 'utf8');
  const child = spawn(process.execPath, [scriptPath], {
    cwd: tmp,
    env: {
      ...process.env,
      LEAST_PROXY_PORT: String(proxyPort),
      LEAST_TARGET_PORT: String(targetPort)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let ready = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not become ready')), 10000);
    child.stderr.on('data', (chunk) => {
      ready += String(chunk);
      if (ready.includes('proxy-ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited early: ${code}`));
    });
  });
  return { child, proxyPort };
}

function runSync(args, env) {
  return spawnSync(process.execPath, ['scripts/least.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
}

async function runLauncher(args, env) {
  const child = spawn(process.execPath, ['scripts/least.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.on('exit', () => {});
  return { child };
}

async function writeFake(tmp, name, options = {}) {
  const scriptPath = path.join(tmp, `${name}.mjs`);
  const binPath = path.join(tmp, process.platform === 'win32' ? `${name}.cmd` : name);
  await fs.writeFile(scriptPath, fakeTailscaleSource(options), 'utf8');
  if (process.platform === 'win32') {
    await fs.writeFile(binPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await fs.writeFile(binPath, fakeTailscaleSource(options), { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(binPath, 0o755);
  }
  return binPath;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'least-tailscale-funnel-'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-tailscale-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'least-tailscale-home-'));
const fakeTailscale = await writeFake(tmp, 'tailscale-happy');
const fakeConflictTailscale = await writeFake(tmp, 'tailscale-conflict', { conflictTarget: 'http://127.0.0.1:9999' });

const unsupportedResult = runSync([
  'start',
  '--root', root,
  '--tunnel', 'not-a-tunnel',
  '--no-profile'
], { ...process.env, LEAST_HOME: home });
if (unsupportedResult.status === 0 || !unsupportedResult.stderr.includes('--tunnel must be none, cloudflare, cloudflare-named, ngrok, tailscale-funnel, or workers-relay')) {
  throw new Error(`unsupported tunnel validation did not fire\n${unsupportedResult.stdout}\n${unsupportedResult.stderr}`);
}

const settingsResult = runSync([
  'settings',
  'set',
  '--root', root,
  '--tunnel', 'tailscale-funnel',
  '--tailscale', fakeTailscale,
  '--token', 'least-tailscale-token'
], { ...process.env, LEAST_HOME: home });
if (settingsResult.status !== 0 || !settingsResult.stdout.includes('Saved workspace settings')) {
  throw new Error(`failed to save tailscale settings\n${settingsResult.stdout}\n${settingsResult.stderr}`);
}
const settingsShow = runSync(['settings', 'show', '--root', root], { ...process.env, LEAST_HOME: home });
if (!settingsShow.stdout.includes('tailscale-funnel')) {
  throw new Error(`settings show did not preserve tailscale-funnel\n${settingsShow.stdout}`);
}

const port = await getFreePort();
const proxy = await startProxy(tmp, port);
const preloadPath = path.join(tmp, 'preload.cjs');
await fs.writeFile(preloadPath, [
  "const dns = require('node:dns');",
  'const originalLookup = dns.lookup;',
  "dns.lookup = function(hostname, options, callback) {",
  "  if (hostname === 'least-demo.example.ts.net') {",
  "    if (typeof options === 'function') return options(null, '127.0.0.1', 4);",
  "    return callback(null, '127.0.0.1', 4);",
  '  }',
  '  return originalLookup.call(this, hostname, options, callback);',
  '};',
  'const proxyPort = process.env.LEAST_PROXY_PORT;',
  'if (proxyPort) {',
  '  const originalFetch = globalThis.fetch;',
  '  globalThis.fetch = async function(input, init) {',
  '    const url = typeof input === "string" ? input : input.url;',
  '    if (url.includes("least-demo.example.ts.net")) {',
  '      const rewritten = url.replace("https://least-demo.example.ts.net", `http://127.0.0.1:${proxyPort}`);',
  '      return originalFetch(rewritten, init);',
  '    }',
  '    return originalFetch(input, init);',
  '  };',
  '}'
].join('\n'), 'utf8');
const env = {
  ...process.env,
  LEAST_HOME: home,
  TAILSCALE_BIN: fakeTailscale,
  LEAST_PROXY_PORT: String(proxy.proxyPort),
  NODE_OPTIONS: `--no-deprecation --require ${preloadPath} --dns-result-order=ipv4first ${process.env.NODE_OPTIONS || ''}`.trim()
};

const conflict = await runLauncher([
  'tailscale',
  '--root', root,
  '--port', String(await getFreePort()),
  '--token', 'least-tailscale-token',
  '--tailscale', fakeConflictTailscale,
  '--no-profile',
  '--no-copy-url'
], { ...env, TAILSCALE_BIN: fakeConflictTailscale });
const conflictStdoutPromise = readAll(conflict.child.stdout);
const conflictStderrPromise = readAll(conflict.child.stderr);
const conflictExit = await waitForExit(conflict.child);
const conflictOutput = `${await conflictStdoutPromise}\n${await conflictStderrPromise}`;
if (conflictExit.code === 0 || !conflictOutput.includes('tailscale funnel reset')) {
  throw new Error(`expected conflicting funnel route failure\n${conflictOutput}`);
}

const happy = await runLauncher([
  'tailscale',
  '--root', root,
  '--port', String(port),
  '--grok-oauth',
  '--token', 'least-tailscale-token',
  '--tailscale', fakeTailscale,
  '--no-profile'
], env);

let happyStdout = '';
let happyStderr = '';
await new Promise((resolve, reject) => {
  happy.child.stdout.on('data', (chunk) => {
    happyStdout += String(chunk);
    if (happyStdout.includes('Least ready') && happyStdout.includes('https://least-demo.example.ts.net/oauth/token')) resolve();
  });
  happy.child.stderr.on('data', (chunk) => {
    happyStderr += String(chunk);
  });
  setTimeout(() => reject(new Error(`launcher did not become ready\nstdout:\n${happyStdout}\nstderr:\n${happyStderr}`)), 30000);
});
try { happy.child.kill('SIGKILL'); } catch {}
if (!happyStdout.includes('Connector  public HTTPS')) throw new Error(`expected public https connector output, got:\n${happyStdout}`);
if (!happyStdout.includes('https://least-demo.example.ts.net/mcp')) throw new Error(`expected stable connector URL, got:\n${happyStdout}`);
if (!happyStdout.includes('Waiting for Tailscale Funnel')) throw new Error(`expected funnel wait line, got:\n${happyStdout}`);
if (!happyStdout.includes('Grok OAuth fields:')) throw new Error(`missing grok fields:\n${happyStdout}`);
if (!happyStdout.includes('https://least-demo.example.ts.net/oauth/authorize')) throw new Error(`missing authorize endpoint:\n${happyStdout}`);
if (!happyStdout.includes('https://least-demo.example.ts.net/oauth/token')) throw new Error(`missing token endpoint:\n${happyStdout}`);

proxy.child.kill('SIGTERM');
console.log('✓ tailscale funnel smoke test passed');
