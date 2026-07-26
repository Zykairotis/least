# Changelog

## Unreleased

### Mutation performance

- Changed `edit`, `multi_edit`, and `apply_patch` to default to `response_mode=summary`, matching `write` / `write_many`. Diff generation roughly doubles mutation cost and most implementation loops never read the inline diff; pass `response_mode=compact_diff` or `full_diff` when the diff is needed, or use `show_changes` after a batch.
- Collapsed duplicate `stat` calls on the `write` / `edit` / `multi_edit` paths: the path-guard stat is now reused by the file snapshot cache instead of stat-ing the file twice before every mutation.

## 0.31.0

### Fast exploration performance

- Added `least_perf`, `batch`, `read_around`, `diff_summary`, `read_changed_files`, `context_pack`, `project_map`, `multi_edit`, `apply_patch`, and `warmup` to collapse common exploration, review, and edit loops into fewer MCP round trips.
- Added streamed line-range reads by default, concurrency-limited `read_many`, global early-stop `rg --json` search parsing, workspace/git caches with invalidation, and token-budget-aware byte caps on the high-volume read/search surfaces.
- Added `LEAST_TOOLSET` workflow profiles (`explore`, `edit`, `review`, `handoff`, `full`) and `LEAST_WARMUP` background cache priming.
- Added scale benchmark coverage with `scripts/perf-scale-benchmark.mjs` and CI benchmark gates.
- Added worker-thread offload for large unified diff generation and large project-map symbol parsing, plus lower-churn HTTP session pruning and recent-session reuse on the Streamable HTTP transport.

- Fixed native Windows ripgrep detection by probing `rg --version` directly instead of `/bin/sh command -v`, with startup capability caching in `commandCaps`.
- Made `open_current_workspace` and `open_workspace` fast by default: no tree, skill scan, global skill scan, or recent git log unless explicitly requested.
- Added high-throughput read-only tools: `files` (git ls-files / rg --files / Node fallback), `search_context` (rg -C context), `read_many` (batched reads), and `json_query` (JSON Pointer extraction for config files).
- Added `LEAST_SHELL_BACKEND` / `--shell-backend` with `auto`, `cmd`, `powershell`, `bash`, and explicit `wsl` execution backends.
- Added `LEAST_BASH_MODE=readonly` for terminal-style inspection commands (`rg`, `head`, `tail`, `cat`, `grep`, git read commands) without opening full shell access.
- Added per-tool latency and backend logging when `LEAST_LOG_TOOL_CALLS=1`, plus `scripts/fast-exploration-benchmark.mjs`, `scripts/fast-exploration-unit.mjs`, and `scripts/shell-backend-smoke.mjs`.
- Updated server instructions to prefer `files` → `search_context` → `read_many` over `tree` plus repeated `read` loops.

### Dual-client and tunnels

- Added `--dual-client` / `LEAST_DUAL_CLIENT=1` so one public HTTPS host can serve ChatGPT on `/mcp` (No Auth, tokenized URL) and Grok on `/mcp-grok` (OAuth wrapper) at the same time.
- Split MCP auth and tool security metadata by surface: ChatGPT uses `noauth`, Grok uses `oauth2`, with isolated session transport maps per route.
- OAuth protected-resource metadata now targets `/mcp-grok` in dual mode while legacy single-surface Grok behavior on `/mcp` stays unchanged.
- Extended launcher settings, doctor output, onboarding page, and docs for dual-client Tailscale/Cloudflare/ngrok workflows.
- Added `scripts/dual-client-smoke.mjs` and wired it into `npm run smoke`.

- Added Tailscale Funnel as a first-class stable public tunnel mode with `least tailscale`, `--tunnel tailscale-funnel`, and saved workspace profiles.
- Least now derives the public `https://<device>.<tailnet>.ts.net` hostname from `tailscale status --json`, runs `tailscale funnel --bg http://127.0.0.1:<port>`, and waits for public `/healthz` before printing the ChatGPT connector URL.
- Extended setup, settings, doctor, and Grok OAuth flows to support Tailscale Funnel alongside Cloudflare and ngrok.
- Added `scripts/tailscale-funnel-smoke.mjs`, `npm run connect:tailscale`, and documentation for MagicDNS/HTTPS/Funnel prerequisites.
## 0.30.0

