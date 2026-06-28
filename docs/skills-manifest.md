# Skills Manifest

A `skills.yaml` file declares external skill roots that Least should discover in addition to the built-in paths.

## Paths

- Manifest file location is configured in settings:
  ```jsonc
  { "skills": { "manifest": ".least/skills.yaml" } }
  ```
- Referenced from project `.least/settings.json` or local `.least/settings.local.json`.

## Syntax

```yaml
version: 1

sources:
  - id: workspace-skills
    path: skills
    trust: workspace
    enabled: true

  - id: shared-local
    path: "X:/path/to/shared-skills"
    trust: local
    enabled: true

overrides:
  deploy:
    visibility: user-invocable-only
  legacy-context:
    visibility: name-only
  unsafe-prod:
    visibility: off
```

## Trust levels

| Trust | Source location | Required setting |
|-------|----------------|------------------|
| `workspace` | Inside the workspace | Always allowed |
| `user` | Under the home directory | Allowed from user/local settings |
| `local` | User-local absolute path | Allowed from local settings |
| `external` | Any path outside home/workspace | Requires `skills.allowExternalSources: true` |

## Visibility states

| State | Behavior |
|-------|----------|
| `on` | Listed and loadable (default) |
| `name-only` | Listed by name/description, body not auto-loaded |
| `user-invocable-only` | Only visible when explicitly requested by name |
| `off` | Hidden and not loadable |

## Duplicate resolution

When multiple sources provide a skill with the same name, use the `source` and `path` parameters in `load_skill` to disambiguate.
