# Tailscale Funnel Tunnel Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class `tailscale-funnel` tunnel mode to Least so Grok or ChatGPT connectors can keep using one stable public HTTPS hostname across restarts without reconfiguring `/mcp`, `/oauth/authorize`, or `/oauth/token`.

**Architecture:** Reuse the existing launcher pattern in `scripts/least.mjs`: start the local HTTP MCP server on `127.0.0.1:<port>`, then configure a public ingress provider and wait until `GET /healthz` succeeds over the public URL. Tailscale Funnel should be modeled as another stable tunnel provider alongside `ngrok` and `cloudflare-named`, but with provider-specific constraints: the public hostname is the device's `*.ts.net` name, public access only works through Tailscale Funnel, and configuration may persist across restarts.

**Tech Stack:** Node.js 20+, plain ESM scripts, spawned local CLIs (`tailscale`, existing `cloudflared`/`ngrok` patterns), existing smoke-test harness in `scripts/*.mjs`, Markdown docs in `README.md` and `DOMAIN_SETUP.md`.

---

## Scope and Non-Goals

**In scope**
- New tunnel mode: `tailscale-funnel`
- CLI alias: `least tailscale`
- Optional binary override: `--tailscale <path>`
- Saved-profile support via `least setup`, `least settings`, and `least start`
- `least doctor` checks for Tailscale presence and actionable prerequisites
- Grok OAuth compatibility for the new tunnel mode
- Automated smoke coverage using a fake Tailscale CLI
- Docs for setup, limitations, and stable URL behavior

**Out of scope**
- Running Tailscale installation automatically from Least
- Managing tailnet ACLs or admin-console settings from code
- Supporting `tailscale serve` private-only mode for Grok
- Supporting custom domains on top of `ts.net`
- Self-hosted Tailscale control planes or Headscale-specific logic

## Key Product Decisions

1. **Public hostname source:** Do not ask the user for a hostname. Derive it from `tailscale funnel status --json` after the funnel is configured.
2. **Persistence model:** Do not tear down Funnel configuration on normal Least exit. Tailscale documents `-bg` Funnel configs as persistent across reboot and daemon restart; that persistence is the core reason to add this mode.
3. **Conflict behavior:** If an existing Funnel config points at a different backend than `http://127.0.0.1:<port>`, fail with a clear error instead of auto-resetting the user's device-wide Funnel configuration.
4. **Grok support:** Treat `tailscale-funnel` as a valid public tunnel for `--grok-oauth`.
5. **Safety posture:** Keep `LEAST_HTTP_TOKEN` enabled exactly like other public tunnel modes. Public Tailscale Funnel still requires bearer protection on `/mcp` and reuses the existing OAuth wrapper.

## External Requirements to Bake Into UX

- Tailscale Funnel is publicly reachable over HTTPS and is the feature Grok needs; `tailscale serve` is not enough because it is private to the tailnet.
- Funnel uses the device's `*.ts.net` hostname and allowed public ports `443`, `8443`, or `10000`.
- Funnel requires MagicDNS and HTTPS enabled, and use of Funnel is governed by tailnet policy.
- `tailscale funnel status --json` exists and should be the machine-readable source of truth.
- `tailscale funnel reset` exists, but Least should not call it automatically.

Reference while implementing:
- `scripts/least.mjs`
- `README.md`
- `DOMAIN_SETUP.md`
- Tailscale Funnel docs and CLI docs

---

### Task 1: Add the CLI Surface for Tailscale Funnel

**Files:**
- Modify: `scripts/least.mjs`
- Test: `scripts/tailscale-funnel-smoke.mjs`

**Step 1: Write the failing smoke test for unsupported tunnel mode**

Create a new smoke script stub that launches `scripts/least.mjs` with `--tunnel tailscale-funnel` and a fake Tailscale binary. Start by asserting the current script rejects the tunnel value.

