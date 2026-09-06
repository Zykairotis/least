<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="Least logo">
</p>

<h1 align="center">Least</h1>

<p align="center">
  Let ChatGPT web see your Codex-style repo context and act like a local coding agent.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/least"><img alt="npm" src="https://img.shields.io/npm/v/least?style=flat-square"></a>
  <a href="https://github.com/Zykairotis/least/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Zykairotis/least/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/Zykairotis/least/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Zykairotis/least?style=flat-square"></a>
  <a href="https://Zykairotis.github.io/least/"><img alt="Website" src="https://img.shields.io/badge/site-GitHub%20Pages-67e8f9?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://Zykairotis.github.io/least/">Website</a>
  ·
  <a href="README_ZH.md">中文 README</a>
  ·
  <a href="https://Zykairotis.github.io/least/zh.html">中文网站</a>
  ·
  <a href="https://github.com/Zykairotis/least">Star on GitHub</a>
  ·
  <a href="https://www.npmjs.com/package/least">npm</a>
  ·
  <a href="DOMAIN_SETUP.md">Stable URL guide</a>
  ·
  <a href="FAQ.md">FAQ</a>
  ·
  <a href="SECURITY.md">Security</a>
</p>

Least turns ChatGPT Developer Mode into a local coding agent for the folder on your machine. Install it globally, run setup in a repo, paste the copied Server URL into ChatGPT Create App, and ChatGPT can inspect files, edit code, run safe verification commands, and load the same explicit context you normally give Codex through `AGENTS.md`, `.ai-bridge`, git status, git diff, and source files.

Least is not a rate-limit bypass. It uses ChatGPT's official Developer Mode and MCP app path to connect your own ChatGPT session to your own local repo. ChatGPT and Codex remain separate product surfaces, each subject to its own plan limits, safety rules, and availability.

If one workflow is unavailable and another product surface you already have access to is still available, Least lets you keep working against the same local repo without modifying or evading either product's limits.

```bash
npm install -g least
least setup
```

## Why

```text
ChatGPT web can see Codex-style context:
  AGENTS.md
  .ai-bridge plans and status
  git status and diff
  selected source files

ChatGPT web can act on your repo:
  read files
  write files
  exact-edit files
  search code
  run safe verification commands

Codex stays useful:
  execute plans locally
  handle deeper terminal-heavy work
  review or continue a handoff
```

What it gives you:

```text
Normal coding mode  ChatGPT reads, writes, edits, searches, and verifies directly.
Handoff mode        ChatGPT writes .ai-bridge/current-plan.md for a local implementation agent.
Pro planning mode   Export a durable context bundle for sessions that cannot call MCP tools.
Stable URLs         Use Tailscale Funnel, ngrok free dev domain, or Cloudflare named tunnel so the ChatGPT app URL stays fixed.
```

If your ChatGPT account exposes a stronger model in the web app, and that model/surface can call Developer Mode apps, Least lets it work against your local repo through MCP. Some ChatGPT model surfaces may not be able to call connectors or MCP tools directly. Least does not provide, proxy, resell, or unlock models; it gives compatible ChatGPT sessions local coding tools and repo context.

Least is not an OS sandbox. It is a local developer bridge with safety defaults. Read [SECURITY.md](SECURITY.md) before exposing it through a tunnel.

## Requirements

```text
Node.js 20+
ChatGPT Plus or Pro account with Apps / Developer Mode access
Developer mode enabled from Settings -> Apps -> Advanced settings
Enforce CSP in developer mode kept enabled
One public tunnel option: Cloudflare quick tunnel, Tailscale Funnel, ngrok free dev domain, or Cloudflare named tunnel
```

Current testing shows free / Go ChatGPT accounts do not expose the app flow needed for Least. Use Plus or Pro for the best experience.

Account tier and model tool support are separate things. Plus/Pro can expose Apps / Developer Mode, but a specific model surface may still be unable to call the connector. Use Pro context fallback for those sessions.

## Status

Least is a public open-source MCP bridge with conservative defaults: workspace-only writes, safe bash by default, blocked secret paths, token-protected public URLs, and compact visual cards for high-signal code changes.

Least does not bypass, avoid, increase, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. It does not provide models or account access. It only exposes local repo tools to the ChatGPT session the user already controls through official MCP and Developer Mode.

ChatGPT can do MCP-backed agentic coding in your local repo, while Codex remains available for terminal execution, review, or handoff workflows. Model, tool, and quota behavior are controlled by the product and account you connect Least to.

## Tools exposed to ChatGPT

Least defaults to `LEAST_TOOL_MODE=standard`, which keeps ChatGPT's tool picker focused on the normal coding loop plus handoff/export workflows. Use `--tool-mode minimal` for the tightest demo surface, or `--tool-mode full` when you want every compatibility and debugging tool exposed.

For workflow-specific surfaces, `LEAST_TOOLSET` can further focus the catalog without changing the underlying safety mode:

```text
explore  files, search_context, read_many, read_around, context_pack, project_map, retrieve_output, least_gain, least_discover
edit     context_pack, read_many, multi_edit, apply_patch, show_changes, retrieve_output, project_memory_*, bash
review   diff_summary, read_changed_files, search_context, show_changes, review_minimality, least_discover
handoff  export_pro_context, handoff_to_agent, read_handoff
full     everything allowed by LEAST_TOOL_MODE
```

The smaller default tool list is deliberate. ChatGPT behaves better when routine work goes through a few high-signal tools instead of a large action catalog. Installed user/plugin skills are still discovered during workspace open; they are surfaced as context in the workspace card and can be loaded on demand with `load_skill`, not exposed as dozens of separate ChatGPT actions.

Standard mode exposes:

