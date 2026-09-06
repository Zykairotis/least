Below is the plan I would give to the model/agent working in `X:\least`.

Core objective: **stop relying on raw shell strings for routine local-dev operations**. The platform can still block some raw shell payloads before Least sees them, so the durable fix is to expose structured, narrow Least tools for HTTP/API smoke tests, Docker Compose inspection, JSON POSTs, local scripts, and safe command recipes.

---

# Plan: Make Least resilient against platform-side raw-command blocking

## 0. Problem statement

Current startup:

```bat
@echo off
least tailscale --root "X:" --allow-root "D:" --tool-mode full --bash full --shell-backend bash --write workspace --dual-client --concurrency lease --print-tools --token "<redacted>" --yolo --dashboard
echo Least exited. Press any key to close this window.
pause >nul
```

Even with:

```text
--tool-mode full
--bash full
--yolo
```

some tool calls are blocked before Least executes them:

```text
This tool call was blocked by OpenAI's safety checks.
```

This is not Least’s internal allowlist. It is the upstream platform/tool-call safety layer rejecting the raw command payload.

So the fix must be architectural:

```text
Do fewer things through raw bash strings.
Expose typed tools for common safe operations.
```

---

# 1. Design principle

Least should provide structured tools for high-frequency dev operations:

```text
HTTP GET / POST JSON
Docker Compose ps/logs/services
local API smoke suites
file-backed request bodies
script execution by package/script name
```

Instead of asking the model to emit:

```bash
curl -s -X POST -H "Origin: http://localhost:6791" -H "Content-Type: application/json" --data-raw '{"instrumentRegex":"NIFTY 50","expiryRegex":"2026-07"}' http://localhost:6795/api/tools/truedata/contracts/query
```

the model should call:

```ts
local_http_json({
  method: "POST",
  url: "http://localhost:6795/api/tools/truedata/contracts/query",
  origin: "http://localhost:6791",
  json: {
    instrumentRegex: "NIFTY 50",
    expiryRegex: "2026-07",
    includeOptions: true,
    includeFutures: false,
    includeSpot: false,
    limit: 10
  }
})
```

This avoids shell quoting, inline flags, pipes, redirects, escaping, and suspicious raw payload patterns.

---

# 2. New Least tools to add

## 2.1 `local_http_request`

Purpose: general local HTTP calls without shell.

Schema:

```ts
{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url?: string;
  baseUrl?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  origin?: string;
  json?: unknown;
  bodyText?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  followRedirects?: boolean;
}
```

Rules:

```text
- Allow localhost URLs by default:
  - http://localhost
  - http://127.0.0.1
  - http://[::1]
  - http://host.docker.internal

- Allow only http/https.
- Block file://, ftp://, ssh://, gopher://, etc.
- Block non-local hosts unless explicitly enabled by config.
- Do not execute shell.
- Serialize JSON internally.
- Parse JSON response if possible.
- Return status, headers, bodyText, json, durationMs.
```

Example response:

```ts
{
  ok: true,
  status: 200,
  statusText: "OK",
  url: "http://localhost:6795/api/tools/catalog",
  durationMs: 42,
  headers: { "content-type": "application/json" },
  json: {
    success: true,
    data: [...]
  },
  bodyText: "{\"success\":true,...}"
}
```

Recommended implementation file:

```text
src/httpOps.ts
```

Register in:

```text
src/server.ts
```

---

## 2.2 `local_http_json`

A convenience wrapper for JSON APIs.

Schema:

```ts
{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  baseUrl?: string;
  path?: string;
  url?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  origin?: string;
  json?: unknown;
  timeoutMs?: number;
}
```

This should automatically set:

```text
Accept: application/json
Content-Type: application/json when body exists
```

This is the tool most calls should use.

Example:

```ts
local_http_json({
  method: "POST",
  baseUrl: "http://localhost:6795",
  path: "/api/tools/truedata/contracts/query",
  origin: "http://localhost:6791",
  json: {
    instrumentRegex: "NIFTY 50",
    expiryRegex: "2026-07",
    includeOptions: true,
    includeFutures: false,
    includeSpot: false,
    limit: 10
  }
})
```