```js
const child = spawn('node', ['scripts/least.mjs', 'start', '--root', root, '--tunnel', 'tailscale-funnel', '--tailscale', fakeTailscale], {
  cwd: path.resolve('.'),
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});

const result = await waitForExit(child);
if (!result.stderr.includes('--tunnel must be none, cloudflare, cloudflare-named, or ngrok')) {
  throw new Error(`expected unsupported tunnel error, got:\n${result.stderr}`);
}
```

**Step 2: Run the smoke script to verify failure**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: FAIL because `tailscale-funnel` is not accepted yet.

**Step 3: Extend the CLI grammar**

In `scripts/least.mjs`, update all of these places together so the new mode is a first-class option instead of a hidden special case:

- `usage()` help text
- tunnel validation set in `main()`
- `--grok-oauth` tunnel validation
- shortcut subcommands in `main()` so `least tailscale` maps to `--tunnel tailscale-funnel`
- user-facing tunnel labels in the startup box

Implementation sketch:

```js
if (argv[0] === 'tailscale') {
  argv.shift();
  argv.unshift('--tunnel', 'tailscale-funnel');
}

if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'tailscale-funnel'].includes(tunnel)) {
  throw new Error('--tunnel must be none, cloudflare, cloudflare-named, ngrok, or tailscale-funnel');
}

if (grokOAuth && !['cloudflare', 'cloudflare-named', 'ngrok', 'tailscale-funnel'].includes(tunnel)) {
  throw new Error('--grok-oauth requires --tunnel cloudflare, cloudflare-named, ngrok, or tailscale-funnel.');
}
```

Also add the new flag to `usage()`:

```text
--tunnel <none|cloudflare|cloudflare-named|ngrok|tailscale-funnel>
tailscale-funnel = stable public https://<device>.<tailnet>.ts.net hostname via Tailscale Funnel.
--tailscale <path>        tailscale executable. Default: PATH.
```

**Step 4: Re-run the smoke script**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: FAIL later in startup, not in argument parsing. That confirms the CLI surface is wired.

**Step 5: Commit**

```bash
git add scripts/least.mjs scripts/tailscale-funnel-smoke.mjs
git commit -m "feat: add tailscale funnel cli mode scaffolding"
```

---

### Task 2: Add Tailscale Binary Resolution and Status Helpers

**Files:**
- Modify: `scripts/least.mjs`
- Test: `scripts/tailscale-funnel-smoke.mjs`

**Step 1: Expand the smoke test with a fake Tailscale binary**

Create a fake executable in the temp workspace that supports these commands:

- `tailscale version`
- `tailscale status --json`
- `tailscale funnel status --json`
- `tailscale funnel --bg <target>`

The fake binary should write deterministic JSON so the smoke test can verify parsing without a real tailnet.

```js
const fake = `#!/usr/bin/env node
import fs from 'node:fs';
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
  console.log(JSON.stringify({}))
  process.exit(0);
}
if (args[0] === 'funnel' && args[1] === '--bg') {
  process.exit(0);
}
process.exit(2);
`;
```

**Step 2: Run the smoke test to verify it still fails**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: FAIL with a missing helper path in `scripts/least.mjs`.

**Step 3: Implement the Tailscale helpers in `scripts/least.mjs`**

Add these functions near the existing `verifyNgrok`, `resolveNgrok`, and health-check helpers:

```js
function verifyTailscale(binaryPath) {
  const result = spawnSync(binaryPath, ['version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`tailscale was found, but ${binaryPath} version failed. Run tailscale version to inspect it.`);
  }
}

function resolveTailscale(args) {
  const explicit = args.tailscale ?? process.env.TAILSCALE_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyTailscale(resolved);
      return resolved;
    }
    throw new Error(`tailscale was not found at ${explicit}. Install Tailscale, add it to PATH, or pass --tailscale <path>.`);
  }
  if (commandExists('tailscale')) {
    verifyTailscale('tailscale');
    return 'tailscale';
  }
  throw new Error('tailscale was not found on PATH. Install Tailscale from https://tailscale.com/download and sign in before using --tunnel tailscale-funnel.');
}
```

Add JSON helpers for status parsing:

```js
function runJsonCli(binary, args, label) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout || '{}');
}

function normalizeTailnetDnsName(value) {
  return String(value || '').replace(/\.$/, '');
}
```

**Step 4: Re-run the smoke test**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: FAIL later in startup when the actual funnel flow is still missing.

**Step 5: Commit**

```bash
git add scripts/least.mjs scripts/tailscale-funnel-smoke.mjs
git commit -m "feat: add tailscale cli resolution helpers"
```

---

### Task 3: Implement the Tailscale Funnel Startup Path

**Files:**
- Modify: `scripts/least.mjs`
- Test: `scripts/tailscale-funnel-smoke.mjs`

**Step 1: Write a failing smoke assertion for successful public health**

Extend the smoke test so the fake Tailscale binary can emulate a Funnel route that points to the local Least server. Have the test expect `Least ready` and a `https://...ts.net/mcp` connector URL.

```js
if (!stderr.includes('Connector  public HTTPS')) {
  throw new Error(`expected public https connector output, got:\n${stderr}`);
}
if (!stdout.includes('https://least-demo.example.ts.net/mcp')) {
  throw new Error(`expected ts.net connector URL, got:\n${stdout}`);
}
```

**Step 2: Run the smoke test to verify failure**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: FAIL because the new tunnel branch does not exist yet.

**Step 3: Add a dedicated Tailscale branch in `main()`**

Insert a branch between `ngrok` and `cloudflare` handling. The branch should:

1. Resolve the Tailscale binary
2. Inspect `tailscale status --json` to confirm the daemon is running and discover the `Self.DNSName`
3. Configure Funnel in the background against `http://127.0.0.1:<port>`
4. Read `tailscale funnel status --json`
5. Derive `publicBase` from the reported DNS name
6. Wait for `GET /healthz` on the public URL using the existing bearer token
7. Print the connector block and enter the existing control panel

Implementation sketch:

```js
if (tunnel === 'tailscale-funnel') {
  const tailscalePath = resolveTailscale(effectiveArgs);
  const tailStatus = runJsonCli(tailscalePath, ['status', '--json'], 'tailscale status --json');
  if (tailStatus.BackendState !== 'Running') {
    throw new Error('Tailscale is installed but not connected. Run tailscale up and ensure the device is signed in before using --tunnel tailscale-funnel.');
  }

  const dnsName = normalizeTailnetDnsName(tailStatus?.Self?.DNSName);
  if (!dnsName) {
    throw new Error('Tailscale did not report a device DNS name. Enable MagicDNS and HTTPS in the tailnet admin console before using Funnel.');
  }

  const target = `http://127.0.0.1:${port}`;
  const funnelArgs = ['funnel', '--bg', target];
  const funnelResult = spawnSync(tailscalePath, funnelArgs, {
    encoding: 'utf8',
    shell: false,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (funnelResult.status !== 0) {
    throw new Error(`tailscale funnel failed: ${funnelResult.stderr || funnelResult.stdout || `exit ${funnelResult.status}`}`);
  }

  const publicBase = `https://${dnsName}`;
  await waitForPublicHealth(publicBase, token, { once: () => {} }, 'tailscale funnel');

  const details = printConnectorBlock(`${publicBase}/mcp`, token, { ...commonOptions });
  await runControlPanel(details);
  return;
}
```

Do **not** literally pass a fake process to `waitForPublicHealth`; instead, refactor `waitForPublicHealth` into two helpers:

- `waitForPublicHealthOnly(publicBase, token)`
- `waitForPublicHealthOrProcessExit(publicBase, token, tunnelChild, tunnelLabel)`

Use the `Only` helper for Tailscale because the command will not stay attached like `cloudflared` or `ngrok`.

**Step 4: Add conflict detection before enabling Funnel**

Parse `tailscale funnel status --json` and fail if it shows a different public mapping than the one Least wants.

Implementation target:

```js
function findExistingFunnelTarget(statusJson, expectedTarget) {
  // Accept exact proxy matches to http://127.0.0.1:<port>.
  // Return { ok: true } if reusable, { ok: false, message } if conflicting.
}
```

Failure message should tell the user exactly what to run manually if they want to clear the config:

```text
The device already has a Tailscale Funnel route that does not point to http://127.0.0.1:8787.
Run `tailscale funnel status --json` to inspect it.
If you want Least to take over, run `tailscale funnel reset` first.
```

**Step 5: Re-run the smoke test**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: PASS through the Tailscale-specific branch and print a stable `https://...ts.net/mcp` URL.

**Step 6: Commit**

```bash
git add scripts/least.mjs scripts/tailscale-funnel-smoke.mjs
git commit -m "feat: add tailscale funnel tunnel flow"
```

---

### Task 4: Wire Saved Profiles, Setup, and Settings to the New Tunnel Type

**Files:**
- Modify: `scripts/least.mjs`
- Test: `scripts/tailscale-funnel-smoke.mjs`

**Step 1: Add setup-flow expectations to the smoke harness**

Update the smoke script so it can validate the new tunnel mode through non-interactive argument parsing and through saved-profile reuse if desired.

At minimum, assert that profile serialization accepts `tailscale-funnel` without dropping the value.

**Step 2: Run the smoke script to verify failure if setup/profile logic still excludes the new mode**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: FAIL in profile or prompt logic until all enum lists are updated.

**Step 3: Update setup wizard and profile handling**

Change all tunnel-choice normalization logic to include Tailscale Funnel:

- `collectTunnelPreference`
- `normalizeSetupChoice` callers
- `tunnelChoiceFromProfile` if it assumes the old set
- `profileFromPreference`
- startup summaries and first-run copy in `scripts/least.mjs`

Decide on the prompt text:

```text
Tunnel: cloudflare, tailscale, ngrok, stable, or local?
tailscale = stable public ts.net hostname via Tailscale Funnel.
```

Do **not** ask for a hostname when `tailscale-funnel` is selected.

**Step 4: Extend `least settings set` support**

If `saveSettingsFromArgs` validates tunnel names or related fields, update it so `least settings set --tunnel tailscale-funnel` is accepted and persists correctly.

**Step 5: Re-run the smoke test**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: PASS through saved-profile code paths covered by the smoke script.

**Step 6: Commit**

```bash
git add scripts/least.mjs scripts/tailscale-funnel-smoke.mjs
git commit -m "feat: add tailscale funnel profile and setup support"
```

---

### Task 5: Extend `least doctor` for Tailscale Funnel Prerequisites

**Files:**
- Modify: `scripts/least.mjs`
- Test: `scripts/doctor-smoke.mjs`

**Step 1: Add a failing doctor assertion**

Update `scripts/doctor-smoke.mjs` so a profile using `tailscale-funnel` expects doctor output that checks for the `tailscale` binary and warns meaningfully if it is missing or disconnected.

**Step 2: Run the doctor smoke test to verify failure**

Run: `node scripts/doctor-smoke.mjs`

Expected: FAIL because the doctor does not understand the new tunnel mode yet.

**Step 3: Implement doctor checks**

Inside `runDoctor(argv)` add a branch for `tailscale-funnel` that checks:

- `tailscale` binary can be resolved
- `tailscale status --json` shows `BackendState: Running`
- a DNS name exists for the device

Doctor should stay read-only. It should not run `tailscale funnel --bg`.

Suggested output lines:

```text
OK Tailscale CLI found: tailscale
OK Tailscale daemon connected
OK Device DNS name: least-demo.example.ts.net
WARN Funnel access requires MagicDNS, HTTPS, and Funnel policy enabled in the tailnet admin console.
```

If disconnected:

```text
WARN Tailscale is installed but not connected. Run tailscale up and sign in before using --tunnel tailscale-funnel.
```

**Step 4: Re-run the doctor smoke test**

Run: `node scripts/doctor-smoke.mjs`

Expected: PASS with the new tunnel mode covered.

**Step 5: Commit**

```bash
git add scripts/least.mjs scripts/doctor-smoke.mjs
git commit -m "feat: add tailscale funnel doctor checks"
```

---

### Task 6: Finalize the Tailscale Smoke Test and Wire It Into `npm run smoke`

**Files:**
- Create: `scripts/tailscale-funnel-smoke.mjs`
- Modify: `package.json`

**Step 1: Finish the smoke script coverage**

The final smoke should cover all of these:

- unsupported mode failure before implementation
- happy-path startup using fake `tailscale`
- `https://<device>.<tailnet>.ts.net/mcp` connector URL
- Grok OAuth field generation from the Tailscale hostname
- conflict detection if an existing Funnel route points somewhere else
- saved-profile reuse if feasible with the fake binary

Minimum assertions on the happy path:

```js
if (!stdout.includes('Grok OAuth fields:')) throw new Error('missing grok fields');
if (!stdout.includes('/oauth/authorize')) throw new Error('missing authorize endpoint');
if (!stdout.includes('/oauth/token')) throw new Error('missing token endpoint');
if (!stdout.includes('https://least-demo.example.ts.net/mcp')) throw new Error('missing stable connector url');
```

**Step 2: Run the smoke test standalone**

Run: `node scripts/tailscale-funnel-smoke.mjs`

Expected: PASS.

**Step 3: Add it to the smoke chain**

Modify `package.json`:

```json
"smoke": "node scripts/smoke.mjs && node scripts/http-smoke.mjs && node scripts/grok-oauth-smoke.mjs && node scripts/tailscale-funnel-smoke.mjs && node scripts/openai-smoke.mjs && node scripts/pro-smoke.mjs && node scripts/doctor-smoke.mjs && node scripts/settings-smoke.mjs && node scripts/execute-handoff-smoke.mjs"
```

Place it after `grok-oauth-smoke` and before the OpenAI/pro/doctor scripts so tunnel-related regressions fail early.

**Step 4: Run the full smoke suite**

Run: `npm run smoke`

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json scripts/tailscale-funnel-smoke.mjs
git commit -m "test: add tailscale funnel smoke coverage"
```

---

### Task 7: Update User Documentation and Stable-URL Guidance

**Files:**
- Modify: `README.md`
- Modify: `DOMAIN_SETUP.md`
- Optional: `CHANGELOG.md`

**Step 1: Add a failing docs checklist in `progress.md` or local notes**

This is a documentation task, so the failure condition is omission. Before editing, list the required user-visible updates:

- tunnel choices mention Tailscale
- stable URL comparison includes Tailscale Funnel
- command examples show `least tailscale` or `--tunnel tailscale-funnel`
- Grok compatibility note says Tailscale Funnel is public, `tailscale serve` is not
- limitations section calls out `ts.net` hostnames, required admin settings, and bandwidth/port constraints

**Step 2: Update `README.md`**

Add Tailscale to:

- feature bullets
- first-run tunnel choice list
- startup mode examples
- stable URL recommendations
- setup instructions

Required examples:

```bash
least tailscale --root /absolute/path/to/your/repo --grok-oauth --token replace-with-a-long-stable-token --bash safe
```

and/or

```bash
least start --tunnel tailscale-funnel --root /absolute/path/to/your/repo --grok-oauth --token replace-with-a-long-stable-token
```

Explain that the public host will be the device's `https://<device>.<tailnet>.ts.net` Funnel URL.

**Step 3: Update `DOMAIN_SETUP.md`**

Add a new section such as `## Tailscale Funnel` that explains:

- when to choose it
- that it gives a stable `ts.net` hostname without needing a separate domain
- that MagicDNS, HTTPS, and Funnel policy must be enabled in the tailnet
- that Grok should use:

```text
Server URL: https://<device>.<tailnet>.ts.net/mcp
Authorization Endpoint: https://<device>.<tailnet>.ts.net/oauth/authorize
Token Endpoint: https://<device>.<tailnet>.ts.net/oauth/token
```

Also explain why this solves the “do not reconnect every restart” problem.

**Step 4: Update `CHANGELOG.md`**

Add a short entry documenting the new tunnel mode and smoke coverage.

**Step 5: Spot-check docs examples against the CLI**

Run:

```bash
least --help
least stable-help
```

Expected: examples and option lists match the docs.

**Step 6: Commit**

```bash
git add README.md DOMAIN_SETUP.md CHANGELOG.md
git commit -m "docs: document tailscale funnel stable url mode"
```

---

### Task 8: Manual Validation on a Real Tailnet

**Files:**
- No code changes required unless validation finds issues

**Step 1: Validate Tailscale prerequisites manually**

On a real machine with Tailscale installed:

```bash
tailscale version
tailscale status --json
tailscale funnel status --json
```

Expected:
- CLI works
- daemon is connected
- JSON commands return valid output

**Step 2: Start Least with the new mode**

Run:

```bash
least tailscale --root /absolute/path/to/repo --grok-oauth --tool-mode full --bash full --token keep-this-stable-token
```

Expected terminal behavior:
- local MCP starts
- Funnel config succeeds
- connector URL prints as `https://<device>.<tailnet>.ts.net/mcp`
- `g` prints Grok OAuth fields on the same host

**Step 3: Verify restart stability**

Stop Least, start it again with the same command, and confirm the connector URL does not change.

Expected: same `ts.net` host, same `/mcp`, same `/oauth/*` endpoints.

**Step 4: Verify Grok flow**

Add the connector in Grok once using the Tailscale URL. Then restart Least again and confirm Grok can still reach the same connector without editing the app.

Expected: no URL or OAuth endpoint changes required.

**Step 5: Capture validation notes**

Record any mismatch between fake-smoke assumptions and real Tailscale CLI output. If needed, adjust the parser helpers and re-run the smoke suite.

**Step 6: Final commit if fixes were needed**

```bash
git add scripts/least.mjs scripts/tailscale-funnel-smoke.mjs README.md DOMAIN_SETUP.md CHANGELOG.md
git commit -m "fix: align tailscale funnel integration with real cli behavior"
```

---

## Risks to Watch During Implementation

- `tailscale funnel status --json` shape may differ from assumptions in the fake smoke binary.
- Funnel config is device-wide and persistent; accidental auto-reset behavior would be user-hostile.
- Public DNS propagation for a newly enabled Funnel hostname may delay the first `/healthz` check.
- Some platforms may require elevated privileges or a specific Tailscale install variant for Funnel; docs and doctor output must be explicit.
- Grok OAuth setup will break if the Tailscale hostname parser leaves a trailing dot from `Self.DNSName`.

## Definition of Done

- `least tailscale` and `least start --tunnel tailscale-funnel` both work.
- `--grok-oauth` accepts the new tunnel mode.
- Saved profiles round-trip with `tailscale-funnel`.
- `least doctor` checks Tailscale-specific prerequisites.
- `scripts/tailscale-funnel-smoke.mjs` passes.
- `npm run smoke` passes.
- `README.md` and `DOMAIN_SETUP.md` document the mode clearly.
- A real restart preserves the same public `ts.net` host and Grok connector settings.

## Suggested Implementation Order

1. Task 1: CLI grammar
2. Task 2: binary/status helpers
3. Task 3: startup flow
4. Task 4: setup/profile wiring
5. Task 5: doctor checks
6. Task 6: smoke and package wiring
7. Task 7: docs
8. Task 8: real-world validation

