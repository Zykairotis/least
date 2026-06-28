import { spawnSync } from 'node:child_process';
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

async function writeFakeTailscale(tmp) {
  const scriptPath = path.join(tmp, 'tailscale.mjs');
  const binPath = path.join(tmp, process.platform === 'win32' ? 'tailscale.cmd' : 'tailscale');
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('1.82.0');
  process.exit(0);
}
if (args[0] === 'status' && args[1] === '--json') {
  console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'least-demo.example.ts.net.' } }));
  process.exit(0);
}
process.exit(2);
`;
  await fs.writeFile(scriptPath, source, 'utf8');
  if (process.platform === 'win32') {
    await fs.writeFile(binPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await fs.writeFile(binPath, source, { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(binPath, 0o755);
  }
  return binPath;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'least-doctor-smoke-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'least-doctor-home-'));
const port = await getFreePort();
const result = spawnSync(process.execPath, [
  'scripts/least.mjs',
  'doctor',
  '--root',
  root,
  '--port',
  String(port),
  '--tunnel',
  'none'
], {
  cwd: path.resolve('.'),
  env: { ...process.env, LEAST_HOME: home },
  encoding: 'utf8'
});

if (result.status !== 0) {
  throw new Error(`doctor failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

const output = `${result.stdout}\n${result.stderr}`;
for (const expected of ['Least doctor', 'Node', 'Build artifacts', 'Local port', 'Ready']) {
  if (!output.includes(expected)) {
    throw new Error(`doctor output missing ${expected}\n${output}`);
  }
}

const fakeTailscale = await writeFakeTailscale(home);
const tailscalePort = await getFreePort();
const tailscaleResult = spawnSync(process.execPath, [
  'scripts/least.mjs',
  'doctor',
  '--root',
  root,
  '--port',
  String(tailscalePort),
  '--tunnel',
  'tailscale-funnel',
  '--tailscale',
  fakeTailscale
], {
  cwd: path.resolve('.'),
  env: { ...process.env, LEAST_HOME: home, NODE_OPTIONS: `--no-deprecation ${process.env.NODE_OPTIONS || ''}`.trim() },
  encoding: 'utf8'
});

if (tailscaleResult.status !== 0) {
  throw new Error(`tailscale doctor failed\nstdout:\n${tailscaleResult.stdout}\nstderr:\n${tailscaleResult.stderr}`);
}

const tailscaleOutput = `${tailscaleResult.stdout}\n${tailscaleResult.stderr}`;
for (const expected of ['Tailscale CLI', 'Tailscale daemon', 'Device DNS name', 'least-demo.example.ts.net', 'Funnel policy']) {
  if (!tailscaleOutput.includes(expected)) {
    throw new Error(`tailscale doctor output missing ${expected}\n${tailscaleOutput}`);
  }
}

console.log('doctor smoke test passed');
