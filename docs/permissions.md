# Least Permissions

Permission rules control which tools and commands a workspace session can perform. Rules are defined in the `permissions` section of any settings file.

## Rule syntax

```
Tool(<name>)
Bash(<command>)
Read(<glob>)
Write(<glob>)
Edit(<glob>)
```

## Rule kinds

| Kind | Applies to | Example |
|------|-----------|---------|
| `Tool` | Any tool by name | `Tool(bash)` blocks all bash calls |
| `Bash` | `bash`/`shell` tool commands | `Bash(npm run build)` allows only npm build |
| `Read` | Read/search/file tools | `Read(src/**)` allows reading source files |
| `Write` | Write/mutation tools | `Write(plan/**)` allows writing to plan dir |
| `Edit` | Edit/patch tools | `Edit(src/**)` allows editing source files |

## Decision order

```
deny > ask > allow > fallback (existing bash mode / config)
```

A deny rule always wins over an allow rule for the same command.

## Ask behavior

`ask` rules produce a structured `permission_required` response instead of blocking or allowing. The host client may choose to prompt the user.

```json
{
  "permission_required": true,
  "tool": "bash",
  "reason": "Matched ask rule: Bash(npm run deploy *)"
}
```

## Examples

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(npm run build)",
      "Bash(npm run test *)",
      "Read(src/**)",
      "Edit(src/**)"
    ],
    "deny": [
      "Bash(curl *)",
      "Bash(git push *)",
      "Read(.env)",
      "Edit(.git/**)"
    ]
  }
}
```
