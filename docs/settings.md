# Least Settings

Least supports layered configuration via JSON/JSONC settings files.

## Settings files

| Priority | File | Purpose |
|----------|------|---------|
| 1 (highest) | `<workspace>/.least/settings.local.json` | User-local trust decisions. Gitignored. |
| 2 | `<workspace>/.least/settings.json` | Project-shared recommendations. Version-controlled. |
| 3 (lowest) | `~/.least/settings.json` | User-wide defaults. |

CLI arguments and environment variables still take precedence over all settings files.

## Settings schema

```jsonc
{
  "$schema": "https://least.dev/schemas/settings.schema.json",
  "permissions": {
    "defaultMode": "safe",
    "allow": ["Bash(npm run build)"],
    "ask": ["Bash(npm run deploy *)"],
    "deny": ["Bash(curl *)", "Bash(wget *)"],
    "additionalDirectories": []
  },
  "skills": {
    "manifest": ".least/skills.yaml",
    "allowExternalSources": false,
    "defaultVisibility": "on"
  },
  "hooks": {
    "enabled": true,
    "allowProjectHooks": false,
    "trustedHookCommands": [".least/hooks/pre-bash.js"],
    "failureMode": "safe"
  },
  "paths": {
    "additionalBlockedGlobs": ["*.secret"],
    "allowedExternalDirs": []
  },
  "tools": {
    "defaultTimeoutMs": 30000,
    "maxOutputBytes": 120000
  },
  "workflows": {
    "enabled": true,
    "allowed": ["video-study"],
    "defaultDryRun": true,
    "maxStepsDefault": 3,
    "maxStepsHardLimit": 20,
    "requireConfirmationForBulk": true,
    "stateDir": ".ai-bridge/workflows",
    "localMcpAllowlist": {}
  },
  "output": {
    "mode": "compact",
    "store": true,
    "storeTtlMs": 86400000
  },
  "http": {
    "enabled": true,
    "allowedHosts": ["localhost", "127.0.0.1", "::1", "host.docker.internal"],
    "allowedPorts": [],
    "allowExternal": false,
    "maxBodyBytes": 1048576,
    "defaultTimeoutMs": 30000,
    "allowRedirects": false
  },
  "dockerCompose": {
    "enabled": true,
    "defaultComposeDir": "docker",
    "maxLogTail": 5000,
    "allowRestart": false,
    "allowUpDown": false
  },
  "packageScripts": {
    "enabled": true,
    "allowedManagers": ["pnpm", "npm"],
    "defaultTimeoutMs": 180000
  }
}
```

## Structured local-dev tools

Least exposes typed tools so models can avoid raw shell strings that platforms may block:

| Area | Tools | CLI / env |
|------|-------|-----------|
| HTTP | `local_http_request`, `local_http_json`, `api_smoke_suite` | `--http-tools`, `--http-allow-host`, `LEAST_HTTP_*` |
| Docker Compose | `docker_compose_services`, `docker_compose_ps`, `docker_compose_logs`, `docker_compose_health` | `--docker-compose-tools`, `--docker-compose-default-dir` |
| Packages / tests | `run_package_script`, `run_vitest` | `packageScripts` settings |

### Why yolo does not bypass platform-side tool-call safety

`--yolo` disables Least-side confirmation and allowlist friction where configured. It cannot override client/platform tool-call safety before the request reaches Least. To avoid platform-side blocks for normal local development, prefer structured tools such as `local_http_json`, `docker_compose_ps`, and `run_vitest` instead of raw bash strings.

### Recipes

```text
Check containers:
docker_compose_health({ composeDir: "docker" })

Smoke API:
api_smoke_suite({ baseUrl, origin, checks })

Focused frontend test:
run_vitest({ packageFilter: "@zside/frontend", files: ["src/.../Tools.test.tsx"] })
```

## Precedence rules

- **Local** settings override **project** settings for the same keys.
- **Project** settings override **user** settings.
- CLI args override all settings files for overlapping config fields.
- Environment variables remain as fallback when no settings file exists.

## Agent terminal configuration

Local agent terminal preferences are stored in `.least/agents.local.jsonc`, not the general settings file. Use that file for:

```jsonc
{
  "terminal": {
    "preferredBackend": "zellij",
    "zellijSessionPrefix": "least-agent",
    "logFallback": true
  }
}
```

Dashboard persistence can be moved with `LEAST_DASHBOARD_DB_PATH` or `--dashboard-db-path`.

## Mutation write performance

Environment knobs for multi-file writes:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LEAST_MAX_WRITE_BYTES` | 1_000_000 | Per-file content limit for write/edit/write_many items |
| `LEAST_MAX_WRITE_MANY_BYTES` | 8_000_000 | Aggregate `write_many` **new** content limit |
| `LEAST_MAX_WRITE_MANY_ORIGINAL_BYTES` | 64_000_000 | Aggregate existing content retained for rollback |
| `LEAST_MAX_WRITE_MANY_FILES` | 200 | Max files per `write_many` call |

`write_many` is a **transactional batch with preflight + temp files + sequential renames + best-effort rollback**, not crash-safe multi-file filesystem atomicity. Parallel temp-write speedups apply to the transaction stage; end-to-end speedup is usually lower.
| `UV_THREADPOOL_SIZE` | OS/libuv default (often 4) | Optional; set **before** process start if batch FS writes benefit on your disk |

Mutation tools accept `response_mode`: `summary` | `compact_diff` | `full_diff`. Prefer `summary` during implementation and call `show_changes` once after a batch. Full diffs can be stored under a `diff_retrieval_key` and loaded with `retrieve_output`.

## Compatibility

Existing `LEAST_*` env variables continue to work without creating any settings files.