- Added an opt-in Grok OAuth wrapper on the HTTP server: `GET /oauth/authorize`, `POST /oauth/approve`, and `POST /oauth/token`.
- Implemented PKCE-only public-client OAuth flow for Grok custom connectors; no client secret, refresh token, or second auth stack required.
- Reused `LEAST_HTTP_TOKEN` as the OAuth bearer token returned by `/oauth/token`, so Grok and direct ChatGPT MCP both keep using the same server auth.
- Added `LEAST_GROK_OAUTH` plus `LEAST_GROK_OAUTH_CLIENT_ID`, launcher flag support, Grok field output in the control panel, and onboarding/README guidance.
- Added `scripts/grok-oauth-smoke.mjs` and wired it into `npm run smoke`.

## 0.29.0

- Added OpenAI-compatible HTTP tool API on the same server as MCP: `GET /v1/models`, `POST /v1/chat/completions` (optional SSE when `stream: true`).
- v1 executes workspace tools when the client sends an `assistant` message with `tool_calls`; Least does not host or proxy a chat model in this release.
- Added shared `ToolRegistry` populated alongside MCP registration so OpenAI and MCP share the same handlers, `LEAST_TOOL_MODE` filtering, and JSON schemas (`zod-to-json-schema`).
- Added `LEAST_HTTP_PROTOCOLS` and `least start --http-protocols mcp|openai|both` (default when unset: `mcp` and `openai`). Use `mcp` only for ChatGPT-only deployments.
- Added `scripts/openai-smoke.mjs` and wired it into `npm run smoke`.

## 0.28.5

- Fixed path-scoped `show_changes` so unrelated workspace status is not reported for a clean requested path.
- Kept duplicate `load_skill` matches ambiguous until the caller supplies the exact displayed skill path.

## 0.28.4

- Made workspace cards compact by default, moving git details, discovered skills, and optional file tree output behind collapsible disclosure rows.
- Changed workspace open skill discovery to include workspace, user, and plugin skills by default while still exposing a focused `standard` tool surface.
- Added read-only `load_skill` so ChatGPT can load bounded `SKILL.md` instructions for discovered workspace, user, or plugin skills without exposing arbitrary path reads.
- Kept AGENTS detection in the workspace open result but stopped embedding the full AGENTS file in the open response; agents can read it explicitly when needed.
- Fixed setup propagation for `--widget-domain` and corrected workspace-card git status splitting for multi-file diffs.

## 0.28.3

- Added `CODEXPRO_WIDGET_DOMAIN` and the Apps SDK resource metadata keys `_meta.ui.domain` plus `_meta["openai/widgetDomain"]` so ChatGPT no longer reports that the widget domain is missing.
- Surfaced the widget domain in server config, HTTP status output, docs, env examples, and smoke tests.

## 0.28.2

- Moved ChatGPT visual cards from `bash` to the workspace open tools so the first call gives a compact project orientation instead of noisy terminal cards.
- Kept `bash` data-only for focused verification commands and strengthened server instructions to prefer `tree`, `search`, `read`, and `show_changes` for inspection/review.
- Upgraded the widget to v8 with a workspace summary renderer and a neutral waiting state instead of a stale-looking running card.

## 0.28.1

- Added `CODEXPRO_TOOL_MODE=minimal|standard|full`, with `standard` as the default focused ChatGPT tool surface and `full` preserving the previous advanced toolbox.
- Added `show_changes` as a review-oriented visual card for git status, diff stats, and optional diff while keeping raw `git_diff` data-only.
- Upgraded the ChatGPT widget to v7 with compact bash execution summaries, review cards, and cleaner handoff cards.
- Allowed `open_workspace` to accept `path` as an alias for `root` to reduce client argument mismatch failures.
- Allowed safe package scripts with colon suffixes such as `npm run build:clients` for build/test verification.
- Surfaced tool mode in server config, local status, workspace/context exports, launcher output, setup profiles, and docs.

## 0.28.0

- Added `least execute-handoff` as an opt-in local executor for `.ai-bridge/current-plan.md`.
- Added `least watch-handoff` as an opt-in local watcher that executes new handoff plans by content hash without exposing execution as a remote MCP tool.
- Added built-in local adapters for `opencode`, `pi`, and `codex`, plus a restricted `--command` template path for custom agents.
- Added `--dry-run`, `--yes`, timeout handling, stdout/stderr capture, `agent-status.md`, `implementation-diff.patch`, and `execution-log.jsonl` output.
- Kept `handoff_to_agent` planning-only; local execution is not exposed as a remote MCP tool.
- Fixed Windows release-gate coverage for symlink-escape smoke tests, Bash lookup, and custom executor paths containing spaces.
- Added smoke coverage for dry-run previews, custom command validation, execution status, diff collection, duplicate watch-plan skipping, and structured execution logging.
- Clarified that Least is an official Developer Mode/MCP workflow, not a rate-limit bypass or model access provider.

## 0.27.2

- Added `handoff_to_agent` for file-based handoffs to Codex, OpenCode, Pi, or custom local implementation agents without executing local commands.
- Extended `.ai-bridge` with generic `agent-status.md`, `implementation-diff.patch`, and `execution-log.jsonl` files.
- Updated `read_handoff`, `codex_context`, Pro apply logging, docs, and smoke coverage for generic agent handoffs.
- Fixed secret detection so benign env-var references like `process.env.TOKEN` are not blocked or redacted as literal secrets.
- Shell-quoted generated agent command hints so model names cannot inject extra shell tokens.
- Bounded append-mode handoff reads with the configured text-file size guard.

## 0.27.1

- Fail closed when HTTP MCP auth is required but `CODEXPRO_HTTP_TOKEN` is missing, including public tunnel mode and non-loopback binds.
- Block additional safe-bash bypass paths for absolute paths, parent paths, environment expansion, sensitive paths, and `find` write/action flags.
- Added smoke coverage for the missing-token HTTP startup failure and safe-bash blocked command cases.

## 0.27.0

- Kept terminal startup focused on only the connector URL and essential controls; usage prompts now belong in README/docs only.
- Made `git_diff` data-only instead of a widget-rendered tool. This reduces noisy ChatGPT cards and avoids template fetch failures for empty/no-op diffs.
- Kept visual cards scoped to high-signal outputs: source writes, exact edits, Pro context exports, and Codex handoffs.
- Updated smoke coverage so routine inspection tools stay compact.

## 0.26.0

- Removed prompt management from the terminal control panel.
- Removed the `s` hotkey and all launcher-side suggested prompt generation.
- Kept usage prompts and workflow examples in documentation instead of runtime UI.

## 0.25.0

- Simplified the ready screen so startup shows one compact status block instead of a long boxed next-step panel.
- Reduced visible controls to the common actions: open ChatGPT, copy URL, open status, copy prompt, help, and quit.
- Changed the `s` control to copy the suggested ChatGPT prompt instead of printing the full prompt repeatedly.
- Cleaned up saved setup list formatting so reused ngrok/Cloudflare profiles are easier to scan in narrow terminals.

## 0.24.0

- Added `least settings list` to show all saved workspace tunnel profiles.
- Added `least settings use` and `--from-root` to copy a saved setup from one workspace to another.
- Improved first-run `least start` behavior: if the current workspace has no settings but other saved setups exist, Least shows them as a numbered list so users can reuse an existing ngrok or Cloudflare setup instead of retyping hostnames.
- Expanded settings smoke coverage for profile listing and reuse.

## 0.23.0

- Added a compact first-run tunnel picker to `least start` when no workspace settings exist, so users can choose Cloudflare quick, ngrok, Cloudflare stable, or local mode without running the full setup wizard.
- Added `least settings` with `show`, `set`, and `delete --yes` actions for persistent per-workspace tunnel preferences.
- Persisted the selected tunnel provider, hostname, port, mode, and Least token until the user changes or deletes the workspace settings.
- Added `scripts/settings-smoke.mjs` and included it in `npm run smoke`.

## 0.22.0

- Added the v5 Apps SDK widget resource at `ui://widget/least-tool-card-v5.html` with cleaner pending states and more polished diff/search/code cards.
- Added a token-protected local setup/status page at `/` and `/setup` for workspace, mode, allowed-root, and ChatGPT setup visibility.
- Added the terminal `o` control to open the local setup/status page while Least is running.
- Updated HTTP smoke coverage to verify the onboarding page and v5 widget resource.

## 0.21.0

- Added `least doctor` as a read-only setup diagnostic for Node, build artifacts, workspace profiles, port availability, tunnel prerequisites, clipboard support, and browser-open support.
- Added `scripts/doctor-smoke.mjs` and included it in `npm run smoke`.
- Added `PUBLIC_LAUNCH_CHECKLIST.md` with release gates, ChatGPT Developer Mode golden prompts, security checks, onboarding expectations, and current non-goals.
- Added `npm run doctor` and included the public launch checklist in the npm package surface.

## 0.20.0

- Made `least setup` prompts clearer with a dim "Enter to proceed with default" hint before each defaulted input.
- Simplified the ready screen: the Server URL is described as already copied, and Enter is clearly labeled as opening ChatGPT connector settings.
- Added saved-profile hints so ngrok/Cloudflare stable setups tell users that future launches from the same workspace only need `least start`.
- Added a local port preflight with clear guidance for running two repositories at the same time.
- Documented the multi-repo rule: each concurrent repo needs its own local port, and stable public tunnels need separate hostnames.

## 0.19.0

- Added per-workspace saved profiles under `~/.least/profiles/`.
- `least setup` now saves tunnel provider, hostname, port, mode, and a generated reusable Least auth token by default.
- `least start` now loads the saved profile for the current workspace unless `--no-profile` is passed.
- Added `--save-config`, `--no-save-config`, and `--no-profile` launcher flags.

## 0.18.0

- Added ngrok as a first-class tunnel mode with `least ngrok --hostname <domain>` and `--tunnel ngrok`.
- Added ngrok support to the interactive `least setup` public URL choices.
- Added ngrok executable/config resolution with clear setup errors for missing auth or unavailable domains.
- Documented reserved ngrok domains as a stable ChatGPT connector URL option.

## 0.17.0

- Added `least setup` / `least onboard` as an interactive onboarding wizard for workspace, port, mode, and public URL strategy.
- Reworked the launcher startup and ready screens into compact framed panels with status lines instead of long setup text.
- Added `npm run connect:setup` for source checkouts.
- Documented the guided onboarding path next to the one-command `least start` flow.

## 0.16.0

- Reworked the widget pre-result state so in-progress tool calls show a compact running card instead of raw placeholder JSON.
- Added `least stable` and `--stable` as shortcuts for Cloudflare named-tunnel mode.
- Added `least stable-help` and friendlier missing-hostname guidance for fixed ChatGPT app URLs.
- Updated setup docs around stable URLs for users who cannot edit an existing ChatGPT app connector URL.

## 0.15.0

- Changed `least start` to default to agent mode with workspace writes enabled.
- Added `--mode agent`, `--mode handoff`, `--mode pro`, plus shortcut flags `--agent`, `--handoff`, and `--pro-planning`.
- Reworked the terminal startup panel to copy the Server URL, hide long setup details by default, and expose details through controls.
- Updated the default suggested ChatGPT prompt so ChatGPT edits/writes/verifies directly instead of creating a handoff plan.
- Kept handoff and Pro-context workflows as explicit modes for planning-only use.

## 0.14.0

- Added cross-platform `cloudflared` bootstrap for macOS, Windows, and Linux.
- Least now reuses `cloudflared` from PATH first, then `~/.least/bin`, then downloads the official Cloudflare release into `~/.least/bin` when needed.
- Changed `--install-cloudflared` to force a user-local reinstall instead of using Homebrew.
- Added `least install-cloudflared` for stable-domain setup without starting the MCP server.
- Kept `--no-install-cloudflared` as the opt-out for locked-down or manually managed machines.
- Updated setup docs with OS-specific notes for clipboard, browser opening, and Cloudflare Tunnel.

## 0.13.0

- Added an interactive Least terminal control panel after startup.
- Added Enter-to-open ChatGPT connector settings, `c` to copy URL, `p` to print app fields, `s` to print the suggested prompt, and `q` to stop.
- Quieted local MCP and Cloudflare logs by default so startup reads like a product flow.
- Made macOS/Homebrew `cloudflared` installation automatic by default when missing.
- Added `--no-install-cloudflared` to opt out of automatic installation.
- Changed the default user-facing start command to `npx least@latest start`.

## 0.12.0

- Added clipboard-first `Least Start` flow for ChatGPT Developer Mode.
- Public HTTPS connector URLs are copied automatically when clipboard support is available.
- Added `--open-chatgpt`, `--copy-url`, and `--no-copy-url` launcher flags.
- Added opt-in `--install-cloudflared` for macOS/Homebrew users.
- Added `npm run connect:chatgpt` for source checkouts.
- Updated README setup path around one command: `npx least@latest start --open-chatgpt`.

## 0.11.0

- Renamed the package, CLI, app labels, widget metadata, and environment variables to Least.
- Removed the duplicate CLI binary entry from `package.json`.
- Added `DOMAIN_SETUP.md` with Namecheap, Cloudflare, stable tunnel, and future hosted-relay guidance.
- Changed the generated model fallback bundle title to `Least Context Bundle`.
- Regenerated build output and package lock metadata for the Least package name.

## 0.10.0

- Prepared the project for public open-source use.
- Added npm package metadata, keywords, engine requirements, public package files, and `prepack`.
- Added `least` as a package-name binary so `npx least@latest ...` works.
- Added `least pro-bundle` and `least pro-apply` CLI subcommands.
- Added `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md`.
- Removed local runtime reports from the public package surface.
- Reworked docs to avoid private local paths and product-specific model claims.

## 0.9.0

- Added stable Cloudflare named-tunnel mode with `--tunnel cloudflare-named`.
- Added `npm run connect:stable`.
- Added support for existing tunnel names, Cloudflare dashboard tunnel tokens, token files, and cloudflared config files.
- Added stable-host health checks before printing the ChatGPT connector URL.

## 0.8.2

- Fixed duplicate `AGENTS.md` loading on case-insensitive filesystems.
- Kept `codex_context` data-only so it does not create noisy widget cards.

## 0.8.1

- Added `codex_context` for AGENTS-style instructions, `.ai-bridge` handoff files, git status, and optional git diff.

## 0.8.0

- Made widget rendering quieter by attaching visual cards only to high-signal change tools.
- Added request and tool-call logging without printing prompts, file contents, or tokens.

## 0.7.0

- Reworked the Apps SDK widget into compact developer cards.
- Kept widget CSP strict with no external fetches, fonts, scripts, images, or iframes.

## 0.6.0

- Added CSP metadata for ChatGPT Developer Mode widget rendering.
- Added `least_inventory` for sanitized skill and MCP server names.

## 0.5.0

- Added Apps SDK widget resources for selected tool outputs.

## 0.4.x

- Added `export_pro_context`.
- Added terminal helpers for creating and applying planning-context bundles.
- Added `open_current_workspace` for safer first calls from ChatGPT.