- `server_config` — show safety modes, limits, blocked globs, and allowed roots.
- `least_perf` — inspect per-tool timings, cache hit rates, raw vs visible output sizes, compaction savings, and timeout counts.
- `least_gain` — show local compaction savings and top byte savers for the session.
- `least_discover` — report missed optimization opportunities from local telemetry.
- `retrieve_output` — recover raw compacted tool output by `sha256:` retrieval key.
- `open_current_workspace` — open the configured default workspace without accepting a path. Fastest/safest first call.
- `open_workspace` — open a local project directory using `root` or `path` and return workspace id, git status, AGENTS.md status, optional skill discovery, and optional file tree.
- `tree` — inspect files.
- `files` — fast flat candidate discovery with git / ripgrep / Node fallback and warm-cache reuse.
- `search` — search code with ripgrep or a Node fallback.
- `search_context` — search plus surrounding code in one call.
- `read_many` — read several files or ranges concurrently in one request.
- `read_around` — read around a known line number without calculating the range manually.
- `context_pack` — gather task-relevant files and snippets in one call with `profile` (`explore` | `edit` | `debug` | `review`) and score-aware selection.
- `project_map` — build a lightweight symbol map for route/function/type discovery.
- `batch` — run multiple read-only Least tools in one request.
- `load_skill` — load bounded `SKILL.md` instructions for a discovered workspace, user, or plugin skill by name, with optional source/path disambiguation.
- `read` — read text files with line numbers.
- `write` — create/overwrite one complete file. Default `response_mode=summary` (SHA-256, bytes, stats). Controlled by `LEAST_WRITE_MODE`.
- `write_many` — atomically create/overwrite many complete files in one call (preferred over repeated `write`). Default `response_mode=summary`.
- `edit` — exact text replacement. Default `response_mode=summary`. Controlled by `LEAST_WRITE_MODE`.
- `multi_edit` — apply multiple exact edits across files in one atomic call. Default `response_mode=summary`.
- `apply_patch` — apply a Codex-style patch block inside the workspace. Default `response_mode=summary`.
- `bash` — run allowlisted shell commands in the workspace. Controlled by `LEAST_BASH_MODE`. Prefer structured tools below for HTTP, Docker Compose, and tests.
- `local_http_request` / `local_http_json` / `api_smoke_suite` — localhost HTTP/JSON API calls without raw curl (blocks external hosts by default).
- `docker_compose_services` / `docker_compose_ps` / `docker_compose_logs` / `docker_compose_health` — Docker Compose inspection without raw docker shell.
- `run_package_script` / `run_vitest` — package scripts and isolated Vitest runs without fragile shell strings.
- `diff_summary` — compact changed-file summary with line counts and rough risk classification.
- `read_changed_files` — read changed source/test/config files for review without manual file picking.
- `show_changes` — one review-oriented summary with git status, untracked summaries, diff stats, and optional compact diff.
- `review_minimality` — flag likely over-engineering in the current change set.
- `project_memory_search` / `project_memory_save` / `project_memory_update` — durable local repo facts when `LEAST_PROJECT_MEMORY=1`.
- `warmup` — prime file, git, package, and symbol caches in the background server process.
- `read_handoff` — read `.ai-bridge` files.
- `export_pro_context` — write `.ai-bridge/pro-context.md` for models that cannot call MCP tools directly.
- `handoff_to_agent` — write `.ai-bridge/current-plan.md` for Codex, OpenCode, Pi, or a custom local implementation agent without executing local commands.
- `agent_list` / `agent_doctor` / `agent_terminal_doctor` / `agent_sessions` / `agent_attach_hint` — inspect configured local agent profiles, terminal backends, sessions, and attach options.
- `agent_plan` / `agent_start` / `agent_status` / `agent_watchdog` / `agent_tail` / `agent_result` — plan, launch, monitor, tail, and collect durable results from local Groundcrew-backed agents.
- `agent_cancel` / `agent_resume` / `agent_cleanup` — manage existing local agent runs without dropping back to ad hoc shell commands.

Minimal mode exposes only:

```text
server_config
open_current_workspace / open_workspace
read / write / edit
bash
show_changes
```

Full mode adds:

- `least_inventory` — list discovered skill names and configured MCP server names without exposing MCP command arguments or secrets.
- `list_workspaces` — show opened workspaces in the current MCP session.
- `workspace_snapshot` — project status plus `.ai-bridge` handoff context.
- `git_status` — inspect git status.
- `git_diff` — inspect current diff.
- `codex_context` — load Codex-style context in one call: AGENTS instructions for a target path, `.ai-bridge` files, and optional git status/diff.
- `handoff_to_codex` — compatibility wrapper for `handoff_to_agent` with `agent=codex`.

Local-only companion command:

- `least execute-handoff` — run a previously written `.ai-bridge/current-plan.md` through a local agent, then collect status, logs, and git diff. This is intentionally a CLI command, not a remote MCP tool.
- `least watch-handoff` — watch `.ai-bridge/current-plan.md` locally and run a new plan through a configured agent when its content hash changes. This is also CLI-only and is not exposed as a remote MCP tool.

The watcher is the safer way to automate handoff execution from ChatGPT Web. ChatGPT writes the plan through `handoff_to_agent`; the user-started local watcher notices the new plan and runs Pi, OpenCode, Codex, or a restricted custom command from the terminal:

```bash
least start --mode handoff
least watch-handoff --agent opencode --model provider/model --yes
```

For custom local agents:

```bash
least watch-handoff \
  --agent custom \
  --command "node ./agent.js --task-file {{plan_file}}" \
  --yes
```

Useful watcher flags:

```text
--once                  check one new plan and exit
--dry-run               show the command without executing it
--poll-interval-ms 2000 polling interval
--debounce-ms 500       wait for the plan file to become stable
--state-file <path>     duplicate-run state, default .ai-bridge/watch-handoff-state.json
```

The watcher writes the same review files as `execute-handoff`:

```text
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/execution-log.jsonl
```

### Agent tool visibility and stale-chat verification

Least treats live MCP `tools/list` as the source of truth for local agent lifecycle visibility. The intended priority order is:

1. Use direct `agent_*` tools when your client exposes them.
2. If direct tools are missing from the client manifest, use `open_workspace` / `least_inventory` and follow the Windows-native PowerShell CLI bridge examples they return.

`least start` and `least doctor` now print a compact agent-surface summary after the local MCP server is healthy or when a live server is already bound on the target port. That summary shows:

- enabled local agent profiles
- whether live MCP `tools/list` includes the core lifecycle tools `agent_start`, `agent_status`, `agent_tail`, and `agent_result`
- a stale-chat warning when the live MCP server is correct but an already-open chat may still have an old manifest
- the fallback PowerShell CLI bridge doctor command for this workspace

Official verification sequence for direct `Xacho.agent_*` exposure:

1. Restart Least from the current `X:\least` build.
2. Confirm the live MCP `tools/list` includes at least `agent_start`, `agent_status`, `agent_tail`, and `agent_result`.
3. Reconnect or refresh the ChatGPT custom connector/server.
4. Open a brand-new chat.

Existing chats may keep a stale connector manifest even when the live MCP server is already correct. When Least prints `Live MCP tools are correct; if ChatGPT does not show Xacho.agent_*, reconnect the connector and open a new chat.`, treat that as the supported next step rather than a local runtime failure.

The PowerShell CLI bridge always runs from the Least install directory and passes the target project with `--root`. This means an empty or new folder does not need its own `package.json` just to start an agent:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath 'X:\least'; npm run agent:cli -- start --root 'X:\SamplePrk' --agent oh-my-pi --prompt 'Inspect this folder and report what you find.'"
```

If the target folder name is not registered in `crew.config.ts`, Least treats it as a direct-folder job: the agent runs in that folder, logs/results are written under that folder's `.ai-bridge/agent-runs`, and Groundcrew worktree provisioning is skipped.

## Output efficiency

Least compacts noisy tool output (large diffs, search hits, test logs) deterministically at the tool boundary. Compacted results include a retrieval key when raw output is stored locally under `.least/cache/tool-output/`.

```text
LEAST_OUTPUT_MODE=compact          # default for known noisy tools
LEAST_OUTPUT_STORE=1               # store raw output when compacted
LEAST_COMPACT_SEARCH=1
LEAST_COMPACT_GIT_DIFF=1
LEAST_COMPACT_SHELL=1
LEAST_PROJECT_MEMORY=0             # set 1 to enable project memory tools + context_pack memory reads
```

Agent instruction adapters:

- Canonical source: `docs/agent-instructions/least-agent-core.md`
- Cursor: `.cursor/rules/least.mdc`
- Copilot: `.github/copilot-instructions.md`
- Windsurf: `.windsurf/rules/least.md`
- Cline: `.clinerules/least.md`
- Example repo file: `AGENTS.example.md`
- Regenerate thin adapters: `npm run generate:adapters`

## Fastest workflows

For implementation work, the shortest high-signal loop is usually:

```text
open_current_workspace
context_pack
write_many / multi_edit / apply_patch   # prefer write_many for multi-file generation
show_changes                            # once after the mutation batch
bash
```

Mutation response modes (`response_mode`):

| Mode | Use when |
| --- | --- |
| `summary` | Default for all mutation tools — metadata only, no full unified diff |
| `compact_diff` | Bounded preview when a diff is needed inline |
| `full_diff` | Explicit review — or retrieve a stored diff via `retrieve_output` using `diff_retrieval_key` |

Deprecated: `include_diff` still works (`false`→`summary`, `true`→`full_diff`); prefer `response_mode`.

For review work:

```text
open_current_workspace
diff_summary
read_changed_files
show_changes
```

For repo exploration:

```text
open_current_workspace
files or project_map
search_context
read_many or read_around
```

If you want the server to prefill hot caches on startup:

```bash
LEAST_WARMUP=files,git,package least start
```

## Visual ChatGPT cards

v0.8+ registers a reusable Apps SDK widget resource:

```text
ui://widget/least-tool-card-v8.html
```

Only high-signal workflow tools attach that resource through `_meta.ui.resourceUri` and the ChatGPT compatibility key `_meta["openai/outputTemplate"]`. In ChatGPT Developer Mode this renders compact cards for:

```text
open_current_workspace / open_workspace project summaries
write/edit diffs
show_changes review summaries
handoff/pro-context exports
```

Workspace cards stay compact by default. Git details, discovered skills, and optional file tree output are folded into disclosure rows so the chat does not fill with project inventory unless you open it.

Routine plumbing tools intentionally stay data-only and compact:

```text
server_config
least_inventory
tree
search
load_skill
read
bash
git_status / git_diff
read_handoff
workspace_snapshot
codex_context
```

`bash` and `git_diff` are intentionally data-only. Use `bash` for focused verification commands, and use `show_changes` when you want the visual review card. Empty or large raw diffs should not create a visual card or trigger a widget fetch just to say there is no output.

This avoids the noisy "every tool call becomes a card" behavior. It follows the Apps SDK decoupled pattern: data-processing tools return normal tool results, while render-worthy tools attach the widget template.

The visual cards are not unlocked by "normal coding mode" alone; the MCP server has to register an HTML resource with `text/html;profile=mcp-app` and point selected tool descriptors at it.

The widget sets both domain and CSP metadata surfaces:

```text
_meta.ui.domain
_meta["openai/widgetDomain"]
_meta.ui.csp
_meta["openai/widgetCSP"]
```

`LEAST_WIDGET_DOMAIN` defaults to `https://Zykairotis.github.io` for this package. For app submission, set it to a dedicated HTTPS origin you control, for example `https://widgets.yourdomain.com`. The CSP lists are intentionally strict because the widget has no external fetches, fonts, scripts, images, or iframes.

After upgrading or changing widget metadata, open the Least app settings in ChatGPT Developer Mode and click `Refresh` / `Refresh actions` so ChatGPT reloads the tool descriptors and resource URI.

## Install

Recommended install:

```bash
npm install -g least
```

First run from the repo you want ChatGPT to work on:

```bash
least setup
```

Daily start after setup:

```bash
least start
```

No-install fallback:

```bash
npx least@latest start --root /absolute/path/to/your/repo
```

From source:

```bash
cd least
npm install
npm run build
```

## Least Start

From the project folder you want ChatGPT to work on:

```bash
least setup
```

That is the intended low-friction first-run path. It:

