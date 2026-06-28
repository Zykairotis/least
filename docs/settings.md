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
  "output": {
    "mode": "compact",
    "store": true,
    "storeTtlMs": 86400000
  }
}
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

## Compatibility

Existing `LEAST_*` env variables continue to work without creating any settings files.