---

## 2.3 `api_smoke_suite`

Purpose: run several HTTP checks in one structured tool call.

Schema:

```ts
{
  baseUrl: string;
  origin?: string;
  checks: Array<{
    name?: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    json?: unknown;
    expectedStatus?: number | number[];
    expectJsonPath?: Array<{
      path: string;
      equals?: unknown;
      exists?: boolean;
      type?: "string" | "number" | "boolean" | "array" | "object" | "null";
    }>;
  }>;
  stopOnFailure?: boolean;
  timeoutMs?: number;
}
```

Example:

```ts
api_smoke_suite({
  baseUrl: "http://localhost:6795",
  origin: "http://localhost:6791",
  checks: [
    {
      name: "tools catalog",
      method: "GET",
      path: "/api/tools/catalog",
      expectedStatus: 200,
      expectJsonPath: [
        { path: "/success", equals: true }
      ]
    },
    {
      name: "master status",
      method: "GET",
      path: "/api/tools/truedata/master/status",
      expectedStatus: 200,
      expectJsonPath: [
        { path: "/data/clickhouse/healthy", equals: true },
        { path: "/data/dragonfly/healthy", equals: true }
      ]
    },
    {
      name: "NIFTY contracts",
      method: "POST",
      path: "/api/tools/truedata/contracts/query",
      json: {
        instrumentRegex: "NIFTY 50",
        expiryRegex: "2026-07",
        includeOptions: true,
        includeFutures: false,
        includeSpot: false,
        limit: 10
      },
      expectedStatus: 200,
      expectJsonPath: [
        { path: "/success", equals: true },
        { path: "/data/optionChain", type: "array" }
      ]
    }
  ]
})
```

Benefits:

```text
- No raw curl.
- Reusable validation.
- Better output than bash.
- One tool call for many checks.
```

---

## 2.4 `docker_compose_ps`

Purpose: check compose service status without raw Docker shell.

Schema:

```ts
{
  composeDir?: string;
  projectName?: string;
  format?: "table" | "json";
}
```

Implementation:

```text
Run docker compose ps --format json if available.
Fallback to docker compose ps.
Parse best-effort.
```

Return:

```ts
{
  services: [
    {
      name: "trading-backend",
      service: "trading-backend",
      state: "running",
      health: "healthy",
      ports: [...]
    }
  ],
  healthy: true,
  unhealthy: [],
  exited: []
}
```

---

## 2.5 `docker_compose_logs`

Purpose: get logs safely without shell flags.

Schema:

```ts
{
  composeDir?: string;
  service: string;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}
```

Rules:

```text
- Validate service name against docker compose config --services.
- tail min 1, max 5000.
- No shell interpolation.
```

Example:

```ts
docker_compose_logs({
  composeDir: "docker",
  service: "trading-backend",
  tail: 120
})
```

---

## 2.6 `docker_compose_services`

Purpose: list valid service names.

Schema:

```ts
{
  composeDir?: string;
}
```

Return:

```ts
{
  services: [
    "trading-backend",
    "frontend",
    "clickhouse",
    "dragonfly"
  ]
}
```

---

## 2.7 `docker_compose_health`

Purpose: one-shot container health summary.

Schema:

```ts
{
  composeDir?: string;
  includeLogsForUnhealthy?: boolean;
  logTail?: number;
}
```

Return:

```ts
{
  ok: true,
  services: [...],
  unhealthy: [],
  exited: [],
  warnings: [
    "dragonfly-exporter has no healthcheck"
  ]
}
```

This should become the default tool for “are containers OK?”

---

## 2.8 `run_package_script`

Purpose: execute package scripts without raw shell.

Schema:

```ts
{
  packageManager?: "pnpm" | "npm" | "yarn";
  filter?: string;
  script: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}
```

Example:

```ts
run_package_script({
  packageManager: "pnpm",
  filter: "@zside/frontend",
  script: "typecheck",
  timeoutMs: 180000
})
```

Internally it executes:

```text
pnpm --filter @zside/frontend typecheck
```

But the model never sends raw shell.

---

## 2.9 `run_vitest`

Purpose: run isolated tests correctly.

Schema:

```ts
{
  packageFilter?: string;
  files?: string[];
  testNamePattern?: string;
  run?: boolean;
  timeoutMs?: number;
}
```

Example:

```ts
run_vitest({
  packageFilter: "@zside/frontend",
  files: ["src/pages/Tools/__tests__/Tools.test.tsx"],
  timeoutMs: 180000
})
```

Internally:

```text
pnpm --filter @zside/frontend exec vitest run src/pages/Tools/__tests__/Tools.test.tsx
```

This avoids the exact mistake we hit:

```text
pnpm --filter @zside/frontend test -- file
```

which ran more than expected.

---

## 2.10 `write_temp_json` + `local_http_json_file`

Optional but useful.

Sometimes large JSON payloads are better as files.

`write_temp_json`:

```ts
{
  nameHint?: string;
  json: unknown;
}
```

Returns:

```ts
{
  path: ".least/tmp/request-abc123.json"
}
```

`local_http_json_file`:

```ts
{
  method: "POST" | "PUT" | "PATCH";
  url?: string;
  baseUrl?: string;
  path?: string;
  origin?: string;
  jsonFile: string;
}
```

This keeps payloads out of command strings and also allows reproducing smoke tests.

---

# 3. Config additions

Add config fields in:

```text
src/settingsSchema.ts
src/settings.ts
src/config.ts
docs/settings.md
```

Suggested settings:

```ts
{
  http: {
    enabled: true,
    allowedHosts: ["localhost", "127.0.0.1", "::1", "host.docker.internal"],
    allowedPorts: [],
    allowExternal: false,
    maxBodyBytes: 1048576,
    defaultTimeoutMs: 30000,
    allowRedirects: false
  },
  dockerCompose: {
    enabled: true,
    defaultComposeDir: "docker",
    maxLogTail: 5000,
    allowRestart: false,
    allowUpDown: false
  },
  packageScripts: {
    enabled: true,
    allowedManagers: ["pnpm", "npm"],
    defaultTimeoutMs: 180000
  }
}
```

CLI flags:

```text
--http-tools
--http-allow-host localhost
--http-allow-host 127.0.0.1
--http-allow-host host.docker.internal
--docker-compose-tools
--docker-compose-default-dir docker
```

For your launch command, later it could become:

```bat
least tailscale ^
  --root "X:" ^
  --allow-root "D:" ^
  --tool-mode full ^
  --bash full ^
  --shell-backend bash ^
  --write workspace ^
  --dual-client ^
  --concurrency lease ^
  --print-tools ^
  --token "<redacted>" ^
  --yolo ^
  --dashboard ^
  --http-tools ^
  --http-allow-host localhost ^
  --http-allow-host 127.0.0.1 ^
  --http-allow-host host.docker.internal ^
  --docker-compose-tools
```

---

# 4. Safety model

Important: the goal is not “no safety.” The goal is **predictable, scoped, local-dev safety**.

## Allow by default

```text
GET/POST/PATCH/PUT/DELETE to localhost
JSON request bodies
Docker compose ps/logs/config/services
pnpm/npm scripts inside workspace
reading logs
running tests/typechecks/builds
```

## Require explicit config or block

```text
external HTTP hosts
docker compose up/down/restart
docker rm / system prune
writing outside workspace/allow-root
arbitrary shell command composition inside structured tools
redirects to external hosts
very large request/response bodies
```

## Always redact

Least output should redact:

```text
Authorization headers
cookies
tokens
api keys
.env values
query parameters named token/key/secret/password
```

Redaction function:

```ts
redactSensitive(value: unknown): unknown
```

Apply it to:

```text
tool card output
logs
errors
debug traces
dashboard events
```

---