```text
- uses the current folder as the workspace root
- asks for the local port, mode, tunnel provider, and stable URL choice
- saves the workspace profile for future least start runs
- starts the local HTTP MCP server
- generates a private Least token
- supports Cloudflare quick tunnel, Tailscale Funnel, ngrok free dev domain, Cloudflare stable tunnel, or local-only mode
- installs cloudflared into ~/.least/bin if Cloudflare is selected and it is missing
- waits for the public HTTPS tunnel URL
- copies the exact ChatGPT Server URL to your clipboard
- starts in normal coding mode with workspace edits enabled
- shows a compact terminal control panel
- lets you press Enter to open ChatGPT in your browser
- lets you press `o` to open a local setup/status page
```

After setup, daily use from the same repo is:

```bash
least start
```

## ChatGPT app setup

Before you paste the Least URL, turn on Developer Mode in ChatGPT:

```text
ChatGPT Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Enforce CSP in developer mode: on
-> Create app
```

This is a one-time ChatGPT setting. Keep CSP enabled; Least widgets are built for that path.

In Create App, use:

```text
Name: Least
Description: Local workspace bridge for ChatGPT coding
Connection: Server URL
Server URL: paste the copied URL
Authentication: No Authentication / None
```

The copied Server URL already includes the private Least token. Do not paste the token separately unless your ChatGPT UI supports custom headers.

Keep the terminal running while ChatGPT uses the connector. When you stop it, the quick-tunnel URL stops working.

If `cloudflared` is missing, Least downloads the official Cloudflare binary into `~/.least/bin` on supported macOS, Windows, and Linux machines. No sudo, admin shell, Homebrew, apt, or winget step is required. To skip that behavior:

```bash
least start --no-install-cloudflared
```

OS behavior:

```text
macOS    auto-installs ~/.least/bin/cloudflared, copies with pbcopy, opens ChatGPT with open
Windows  auto-installs ~/.least/bin/cloudflared.exe, copies with clip, opens ChatGPT with start
Linux    auto-installs ~/.least/bin/cloudflared, opens ChatGPT with xdg-open when available
```

Linux clipboard copy requires one of `wl-copy`, `xclip`, or `xsel`. If none is installed, Least prints the URL clearly so it can be copied manually.

First-run tunnel choice:

```text
cloudflare  Cloudflare quick tunnel. Easiest demo path, new URL each restart.
tailscale   Tailscale Funnel. Stable public https://<device>.<tailnet>.ts.net hostname.
ngrok       ngrok free dev domain. Recommended stable URL for most users.
workers     Cloudflare workers.dev relay. Stable URL, no bought domain (`least relay-deploy`).
stable      Cloudflare named tunnel. Stable URL with your own Cloudflare domain.
local       No public tunnel. Only for local MCP clients.
```

If you use quick mode, the Server URL changes every time the tunnel restarts. That means you must update the ChatGPT app Server URL each time. Use quick mode for demos, not daily work.

Recommended daily path: create a free ngrok account, use the dev domain assigned to your account, save it in `least setup`, and keep the same ChatGPT app Server URL across restarts.

Least saves the selected tunnel provider, hostname, port, mode, and auth token for that workspace. Future launches from the same folder reuse it:

```bash
least start
```

If you start Least in a new folder and already have saved setups, it shows a numbered list. Press Enter to reuse the first saved setup, type another number, or type `new` to choose a fresh tunnel.

If you are running this repository from source instead of npm:

```bash
npm run connect:chatgpt -- --root /absolute/path/to/your/repo
```

Guided onboarding:

```bash
least setup
```

`setup` asks for the workspace folder, local port, mode, and public URL strategy, then prints the exact `least start ...` command and can launch it immediately. It saves the selected tunnel provider, hostname, local port, mode, and generated Least auth token for that workspace under `~/.least/profiles/`, so future `least start` runs from the same folder can reuse the stable URL setup automatically.

From a source checkout:

```bash
npm run connect:setup
```

Preflight diagnostics:

```bash
least doctor
```

`doctor` does not start the MCP server or open a tunnel. It checks the local package build, Node version, workspace profile, port availability, tunnel prerequisites, clipboard support, and browser-open support. Run it before filing setup bugs or before recording a demo.

Use `--no-copy-url` if you do not want Least to copy the connector URL. Add `--open-chatgpt` if you want the browser to open automatically instead of pressing Enter.

Local setup/status page:

```text
press o in the Least terminal control panel
```

The page shows the active workspace, local MCP endpoint, safety modes, allowed roots, and the exact ChatGPT setup steps. It is served by the local Least process and stays token-protected when auth is enabled.

Saved workspace profile behavior:

```text
least setup
  choose quick, tailscale, stable, ngrok, or local
  enter the Cloudflare/ngrok hostname when needed
  accept the generated Least auth token
  save the profile

future least start
  loads the saved profile for the current folder
  reuses the saved tunnel provider, hostname, port, mode, and token
```

If setup finds a saved ngrok or Cloudflare stable profile, Least prints the saved hostname and the short daily command:

```bash
least start
```

That is enough from the same workspace folder. Use `least setup` again only when you want to change the port, mode, tunnel provider, hostname, or Least auth token.

Useful profile flags:

```bash
least start --no-profile      # ignore saved profile for this run
least setup --no-save-config  # run setup without saving
least setup --save-config     # explicitly save setup choices
```

Workspace settings:

```bash
least settings
least settings show
least settings list
least settings set --tunnel ngrok --hostname your-domain.ngrok-free.dev
least settings use --from-root /path/to/another/repo
least settings set --tunnel cloudflare
least settings delete --yes
```

Use `least settings` when you want to make ngrok the default, switch back to Cloudflare quick tunnels, reuse a saved setup from another repo, or delete the saved workspace preference. The saved token is redacted when settings are shown.

Terminal controls:

```text
Enter  open ChatGPT connector settings in your browser
c      copy Server URL again
o      open local setup/status page
h      show controls
q      stop Least
```

Advanced controls such as `u` for printing the full URL, `p` for Create App fields, and `m` for mode help are still available through `h`.

Startup modes:

```bash
least start                 # normal coding mode: read/write/edit/search/bash
least setup                 # guided onboarding for new users
least start --mode handoff  # planning-only .ai-bridge handoff
least start --mode pro      # export context for models without MCP tools
least stable --hostname least.example.com --tunnel-name least
least tailscale
least ngrok --hostname your-domain.ngrok-free.dev
```

## Easiest run mode

This is the lightweight launcher so you do not have to manually start the MCP server, generate a token, start Cloudflare, and copy/paste multiple fields by hand.

If you are running from source, use `npm run connect -- --root /absolute/path/to/your/repo`.

By default this:

```text
- starts the local HTTP MCP server
- generates a bearer token
- starts a Cloudflare quick tunnel
- installs `cloudflared` into `~/.least/bin` on supported OSes when it is missing
- copies the exact /mcp endpoint with a least_token query parameter
- copies the public HTTPS Server URL to your clipboard when clipboard support is available
- tells ChatGPT Developer Mode to use No Authentication / None
- uses LEAST_WRITE_MODE=workspace so ChatGPT can edit files directly
```

In ChatGPT Developer Mode, use the printed fields:

```text
Name: Least
Connection: Server URL
Server URL: https://<cloudflare-host>/mcp?least_token=<token>
Authentication: No Authentication / None
```

The copied URL contains a private local token. Treat it like a password. Prefer Bearer auth in clients that support it; query tokens can appear in browser history, proxy logs, and screenshots.

Planning-only handoff mode:

```bash
least start \
  --root /absolute/path/to/your/repo \
  --bash safe \
  --mode handoff \
  --tunnel cloudflare
```

In handoff mode, ChatGPT can create a plan for a local implementation agent without getting direct source-write access. Use `handoff_to_agent` from ChatGPT with `agent=opencode`, `agent=pi`, `agent=codex`, or a custom agent id. Least writes:

```text
.ai-bridge/current-plan.md
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/execution-log.jsonl
```

Then run the implementation locally with `least execute-handoff`:

```bash
least execute-handoff --agent opencode --model provider/cheap-model
```

Dry-run first if you want to inspect the exact command:

```bash
least execute-handoff --agent opencode --model provider/cheap-model --dry-run
```

Pi adapter:

```bash
least execute-handoff --agent pi --model provider/cheap-model
```

Custom adapter:

```bash
least execute-handoff \
  --agent custom \
  --command "my-agent --model {{model}} --task-file {{plan_file}}" \
  --model provider/cheap-model
```

Template placeholders:

```text
{{model}}      model passed with --model
{{plan_file}}  absolute path to .ai-bridge/current-plan.md
{{plan_text}}  full plan text as one argument
{{root}}       workspace root
```

By default, `execute-handoff` asks for local confirmation before running. Use `--yes` only in trusted scripts. After execution, Least writes:

```text
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/execution-log.jsonl
```

Then let ChatGPT review those files through `read_handoff` or `codex_context`.

Manual fallback:

```bash
opencode run --model provider/cheap-model "$(cat .ai-bridge/current-plan.md)"
git diff --no-ext-diff -- > .ai-bridge/implementation-diff.patch
```

For debugging whether ChatGPT is actually reaching the local server, add:

```bash
--log-requests
```

To open ChatGPT settings automatically:

```bash
least start --root /absolute/path/to/your/repo --open-chatgpt
```

To prevent automatic `cloudflared` installation:

```bash
least start --root /absolute/path/to/your/repo --no-install-cloudflared
```

Request logs print method, path, status, and duration. Least also logs tool name, success/error state, and duration as `[LeastTool] ...` lines. Query strings, file contents, and prompts are not logged, so the `least_token` and source content are not printed.

For faster ChatGPT runs, keep the first call narrow:

```text
Call open_current_workspace with include_tree=false unless you need the tree immediately.
Use tree with max_depth=2 and max_entries=100 when you need file structure.
Use load_skill only for the specific discovered skill needed for the task.
Use --tool-mode full and call least_inventory only when you want ChatGPT to see full global skill and MCP server inventory.
Do not call open_workspace after open_current_workspace unless you are switching to a different root.
Use tree/search/read for inspection, one targeted search plus show_changes for review, and bash only for focused build/test/lint verification.
```

`open_current_workspace` and `open_workspace` discover workspace, user, and plugin skills by default. Use `include_global_skills=false` when you only want repo-local instructions, or `include_skills=false` when you want the fastest possible open call. `load_skill` only accepts a discovered skill name plus optional source and exact displayed path, then reads that skill's `SKILL.md` with a bounded byte limit; it does not accept arbitrary file paths. If multiple discovered skills still match, Least returns an ambiguity error instead of guessing. `workspace_snapshot` stays narrower by default for speed. In `--tool-mode full`, use `least_inventory` for global/user/plugin skills and MCP server names. `least_inventory` reports names/descriptions and sanitized paths only; it does not expose MCP command arguments or environment values.

## Codex-style context

Least is not reading Codex's private runtime memory. It gives ChatGPT explicit workspace context through tools:

```text
open_current_workspace  root, safety mode, AGENTS.md status, git status
codex_context           AGENTS chain, .ai-bridge handoff files, optional git status/diff
read_handoff            .ai-bridge files only
workspace_snapshot      larger project snapshot plus .ai-bridge context
```

`codex_context` is the closest match to "load what Codex should know." It reads AGENTS-style instruction files from the workspace root down to a target path:

```text
AGENTS.override.md
AGENTS.md
agents.md
.agents.md
```

Then it adds:

```text
.ai-bridge/current-plan.md
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/codex-status.md
.ai-bridge/decisions.md
.ai-bridge/open-questions.md
.ai-bridge/execution-log.jsonl
git status
optional git diff
```

Use it before planning or review:

```text
Call open_current_workspace with include_tree=false.
Call codex_context with target_path="src/App.tsx" and include_diff=false.
Then inspect only the files needed for the task.
```

This keeps ChatGPT closer to Codex's instruction model without hidden state, browser memory, or repeated broad file scans.

Demo/Codex-like mode, where ChatGPT can use `write` and `edit` on source files:

```bash
least start \
  --root /absolute/path/to/your/repo \
  --bash safe \
  --write workspace \
  --tunnel cloudflare
```

Local-only mode, for local MCP clients that can reach `127.0.0.1` directly:

```bash
least start --root /absolute/path/to/your/repo --tunnel none
```

The local endpoint is usually:

```text
http://127.0.0.1:8787/mcp
```

## Pro context fallback

Some ChatGPT models or product surfaces may not be able to call Developer Mode apps, connectors, or MCP tools directly. This can include stronger planning-model surfaces even when the same ChatGPT account can create and use the Least app from other chats. When that happens, use a durable context bundle instead of fighting the tool boundary.

Generate a bundle:

```bash
least pro-bundle --root /absolute/path/to/your/repo --copy
```

This writes:

```text
.ai-bridge/pro-context.md
```

The bundle includes the file tree, git status, current diff, recent commits, selected important config files, changed files, and existing `.ai-bridge` handoff context. `--copy` also copies the bundle to the macOS clipboard when `pbcopy` is available.

Useful options:

```bash
least pro-bundle \
  --root /absolute/path/to/your/repo \
  --path src/App.tsx \
  --glob "src/**/*.ts" \
  --max-files 32 \
  --max-total-bytes 300000 \
  --copy
```

Paste the bundle into any model that cannot call MCP tools directly and ask it to produce a narrow implementation plan. Save the returned plan to a file, then apply it:

```bash
least pro-apply --root /absolute/path/to/your/repo --file plan.md
```

Or pipe from stdin:

```bash
cat plan.md | least pro-apply --root /absolute/path/to/your/repo --stdin
```

That writes:

```text
.ai-bridge/current-plan.md
```

Then run Codex, OpenCode, Pi, or another local implementation agent against `.ai-bridge/current-plan.md`.

## Cloudflare options

The launcher uses Cloudflare quick tunnels when you pass or default to:

```bash
--tunnel cloudflare
```

Quick tunnels are good for demos, but the `trycloudflare.com` URL changes whenever the tunnel restarts. Do not use quick tunnels if you want a URL users can keep in ChatGPT.

Least needs `cloudflared` for public HTTPS tunnels. The launcher first uses `cloudflared` from PATH, then `~/.least/bin`, then downloads the official Cloudflare release into `~/.least/bin` when it is missing.

```bash
least start
```

To force a fresh local install:

```bash
least install-cloudflared
```

You can also force a refresh during normal startup with `least start --install-cloudflared`.

To manage Cloudflare Tunnel yourself, opt out and pass a path:

```bash
least start --no-install-cloudflared --cloudflared /path/to/cloudflared
```

Automatic install currently supports:

```text
macOS:   arm64, x64
Windows: x64, 32-bit
Linux:   x64, 32-bit, arm64, arm
```

Other platforms can still work by installing `cloudflared` manually and passing `--cloudflared <path>`.

### Stable URL mode

For daily use, use ngrok's free dev domain, a Cloudflare named tunnel, or a Cloudflare dashboard-managed tunnel token. This gives you one stable ChatGPT connector URL, for example:

```text
https://least.example.com/mcp?least_token=<your-least-token>
```

There is one unavoidable boundary: a permanent public URL needs a tunnel provider such as Cloudflare or ngrok and a hostname reserved with that provider. Least can run the tunnel after that setup, but a quick tunnel cannot be made permanent.

If you use quick mode, you will need to edit the ChatGPT app every restart because the copied Server URL changes.

One-time Cloudflare CLI setup with your own domain:

```bash
cloudflared tunnel login
cloudflared tunnel create least
cloudflared tunnel route dns least least.example.com
```

Then daily startup is one command:

```bash
least stable \
  --root /absolute/path/to/your/repo \
  --hostname least.example.com \
  --tunnel-name least \
  --token keep-this-least-token-stable \
  --bash safe
```

Put this stable Server URL into ChatGPT Developer Mode once:

```text
https://least.example.com/mcp?least_token=keep-this-least-token-stable
```

After that, users only restart the local command. They do not need to edit the ChatGPT connector unless they change the hostname or token.

If you create a remotely managed tunnel in the Cloudflare dashboard instead, save its tunnel token to a local file and run:

```bash
least start \
  --root /absolute/path/to/your/repo \
  --tunnel cloudflare-named \
  --hostname least.example.com \
  --cloudflare-token-file ~/.least/cloudflare-tunnel-token \
  --token keep-this-least-token-stable \
  --bash safe
```

Token naming matters:

```text
--cloudflare-token-file  Cloudflare's tunnel connector token.
--token                  Least's MCP auth token used in the ChatGPT URL.
```

### Stable URL with ngrok

If you already installed ngrok and authenticated it:

```bash
ngrok config add-authtoken <your-ngrok-token>
```

Create a free ngrok account, find your assigned dev domain in the ngrok dashboard under Universal Gateway -> Domains, then start Least with:

```bash
least ngrok \
  --root /absolute/path/to/your/repo \
  --hostname your-domain.ngrok-free.dev \
  --token keep-this-least-token-stable
```

Equivalent explicit form:

```bash
least start \
  --root /absolute/path/to/your/repo \
  --tunnel ngrok \
  --hostname your-domain.ngrok-free.dev \
  --token keep-this-least-token-stable
```

Least runs ngrok in the background with:

```bash
ngrok http http://127.0.0.1:8787 --url https://your-domain.ngrok-free.dev
```

Put this Server URL into ChatGPT Developer Mode once:

```text
https://your-domain.ngrok-free.dev/mcp?least_token=keep-this-least-token-stable
```

After that, keep using the same hostname and token. You do not need to recreate the ChatGPT app unless you change either one.

### Stable URL with Tailscale Funnel

If your tailnet has MagicDNS, HTTPS certificates, and Funnel enabled, Least can publish a stable public URL on your device's `ts.net` hostname without buying a custom domain.

One-time tailnet setup in the Tailscale admin console:

```text
Enable MagicDNS
Enable HTTPS certificates
Allow Funnel for your tailnet
```

Daily startup:

```bash
least tailscale \
  --root /absolute/path/to/your/repo \
  --grok-oauth \
  --token keep-this-least-token-stable
```