# 5. Implementation steps

## Phase 1: Inspect current architecture

In `X:\least`, inspect:

```text
src/server.ts
src/bashOps.ts
src/config.ts
src/settings.ts
src/settingsSchema.ts
src/toolCardWidget.ts
scripts/*.mjs
package.json
```

Find:

```text
- where tools are registered
- schema style used for existing tools
- how bash commands are executed
- how workspace roots are resolved
- how output shaping/card rendering works
- how yolo/tool-mode/bash-mode are represented
```

Do not change behavior yet.

---

## Phase 2: Add HTTP operations module

Create:

```text
src/httpOps.ts
```

Functions:

```ts
export interface LocalHttpRequestInput { ... }
export interface LocalHttpResponse { ... }

export function validateLocalHttpUrl(input, config): URL
export function buildUrl(baseUrl, path, query): URL
export async function localHttpRequest(input, context): Promise<LocalHttpResponse>
export async function localHttpJson(input, context): Promise<LocalHttpResponse>
```

Implementation notes:

```text
- Use Node fetch if runtime supports it.
- Use AbortController for timeout.
- Read response as text.
- Parse JSON if content-type includes application/json or body starts like JSON.
- Limit response body size.
- Return parsed JSON and bodyText.
```

Validation:

```ts
function isAllowedHost(hostname: string, settings: HttpSettings): boolean {
  return settings.allowedHosts.includes(hostname.toLowerCase());
}
```

Handle IPv6:

```text
::1
[::1]
```

Block:

```text
username/password in URL
non-http protocol
external host unless allowExternal true
redirects unless allowRedirects true
```

---

## Phase 3: Register HTTP tools

In `src/server.ts`, add tools:

```text
local_http_request
local_http_json
api_smoke_suite
```

Tool descriptions should explicitly say:

```text
Use this instead of bash/curl for localhost API checks and JSON POSTs.
```

This matters because future models will prefer the right tool.

---

## Phase 4: Add Docker Compose operations module

Create:

```text
src/dockerComposeOps.ts
```

Functions:

```ts
export async function composeServices(input, context)
export async function composePs(input, context)
export async function composeLogs(input, context)
export async function composeHealth(input, context)
```

Internally use existing command execution utility, but build argv safely.

Preferred implementation:

```ts
spawn("docker", ["compose", "ps", "--format", "json"], { cwd })
```

Do not build:

```ts
`docker compose logs ${service} --tail=${tail}`
```

Validate:

```text
composeDir must be inside workspace or allowed root
service must match /^[a-zA-Z0-9_.-]+$/
service must exist in docker compose config --services
tail must be bounded
```

---

## Phase 5: Register Docker tools

Add:

```text
docker_compose_services
docker_compose_ps
docker_compose_logs
docker_compose_health
```

Descriptions:

```text
Use this instead of bash/docker compose ps.
Use this instead of bash/docker compose logs.
```

---

## Phase 6: Add package/test runner tools

Create:

```text
src/packageOps.ts
src/testOps.ts
```

Tools:

```text
run_package_script
run_vitest
```

`run_package_script` builds argv:

```ts
["pnpm", "--filter", filter, script, ...args]
```

`run_vitest` builds argv:

```ts
["pnpm", "--filter", packageFilter, "exec", "vitest", "run", ...files]
```

This avoids test-script argument bugs.

---

# 6. Tests to add

Use existing script pattern in `scripts/*.mjs`.

## 6.1 HTTP unit tests

Create:

```text
scripts/local-http-unit.mjs
```

Test cases:

```text
1. Allows localhost GET.
2. Allows localhost POST JSON.
3. Blocks external host by default.
4. Blocks file:// URL.
5. Blocks URL credentials.
6. Adds Origin header.
7. Parses JSON response.
8. Enforces timeout.
9. Enforces maxBodyBytes.
10. Redacts Authorization header in output/logs.
```

## 6.2 API smoke test

Create:

```text
scripts/local-http-smoke.mjs
```

Use a tiny local HTTP server inside the script:

```text
GET /ok -> { success: true }
POST /echo -> echo JSON
```

Then call `local_http_json`.

## 6.3 Docker compose unit tests

Create:

```text
scripts/docker-compose-ops-unit.mjs
```

Mock spawn/executor.

Test:

```text
1. Validates service names.
2. Rejects invalid service name with shell metacharacters.
3. Bounds tail.
4. Parses JSON compose ps output.
5. Handles table fallback.
```

## 6.4 Package runner tests

Create:

```text
scripts/package-ops-unit.mjs
```

Test:

```text
1. pnpm filter command argv is correct.
2. vitest isolated file command is correct.
3. Rejects unknown package manager.
4. Rejects args with null bytes.
```

---

# 7. Documentation updates

Update:

```text
README.md
docs/settings.md
docs/workflows.md
```

Add a section:

```text
Why yolo does not bypass platform-side tool-call safety
```

Suggested wording:

```text
--yolo disables Least-side confirmation and allowlist friction where configured. It cannot override client/platform tool-call safety before the request reaches Least. To avoid platform-side blocks for normal local development, prefer structured tools such as local_http_json, docker_compose_ps, and run_vitest instead of raw bash strings.
```

Add recipes:

```text
Check containers:
docker_compose_health({ composeDir: "docker" })

Smoke API:
api_smoke_suite({ baseUrl, origin, checks })

Run focused frontend test:
run_vitest({ packageFilter: "@zside/frontend", files: [...] })
```

---

# 8. Tool description changes

Existing `bash` description should be changed to discourage curl/docker usage.

Current behavior says bash can run arbitrary commands in full mode. Add:

```text
Prefer local_http_json for HTTP/API calls.
Prefer docker_compose_* for Docker Compose inspection.
Prefer run_package_script/run_vitest for package scripts and tests.
Use bash only when no structured tool exists.
```

This will guide future model behavior.

---

# 9. Validation checklist

After implementation, run:

```bash
pnpm typecheck
pnpm test
```

or whatever Least uses.

Then run specific scripts:

```bash
node scripts/local-http-unit.mjs
node scripts/local-http-smoke.mjs
node scripts/docker-compose-ops-unit.mjs
node scripts/package-ops-unit.mjs
node scripts/smoke.mjs
node scripts/doctor-smoke.mjs
```

Then restart Least with your normal command.

---

# 10. Real-world validation against Quantzide

After restarting Least, open:

```text
X:\Zk-Tz
```

Then verify these should no longer require raw bash.

## Containers

```ts
docker_compose_health({
  composeDir: "docker",
  includeLogsForUnhealthy: true,
  logTail: 80
})
```

Expected:

```text
backend healthy
frontend healthy
clickhouse healthy
dragonfly healthy
```

## Tools catalog

```ts
local_http_json({
  method: "GET",
  baseUrl: "http://localhost:6795",
  path: "/api/tools/catalog",
  origin: "http://localhost:6791"
})
```

Expected:

```text
success true
truedata-backfill present
```

## NIFTY contracts query

```ts
local_http_json({
  method: "POST",
  baseUrl: "http://localhost:6795",
  path: "/api/tools/truedata/contracts/query",
  origin: "http://localhost:6791",
  json: {
    instrumentRegex: "NIFTY 50",
    expiryRegex: "2026-07",
    includeOptions: true,
    includeFutures: false,
    includeSpot: false,
    limit: 10
  }
})
```

Expected:

```text
success true
data.contracts array
data.optionChain array
```

## Manifest preview

```ts
local_http_json({
  method: "POST",
  baseUrl: "http://localhost:6795",
  path: "/api/tools/truedata/manifest/preview",
  origin: "http://localhost:6791",
  json: {
    selectedIds: [123],
    format: "tsv"
  }
})
```

Expected depends on actual ID, but it should execute and return a structured backend response, not get blocked by tool-call safety.

## Focused frontend test

```ts
run_vitest({
  packageFilter: "@zside/frontend",
  files: ["src/pages/Tools/__tests__/Tools.test.tsx"],
  timeoutMs: 180000
})
```

Expected:

```text
1 file passed
1 test passed
```

---

# 11. “Never happens later” policy

You cannot guarantee the platform will never block any raw command. But you can make normal workflows avoid raw commands.

Add this operating policy to Least docs and tool descriptions:

```text
For common workflows, models should use structured tools first:
- HTTP/API: local_http_json or api_smoke_suite
- Docker: docker_compose_*
- Tests: run_vitest or run_package_script
- Files: read/read_many/write/edit
- Git review: show_changes/git_status

Raw bash is fallback-only.
```

Also add a dashboard warning when a raw bash command resembles a known structured operation:

```text
If command starts with curl:
  Suggest local_http_json.

If command starts with docker compose ps/logs:
  Suggest docker_compose_ps/logs.

If command starts with pnpm ... vitest:
  Suggest run_vitest.
```

Optional: return a soft warning, not a hard block:

```ts
{
  warning: "This command could be expressed as local_http_json and may be more reliable through structured tools."
}
```

---

# 12. Final prompt for the coding agent

Use this:

```text
You are working in X:\least.

Goal:
Make Least resilient against platform-side raw bash/tool-call blocking by adding structured local-development tools. Do not try to bypass safety. Avoid fragile raw shell strings for HTTP JSON POSTs, Docker Compose checks, and focused test execution.

Background:
Least is launched like this:
least tailscale --root "X:" --allow-root "D:" --tool-mode full --bash full --shell-backend bash --write workspace --dual-client --concurrency lease --print-tools --token "<redacted>" --yolo --dashboard

Problem:
Even with --yolo and --bash full, some commands are blocked before reaching Least with:
"This tool call was blocked by OpenAI's safety checks."
This means the platform blocks raw shell payloads before Least executes them. Least cannot override that. Fix the workflow by adding structured tools.

Implement:
1. local_http_request
2. local_http_json
3. api_smoke_suite
4. docker_compose_services
5. docker_compose_ps
6. docker_compose_logs
7. docker_compose_health
8. run_package_script
9. run_vitest

Requirements:
- HTTP tools must allow localhost, 127.0.0.1, ::1, and host.docker.internal by default.
- HTTP tools must block external hosts by default unless config explicitly allows them.
- HTTP tools must support JSON request/response, Origin header, query params, timeout, body size limit, and structured output.
- Docker Compose tools must validate composeDir and service names, and avoid shell interpolation.
- Docker Compose logs must bound tail.
- run_vitest must run isolated files using pnpm --filter <pkg> exec vitest run <files>.
- Add redaction for Authorization, Cookie, token, key, secret, password in outputs.
- Update tool descriptions so models prefer these tools over bash/curl/docker raw commands.
- Update docs explaining that --yolo affects Least-side policy but cannot override platform-side tool-call safety.
- Add unit/smoke tests for all new operations.

Validation:
- Run Least typecheck/tests.
- Run new HTTP unit/smoke tests.
- Run new Docker Compose ops tests.
- Run package/vitest runner tests.
- Restart Least.
- Verify against X:\Zk-Tz:
  - docker_compose_health({ composeDir: "docker" })
  - local_http_json GET http://localhost:6795/api/tools/catalog with Origin http://localhost:6791
  - local_http_json POST /api/tools/truedata/contracts/query with JSON body
  - run_vitest for @zside/frontend src/pages/Tools/__tests__/Tools.test.tsx

Do not expose, print, or commit the token.
Do not remove bash; keep it as fallback.
Final report:
- files changed
- tools added
- tests run
- exact validation results
- remaining limitations
```

---

# Bottom line

The durable fix is:

```text
Less raw bash.
More structured Least tools.
```

`--yolo` is still useful, but it cannot prevent platform-side blocking. After these changes, normal Quantzide validation should use `local_http_json`, `api_smoke_suite`, `docker_compose_health`, and `run_vitest`, so this specific failure mode should become rare instead of routine.