Equivalent explicit form:

```bash
least start \
  --root /absolute/path/to/your/repo \
  --tunnel tailscale-funnel \
  --grok-oauth \
  --token keep-this-least-token-stable
```

Least reads your device DNS name from `tailscale status --json`, runs `tailscale funnel --bg http://127.0.0.1:<port>`, waits for public `/healthz`, and prints:

```text
https://<device>.<tailnet>.ts.net/mcp?least_token=keep-this-least-token-stable
```

If another Funnel route already points somewhere else on this machine, run `tailscale funnel reset` before starting Least.

Use Tailscale Funnel, not `tailscale serve`, for Grok or any other connector that must reach Least from the public internet. `tailscale serve` is private to your tailnet; Funnel publishes the same `ts.net` HTTPS name publicly. Tailscale Funnel is limited to the public ports your tailnet policy allows, normally 443, 8443, or 10000, while Least still listens locally on `127.0.0.1:<port>`.


After saving this in `least setup`, daily startup from that repo is just:

```bash
least start
```

Least will reuse the saved Tailscale Funnel mode and saved Least token.

### Running two repositories at the same time

You can run Least for multiple repositories at once, but each running workspace needs its own local port:

```bash
# repo A
least setup  # choose port 8787

# repo B
least setup  # choose port 8788
```

If both repositories use quick tunnels, different local ports are enough because each run gets a different temporary public URL.

If both repositories use stable ngrok or Cloudflare URLs, each repository also needs its own public hostname:

```text
repo A  port 8787  least-a.ngrok-free.dev
repo B  port 8788  least-b.ngrok-free.dev
```

Do not point two running repositories at the same local port or the same ngrok/Cloudflare hostname. The second process will fail because the port or public hostname is already owned by the first process.

For Namecheap and custom-domain setup, read [DOMAIN_SETUP.md](DOMAIN_SETUP.md). The key point is that a stable domain can solve your own repeated ChatGPT connector setup now, but a single shared URL for every future user needs a hosted relay or per-user tunnel routing.

If ChatGPT does not let you edit an existing app's Server URL, do not use quick tunnels for daily work. Use `least stable` with a Cloudflare named tunnel and put the stable URL into ChatGPT once:

```bash
least stable-help
```

For a less manual daily workflow, create a shell alias:

```bash
alias least-local='least start --root /path/to/your/repo --bash safe'
```

Then run:

```bash
least-local
```

## Manual HTTP MCP mode

```bash
LEAST_ROOT=/absolute/path/to/your/repo \
LEAST_ALLOWED_ROOTS=/absolute/path/to/your \
LEAST_BASH_MODE=safe \
LEAST_WRITE_MODE=workspace \
LEAST_HTTP_TOKEN='replace-with-long-random-token' \
npm run start:http
```

Health check:

```bash
curl 'http://127.0.0.1:8787/healthz?least_token=replace-with-long-random-token'
```

MCP endpoint:

```text
http://127.0.0.1:8787/mcp?least_token=replace-with-long-random-token
```

### Dual-client mode (ChatGPT + Grok on one host)

One Least process previously could not satisfy both ChatGPT and Grok on the same public URL because ChatGPT expects No Auth MCP metadata on `/mcp`, while Grok expects OAuth-backed MCP metadata. Dual-client mode splits the surfaces by path on one hostname:

```bash
least tailscale \
  --root /absolute/path/to/repo \
  --tool-mode full \
  --bash full \
  --write workspace \
  --dual-client \
  --token keep-this-stable-token
```

ChatGPT:

```text
Server URL: https://<public-host>/mcp?least_token=<token>
Authentication: No Authentication / None
```

Grok:

```text
MCP URL: https://<public-host>/mcp-grok
Authorization Endpoint: https://<public-host>/oauth/authorize
Token Endpoint: https://<public-host>/oauth/token
Client ID: least-grok
Scope: mcp
```

Both clients share the same workspace and the same Least bearer token. Concurrent edits from ChatGPT and Grok can conflict at the repo level; treat that as a workflow risk, not a transport bug.

### Grok OAuth wrapper

Use this only when Grok shows an OAuth-only custom connector screen and does not accept a raw MCP URL directly. If Grok accepts a public MCP URL, prefer the normal Least connector URL and skip the OAuth wrapper. For ChatGPT and Grok together on one Tailscale/Cloudflare/ngrok host, use `--dual-client` instead of `--grok-oauth` alone.

Start Least with a public tunnel and Grok OAuth enabled:

```bash
least start --grok-oauth
```

Then fill Grok with:

```text
Client ID:             least-grok            # or LEAST_GROK_OAUTH_CLIENT_ID
Client Secret:         (leave blank)
Authorization Endpoint https://<public-host>/oauth/authorize
Token Endpoint:        https://<public-host>/oauth/token
Scopes:                mcp
Token Auth Method:     none (PKCE only)
```

The MCP server URL is still the same Least public host at `/mcp`. The OAuth wrapper only exists for Grok screens that insist on manual OAuth fields.

### OpenAI-compatible tool API (v1)

The same HTTP server can expose an OpenAI-shaped **tool execution** surface at `/v1` (enabled by default together with MCP). Least **does not** run a chat model on the server in v1. Your client (or another LLM) must send an `assistant` message that already contains `tool_calls`; Least executes those tools and returns aggregated tool output in the completion body.

```text
Base URL:  http://127.0.0.1:<port>/v1
Auth:      Authorization: Bearer <LEAST_HTTP_TOKEN>
           (query ?least_token= or ?token= also works)
Protocols: LEAST_HTTP_PROTOCOLS=mcp,openai   # default
           LEAST_HTTP_PROTOCOLS=mcp           # ChatGPT /mcp only
           least start --http-protocols both|mcp|openai
```

Example (execute `server_config`):

```bash
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LEAST_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "least-tools",
    "messages": [{
      "role": "assistant",
      "content": "",
      "tool_calls": [{
        "id": "1",
        "type": "function",
        "function": { "name": "server_config", "arguments": "{}" }
      }]
    }]
  }'
```

Optional header `X-Least-Workspace-Id` selects a workspace opened via MCP; otherwise the default workspace root is used.

## Stdio MCP mode

For clients that launch local MCP commands:

```bash
node /absolute/path/to/least/dist/stdio.js \
  --root /absolute/path/to/your/repo \
  --allow-root /absolute/path/to/your \
  --bash safe \
  --write workspace
```

Example MCP config:

```json
{
  "mcpServers": {
    "Least": {
      "command": "node",
      "args": [
        "/absolute/path/to/least/dist/stdio.js",
        "--root",
        "/absolute/path/to/your/repo",
        "--allow-root",
        "/absolute/path/to/your",
        "--bash",
        "safe",
        "--write",
        "handoff"
      ]
    }
  }
}
```

## Write modes

`LEAST_WRITE_MODE=workspace` is the default normal coding mode. Use `handoff` when you want planning-only behavior and do not want ChatGPT to edit source files directly.

```text
off        write/edit tools are disabled; handoff_to_agent and handoff_to_codex still write .ai-bridge/current-plan.md
handoff    write/edit can only write inside .ai-bridge/
workspace  write/edit can write workspace files, except blocked paths
```

The launcher defaults to `workspace` in normal coding mode and `handoff` in handoff/pro planning modes.

## Tool modes

`LEAST_TOOL_MODE=standard` is the default. It exposes the normal coding loop plus `show_changes`, Pro context export, and generic agent handoff.

```text
minimal   smallest surface for demos and simple coding: open/read/write/write_many/edit/bash/show_changes
standard  default surface for normal coding plus handoff/export
full      all tools, including inventory, workspace snapshots, raw git tools, codex_context, and compatibility wrappers
```

Launcher examples:

```bash
least start --tool-mode minimal
least start --tool-mode full
```

## Bash modes

`LEAST_BASH_MODE=safe` is the default. It allows common inspection and test commands, including:

```text
pwd, ls, find
git status, git diff, git log, git show, git branch, git rev-parse, git ls-files
npm/pnpm/yarn/bun test/build/lint/typecheck/check, including suffix scripts such as npm run build:clients
pytest, go test, cargo test, cargo check, cargo clippy, tsc, eslint, biome check
```

Use the MCP `read` and `search` tools for file contents. The safe shell blocks obvious destructive commands, redirects, pipes, `curl`, `wget`, `ssh`, `docker`, `git push/reset/clean/checkout/switch/restore`, `find -exec`, `find -delete`, and file-content shell readers such as `cat`, `grep`, `rg`, `head`, and `tail`.

`LEAST_BASH_MODE=off` disables bash completely.

`LEAST_BASH_MODE=full` allows arbitrary shell commands. Use this only for trusted local repos; MCP itself is not an OS sandbox.

By default the bash environment is sanitized. To inherit your full local environment:

```bash
LEAST_INHERIT_ENV=1 LEAST_BASH_MODE=full npm run start:http
```

## Safety boundaries

Blocked by default:

```text
.env, .env.*
.git internals
node_modules
private key patterns such as *.pem, *.key, id_rsa, id_ed25519
build/cache outputs such as dist, build, .next, coverage, .cache
paths outside the opened workspace root
workspace roots outside LEAST_ALLOWED_ROOTS
symlinks that resolve outside the workspace root
symlinks that resolve to blocked paths
```

Extra blocked globs can be added with a comma-separated env var:

```bash
LEAST_BLOCKED_GLOBS='**/secrets/**,**/*.sqlite,**/*.db' least start --root /repo
```

## First ChatGPT prompt

```text
Use Least.

Call server_config first.
Then call open_current_workspace with include_tree=false.
If you need global skill or MCP server names, ask me to restart Least with --tool-mode full.

Act as a coding agent. Inspect the relevant files, make the requested source edits with write_many/write/edit/multi_edit, prefer response_mode=summary during implementation, then verify with search/read/bash and show_changes once after the mutation batch.

Keep changes scoped to the request. Do not use handoff_to_agent unless I explicitly ask for planning-only handoff.
```

## Prompt for a local agent

```text
Read .ai-bridge/current-plan.md and execute it in small, reviewable steps.

After each meaningful change, update .ai-bridge/agent-status.md with:

- what changed
- files touched
- tests, lint, or typecheck commands run
- results
- blockers or questions
- what ChatGPT or another reviewer should review next

Keep .ai-bridge/decisions.md aligned with implementation choices. Save the final review diff to .ai-bridge/implementation-diff.patch when practical. Do not overwrite .ai-bridge/current-plan.md unless asked.
```

## Demo prompt matching the screenshots

Default `least start` is already workspace-write normal coding mode.

```text
Use Least.

Open ~/tmp/least-example as the active workspace. Demonstrate each tool call while you work:

1. server_config
2. open_workspace
3. tree
4. read the relevant HTML/table file
5. write README.md explaining the demo
6. edit the repeated table row so each tool appears once
7. run one final targeted search and show_changes to verify

Narrate which Least tool you are using before each call.
```

## Recommended workflow

1. Start Least MCP against your repo with `least start --root /repo`.
2. Connect the printed endpoint in ChatGPT Developer Mode.
3. Ask ChatGPT to inspect the repo, edit files directly, and verify the work with search/read/bash/git tools.
4. If your chosen ChatGPT model cannot call tools, run `least pro-bundle --root /repo --copy`, paste the bundle into that model, then apply its plan with `least pro-apply --root /repo --file plan.md`.
5. Use `least start --mode handoff` only when you want ChatGPT to write `.ai-bridge/current-plan.md` for Codex, OpenCode, Pi, or another local implementation agent instead of editing source files itself.

## Development

```bash
npm install
npm run build
npm run smoke
npm run doctor -- --tunnel none
```

Before publishing or opening a pull request, check:

```bash
npm pack --dry-run
```

The package should not include local runtime reports, `.ai-bridge`, `.env` files, tunnel tokens, or generated tarballs.

For public release gates, see [PUBLIC_LAUNCH_CHECKLIST.md](PUBLIC_LAUNCH_CHECKLIST.md). For contribution and security boundaries, see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT
