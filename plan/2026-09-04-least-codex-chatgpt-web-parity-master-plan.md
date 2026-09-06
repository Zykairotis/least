# Least Desktop + Codex/ChatGPT Web Parity Master Plan

Date: 2026-09-04
Status: implementation master plan
Workspace: `/home/mewtwo/ZSSD/least`
Observed branch: `rebrand-to-least`
Least baseline: `least@0.31.0`
Primary reference: `miuuyy/codex-chatgpt-web`
Pinned reference commit: `9a7428a9d1fced9baaa85112994c02c011a3b7c9` (2026-09-04)
Pinned reference release: `v5.0.1`

---

## 1. Goal

Make Least feel as complete, polished, self-contained, and native as `codex-chatgpt-web`, including the desktop application, onboarding, browser/session handling, Codex model integration, setup wizard, MCP/tunnel setup, runtime supervision, diagnostics, updater, packaging, cross-platform validation, and the detailed interaction states that make the reference product feel finished.

The target is **behavioral/product parity, not source-copy parity**. Reproduce the useful product contracts and workflows while preserving Least's own identity, branding, code structure, security model, and stronger structured local-tool/agent architecture.

The final product should support three first-class ways to use Least:

1. **Least Direct / Official Connector** — the current safest path: ChatGPT Developer Mode/Apps connects directly to Least MCP and uses Least's structured local tools.
2. **Least Web Manual** — Codex can route a task through ChatGPT Web while the user manually pastes/sends the prepared prompt; Least never reads or mutates the ChatGPT DOM in this mode.
3. **Least Web Automatic** — optional/experimental automation that presents ChatGPT Web models inside Codex and drives task-bound ChatGPT Temporary Chats while preserving Codex task context, streaming, images, and the native tool lifecycle.

Least must remain useful without the desktop app and without browser automation. Existing `least`, `least-mcp`, and `least-mcp-http` CLI/MCP workflows are compatibility requirements, not migration leftovers.

---

## 2. Product principle: parity where it helps, superiority where Least is already stronger

Do not turn Least into a clone whose only purpose is browser routing. The desired end state is:

```text
                         Least Desktop (Electron)
┌──────────────────────────────────────────────────────────────────────┐
│ Renderer                                                             │
│  Browser | Setup | MCP | Activity | Settings | Tools | Agents | Git │
│                                                                      │
│ Electron main process                                                │
│  BrowserHost      RuntimeSupervisor      Update/Install Manager      │
│       │                    │                       │                  │
└───────┼────────────────────┼───────────────────────┼──────────────────┘
        │                    │                       │
        │         ┌──────────▼───────────────────────▼──────────┐
        │         │                Least Core                    │
        │         │ existing MCP + structured tools             │
        │         │ context/search/edit/git/test/docker/agents   │
        │         │                                              │
        │         │ optional new modules:                        │
        │         │ Responses Bridge | Capability Broker         │
        │         │ Session/Compaction | Route Journal           │
        │         └────────────────────┬─────────────────────────┘
        │                              │
        ▼                              ▼
ChatGPT Web profile            Codex / ChatGPT / local agents
(task-bound views)             / external OpenAI-compatible router
```

Least should copy the **product completeness** of the reference while keeping these Least advantages:

- structured filesystem/search/edit/review operations instead of forcing generic shell use;
- `context_pack`, `project_map`, reversible output compaction, and performance telemetry;
- direct local agent orchestration across Codex, Claude Code, Grok, PIV/Pi, and registered custom agents;
- local workflows and durable handoffs;
- project memory;
- explicit workspace containment and write/permission controls;
- current official ChatGPT Developer Mode connector path.

---

## 3. Reference source-of-truth map

Implementation agents should inspect the pinned reference commit, not whatever `main` becomes later. Record the SHA in every parity audit.

### 3.1 Reference files to study

| Reference file | What to learn from it |
|---|---|
| `README.md` | Product modes, setup flow, model routing behavior, limitations. |
| `docs/architecture.md` | Responses proxy, browser lifecycle, retained conversations, route ownership, compaction, process lifecycle. |
| `docs/security-model.md` | Trust boundaries, turn-scoped capability rules, loopback assumptions, browser-state risks. |
| `docs/release-validation.md` | What CI cannot prove and which live account-bound checks must block release. |
| `package.json` | Runtime dependencies and validation scripts. |
| `.github/workflows/ci.yml` | macOS/Windows/Linux build and package validation. |
| `launcher/package.json` | Electron/React/Vite packaging structure and target artifacts. |
| `launcher/src/App.tsx` | Full launcher navigation, onboarding, Browser/Setup/MCP/Activity/Settings behavior. |
| `launcher/src/types.ts` | Launcher state, browser tab state, doctor reports, operation/update states, IPC contract. |
| `launcher/src/tokens.css` | Tokenized UI-system approach. Do not copy branding or exact visual assets. |
| `launcher/src/styles.css` | Layout/detail inventory for parity screenshots. |
| `launcher/electron/preload.cjs` | Narrow typed renderer-to-main IPC bridge. |
| `launcher/electron/main.cjs` | Window/process orchestration. |
| `launcher/electron/browser-host.cjs` | Persistent browser host, task-bound views, login, tab lifecycle. |
| `launcher/electron/control-server.cjs` | Desktop/runtime control boundary. |
| `launcher/electron/logging.cjs` | Safe local launcher diagnostics. |
| `launcher/electron/autostart.cjs` | Cross-platform launch-at-login behavior. |
| `src/bridge.ts` | Responses request/stream bridge boundaries. |
| `src/chatgpt-session.ts` | Chat/session identity and retention. |
| `src/chatgpt-web-models.ts` | Routed model catalog behavior. |
| `src/codex-integration*.ts` | Transactional Codex configuration and route journal. |
| `src/adapters/chatgpt-web/` | Browser adapter, prompt/context, concurrency, compaction, token accounting. |

### 3.2 Negative-reference issues to convert into Least regression tests

Do not copy known failure modes. At minimum study these reference reports while implementing:

- **#318** — manual/Zero Risk continuation can fail at automatic compaction because a completed trace is reused.
- **#316** — multipart compaction transport can stall while one global timeout hides which stage failed.
- **#312** — automated browser use can trigger a ChatGPT suspicious-activity warning.
- **#205** — route ownership can conflict with an external router/provider unless external-provider mode is explicit.

These are not reasons to avoid the architecture. They are requirements for a stricter state model in Least.

---

## 4. Current Least baseline and constraints

### 4.1 Keep these existing surfaces

Least already has substantial infrastructure that should be reused rather than reimplemented:

- MCP stdio and Streamable HTTP;
- token-protected HTTP and tunnel support;
- filesystem/path guards;
- blocked sensitive globs and symlink containment;
- workspace locks and stale-write protection;
- `files`, `search`, `search_context`, `read`, `read_many`, `context_pack`, `project_map`;
- atomic-ish multi-file mutations and patch preview/apply;
- localhost HTTP, Docker Compose, package-script, and Vitest structured tools;
- git/review tools;
- output shaping, raw-output retrieval, performance accounting;
- hooks/permissions;
- project memory;
- local agent lifecycle and Groundcrew-backed orchestration;
- dashboard event stream and SQLite persistence.

### 4.2 Current architectural debt to address before piling on desktop/browser state

`src/server.ts` is currently a very large central registration/orchestration file. Do not add browser routing, desktop control, or Responses bridging directly into it.

The first implementation phase must extract tool-registration modules and create explicit service boundaries. Otherwise the parity project will turn a large server file into an unreviewable product kernel.

### 4.3 Preserve existing CLI compatibility

These must continue to work throughout the project:

```text
least
least setup
least start
least doctor
least-mcp
least-mcp-http
```

The desktop app must be additive. A user who never installs the Electron app should still be able to use Least exactly as before.

### 4.4 Dirty-worktree precondition

The currently observed worktree already contains many modified/untracked files. The implementation agent must **not** auto-clean, reset, stash, or rewrite unrelated current work.

Before implementation begins:

1. review current `git status`;
2. preserve the user's existing changes by explicit commit/branch/worktree choice;
3. create a dedicated implementation branch/worktree such as `feat/least-desktop-parity-v1`;
4. make each parity phase independently reviewable.

---

## 5. Definition of parity

“Similar down to every detail” should be measured by a parity ledger rather than intuition.

Create:

```text
docs/parity/codex-chatgpt-web-v5.0.1.md
```

For every reference behavior record:

```text
ID
surface
reference behavior
Least target behavior
reference evidence
implementation module
unit/integration test
manual validation step
status: missing | partial | equivalent | better | intentionally-not-copied
```

The ledger must cover at least:

- first launch/onboarding;
- window/titlebar behavior;
- sidebar/open/compact behavior;
- browser view and tabs;
- login/logout/session refresh;
- setup steps;
- model installation/route configuration;
- MCP/tunnel wizard;
- connector verification;
- activity logs and safe export;
- settings toggles;
- update states;
- manual task workflow;
- automatic task workflow;
- task cancellation;
- app close/keep-running behavior;
- restart/recovery;
- compaction;
- route uninstall/restore;
- all visible loading/error/success states;
- keyboard/focus behavior;
- responsive window behavior;
- platform differences.

### Visual parity corpus

Capture reference screenshots/videos at a fixed set of dimensions, for example:

```text
1440 x 900
1200 x 800
1000 x 700
820 x 700
760 x 650
```

Record states such as:

- onboarding step 1/2/3;
- browser signed out;
- browser signed in/no active task;
- browser active task;
- manual prompt waiting/sent/running;
- setup incomplete/complete;
- MCP wizard each step;
- Activity empty/populated;
- Settings;
- update available/installing;
- error toast;
- session-refresh reminder;
- compact sidebar.

Use screenshot-diff testing for Least's own stable UI, but do not treat pixel identity to another product's branding as a goal. Match information hierarchy, density, transitions, and interaction quality using Least branding.

---

# PART I — FOUNDATIONS

## 6. Phase 0 — Baseline, contracts, and reproducible reference

### Goal

Create a stable starting point so later parity claims are auditable.

### Work

1. Pin the reference SHA in `docs/parity/`.
2. Create the parity ledger described above.
3. Capture current Least behavior:
   - CLI setup;
   - direct MCP connection;
   - dashboard;
   - direct agent orchestration;
   - current test/benchmark results.
4. Record OS-specific environments used for validation.
5. Add a top-level parity validation command eventually named something like:

```text
npm run verify:desktop-parity
```

It should become an aggregate of deterministic local tests, not live ChatGPT automation.

### Acceptance

- Reference SHA is fixed.
- Current Least CLI behavior is documented and regression-tested.
- Every planned reference surface has a parity-ledger row.
- No feature implementation has begun before this baseline exists.

---

## 7. Phase 1 — Modularize Least core before adding the new product layers

### Goal

Turn the current server into a composition root rather than the implementation location for every tool and subsystem.

### Proposed structure

```text
src/
  core/
    services.ts
    runtimeContext.ts
    errors.ts
  tools/
    registerFilesystemTools.ts
    registerSearchTools.ts
    registerMutationTools.ts
    registerGitTools.ts
    registerReviewTools.ts
    registerRuntimeTools.ts
    registerHttpTools.ts
    registerDockerTools.ts
    registerPackageTools.ts
    registerAgentTools.ts
    registerWorkflowTools.ts
    registerMemoryTools.ts
    registerCapabilityTools.ts
  transport/
    mcpServer.ts
    stdioServer.ts
    httpServer.ts
  control/
    controlProtocol.ts
    controlServer.ts
    lifecycle.ts
    runtimeDescriptor.ts
  bridge/                 # initially empty/new parity layer
  browser/                # initially desktop-owned, later shared contracts
```

Do not mechanically move code just for file count. Extract cohesive registration units while preserving existing operation implementations in their current modules.

### Service composition

Create an explicit `LeastRuntimeServices` object containing stable interfaces for:

- workspace manager;
- lock manager;
- permission evaluator;
- tool registry;
- output store/shaper;
- dashboard/event sink;
- agent manager;
- config/settings;
- lifecycle coordinator.

New desktop/bridge code should depend on these interfaces, not import dozens of unrelated implementation modules.

### Tool registration

Change `createLeastServer()` conceptually to:

```text
createLeastServer(services)
  -> registerCoreTools(server, services)
  -> registerWorkspaceTools(...)
  -> registerMutationTools(...)
  -> registerAgentTools(...)
  -> ...
```

### Tests

- tool list before/after extraction is identical for each tool mode/toolset;
- schemas remain identical;
- existing smoke suite remains green;
- startup latency does not materially regress;
- no current direct connector behavior changes.

### Acceptance

- `src/server.ts` is a composition/registration file, not a 200+ KB feature module.
- Browser/Responses code can be added without importing the whole server module.

---

## 8. Phase 2 — Introduce a stable control-plane protocol

### Goal

Give the future desktop application a narrow local API for supervising Least without coupling the Electron main process to every internal implementation detail.

### Runtime descriptor

Create a private runtime descriptor under a user-owned directory, for example:

```text
~/.least/desktop/runtime.json
```

Contains only non-secret or local-control metadata:

```json
{
  "version": 1,
  "runtimeVersion": "0.31.0",
  "pid": 12345,
  "startedAt": "...",
  "controlPort": 0,
  "healthPort": 0,
  "instanceId": "...",
  "profile": "production"
}
```

Never put bearer secrets in this descriptor if another same-user process can read it unnecessarily. Store the admin token separately with user-only permissions or keep it parent-process inherited.

### Control endpoints

Implement a loopback-only authenticated control plane:

```text
GET  /control/health
GET  /control/snapshot
POST /control/drain
POST /control/resume
POST /control/cancel-turn
POST /control/cancel-turns
POST /control/shutdown
GET  /control/logs
POST /control/doctor
```

The normal MCP endpoint and the control plane are separate trust surfaces.

### Lifecycle counters

Track independent active counts for:

- MCP/HTTP requests;
- mutations/locks;
- browser/model turns;
- tool broker calls;
- compaction transactions;
- local agent jobs that the launcher itself owns.

`drain` must prevent new relevant work and return the current counters. Update/uninstall/shutdown only proceeds when the required counters reach zero or the user explicitly cancels owned tasks.

### Restart policy

The desktop supervisor should use a bounded restart budget:

```text
unexpected exit #1 -> restart
unexpected exit #2 within short window -> restart
repeated crash loop -> stop and show explicit launcher error
```

No infinite restart loop.

### Acceptance

- launcher can determine exact runtime health/version;
- graceful drain is testable without Electron;
- shutdown flushes state and releases port/lock resources;
- malformed/missing admin token is rejected;
- current external MCP connections do not receive admin privileges.

---

# PART II — DESKTOP APPLICATION

## 9. Phase 3 — Build the Electron application shell

### Goal

Create a real packaged desktop product rather than extending the current browser dashboard into something it was not designed to be.

### Directory

Keep the npm package usable as-is and add a private desktop package:

```text
desktop/
  package.json
  vite.config.ts
  tsconfig.json
  src/
    main.tsx
    App.tsx
    types.ts
    i18n/
    icons/
    styles/
    surfaces/
      BrowserSurface.tsx
      SetupSurface.tsx
      McpSurface.tsx
      ActivitySurface.tsx
      SettingsSurface.tsx
      ToolsSurface.tsx
      AgentsSurface.tsx
      GitSurface.tsx
    components/
      Shell.tsx
      Sidebar.tsx
      TitleBar.tsx
      StatusDot.tsx
      SetupRow.tsx
      DoctorSummary.tsx
      ErrorToast.tsx
      UpdateRow.tsx
  electron/
    main.cjs
    preload.cjs
    runtime-supervisor.cjs
    browser-host.cjs
    browser-tabs.cjs
    profile.cjs
    logging.cjs
    autostart.cjs
    updater.cjs
    atomic-file.cjs
  scripts/
    package.cjs
    prepare-runtime.cjs
    smoke-package.cjs
```

Do not create one 80 KB renderer component or one 200 KB browser worker. The reference proves those features are necessary, not that those file sizes are desirable.

### Renderer/Main boundary

Use `contextIsolation: true`, `nodeIntegration: false`, and a narrow `contextBridge` API.

The renderer should receive DTOs only. It should never receive direct filesystem/process primitives.

### First launcher API

Mirror the useful behavioral contract with Least names:

```text
snapshot
setLanguage
completeOnboarding
openExternal
setBrowserBounds
setBrowserSurfaceActive
showBrowser / hideBrowser
navigateBrowser
zoomBrowser
selectBrowserTab / closeBrowserTab
copyManualPrompt / confirmManualSent
openLogin / logout
smokeTest
verifyMcp
runDoctor
cancelTurns
setupCore
setupMcp
setMcpStep
setAutostart
setInteractionMode
setPreference
exportLogs
installUpdate
windowState / windowControl
subscriptions for state/browser/operation/log/update
```

Add Least-specific APIs later for tools/agents/git; do not expose raw command execution through preload.

### Acceptance

- Electron opens a responsive shell on all three OS families;
- renderer has no Node access;
- all IPC methods are allowlisted and schema-validated in main;
- no core runtime functionality has moved into renderer code.

---

## 10. Phase 4 — Reproduce the launcher interaction model in Least branding

### Onboarding

Implement a 3-stage onboarding flow, but do **not** copy the reference requirement that social follow/star actions gate completion.

Recommended Least onboarding:

1. **Language** — English first; add additional languages only when translation quality can be maintained.
2. **How do you want to use Least?**
   - Direct Connector (recommended)
   - Codex + Manual Web
   - Codex + Automatic Web (experimental warning)
3. **Environment check**
   - detect Codex if required;
   - detect current Least settings;
   - explain local permissions/tunnels;
   - finish.

### Main navigation

Reference-equivalent core surfaces:

```text
Workspace
  Browser

Configuration
  Setup
  MCP

Runtime
  Activity

Footer
  Update available (conditional)
  Settings
```

Least extensions:

```text
Development
  Tools
  Agents
  Git
  Performance
  Workflows (when enabled)
```

### Responsive behavior

- normal sidebar on wide windows;
- compact/sidebar-overlay behavior around the same practical width class as the reference (~820 px);
- native draggable titlebar regions except where a browser view occupies the surface;
- keyboard focus remains visible;
- Esc closes popovers/modals;
- sidebar and surface state persisted.

### Motion

Use subtle motion for:

- onboarding stage changes;
- surface crossfades;
- sidebar open/close;
- error/update notices;
- modal recommendations.

No motion should be required for state correctness; support reduced-motion preferences.

### Design tokens

Create Least-owned tokens for:

- neutral surfaces;
- text hierarchy;
- semantic status tones;
- spacing/radius;
- titlebar/sidebar widths;
- transition durations/easings;
- focus rings.

Do not hardcode a second unrelated visual system in every component.

### Visual regression

Use Playwright/Electron screenshots for deterministic renderer surfaces using mocked runtime/browser state.

Acceptance is visual consistency within Least's design system, not copying another project's logo/color assets.

---

## 11. Phase 5 — Persistent launcher state and production/development profile isolation

### State model

Define a versioned `DesktopState`, including at minimum:

```text
version
language
onboardingComplete
usageMode
browserInteractionMode
launchAtLogin
keepRunningOnClose
showBrowserDuringTurns
sidebarOpen
sidebarWidth
browserSmokePassed
browserSmokeVersion
coreSetupComplete
codexRouteVerified
mcpSetupComplete
mcpRuntimeInstalled
codexRestartRequired
mcpGuideStep
sessionRefreshReminderAt
experimentalContextMode
manualModelProfile
```

### Atomic persistence

Write state by:

1. serialize;
2. write temp file in same directory;
3. fsync if practical;
4. rename atomically;
5. never leave a partially written main state file.

### Separate profiles

Support:

```text
production -> ~/.least/desktop/
development -> ~/.least/desktop-dev/
```

Keep separate:

- Electron `userData`;
- browser partition;
- launcher state;
- runtime descriptor;
- control token;
- route journal;
- diagnostics;
- tunnel credentials/connector identity;
- test chats.

A development launcher must never silently mutate production Codex routing.

### Acceptance

- prod and dev can run simultaneously;
- app update does not wipe browser/session/config state;
- invalid/corrupt state falls back to a recoverable state with diagnostics, not silent reset of credentials/routes.

---

# PART III — RUNTIME SUPERVISION AND BROWSER HOST

## 12. Phase 6 — Package and supervise Least core without requiring system Node

### Goal

Desktop mode should be self-contained.

### Preferred runtime strategy

Keep Least's public Node package. Do **not** migrate the core to Bun merely because the reference uses Bun.

For desktop packaging, use Electron's bundled Node runtime through an isolated child/utility process, for example:

```text
Electron main
  -> utilityProcess.fork(packaged Least runtime entry)
```

or an equivalent packaged Node sidecar if utility-process constraints are discovered.

Bundle:

```text
resources/least-runtime/
  dist/
  required package runtime files
  runtime-manifest.json
```

### Runtime integrity manifest

Before launching a packaged runtime, verify:

```text
relative path
size
SHA-256
```

Reject a mismatched or incomplete runtime instead of launching half-updated files.

### Environment isolation

Do not blindly inherit the user's full process environment into the packaged runtime. Define an explicit inheritance policy and preserve current `inheritEnv` semantics for tools separately.

### Acceptance

- clean desktop install works without globally installed Node/npm;
- CLI npm package still works normally;
- runtime manifest mismatch gives a clear repair error;
- desktop can restart the runtime without leaving stale children.

---

## 13. Phase 7 — BrowserHost and task-bound native Electron views

### Goal

Match the reference browser experience while keeping the browser as a separately controlled native surface.

### Browser architecture

Use one persistent Electron session partition for the user's ChatGPT login and separate task-bound `WebContentsView` objects.

```text
BrowserHost
  session partition: persist:least-chatgpt

  auth/home view
  task view 1
  task view 2
  task view 3
  task view 4
  task view 5
```

Start with a maximum of five task views for parity and bounded account traffic. Make the cap configurable only after real validation.

### Browser state contract

Implement:

```text
status:
  idle | loading | signed-out | ready | testing | running | error

url
title
authenticated
visible
surfaceActive
loading
canGoBack
canGoForward
zoomFactor
activeTabId
maxTabs
tabs[]
```

Each tab:

```text
id
traceId
title
status
loading
active
closable
interactionMode
manualState
manualDeadlineAt
canCopyPrompt
canConfirmSent
```

### Renderer positioning

The React renderer owns the layout placeholder. The Electron main process owns the native view.

Renderer sends measured browser bounds through IPC on:

- surface activation;
- resize observer update;
- window resize;
- sidebar transitions.

Throttle/coalesce bounds updates to animation frames. Do not trigger a React state loop on every native view movement.

### Browser toolbar parity

Support:

- tabs;
- active/loading/error indicators;
- close tab;
- back;
- forward;
- reload;
- current address display;
- zoom out/reset/in;
- show/hide browser.

### Acceptance

- resizing/moving sidebar does not cause visible browser lag or repeated view recreation;
- hidden/inactive view is actually removed/hidden from the composition surface;
- closing an active task tab cancels that browser turn deterministically;
- sixth concurrent task fails explicitly rather than stealing an existing task tab.

---

## 14. Phase 8 — Authentication and session lifecycle

### Goal

Make sign-in reliable without exporting/importing cookies from external browsers.

### Rules

- login occurs inside the launcher-owned persistent session;
- identity-provider popups can be adopted into launcher-owned views only for explicitly allowed auth origins;
- unrelated external links open externally;
- a visible composer alone is not authentication proof;
- require a server-authenticated ChatGPT session plus a usable expected ChatGPT page state;
- never log cookies/local storage/auth headers;
- never copy the browser profile into prompt/context files.

### Session refresh reminder

Track a user-configurable/session-observed reminder time and surface a non-blocking reminder with:

- dismiss;
- sign out/re-authenticate.

### Security challenge detection

Create an explicit detector for:

- Cloudflare/security challenge;
- “suspicious activity”/account-security warnings;
- forced re-authentication;
- unsupported page/layout.

**Hard rule:** security/challenge detection stops automation. Do not auto-retry multiple ChatGPT tabs to work around a product security control.

### Acceptance

- login survives normal launcher restart;
- logout removes authenticated state in the same launcher profile;
- auth popup lifecycle is bounded;
- challenge detection produces an actionable error and zero automated resend attempts.

---

# PART IV — MANUAL WEB MODE FIRST

## 15. Phase 9 — Implement Manual Web mode before automatic DOM automation

### Reason

Manual mode provides much of the finished desktop/Codex experience with a much smaller account and DOM-drift risk. It also forces the task/session/Responses architecture to be correct before browser automation is added.

### Contract

Manual mode must guarantee:

```text
Least does not:
- inspect ChatGPT conversation DOM for answers;
- choose the model for the user;
- click Send;
- mutate the composer;
- simulate typing;
- automatically resend.
```

It may:

- open/show the launcher browser;
- prepare the exact prompt payload;
- copy it to clipboard on explicit user action;
- show model/connector instructions;
- maintain local task/request state;
- receive tool/control results through an explicitly configured connector where supported.

### Manual task state

```text
created
-> awaiting-user
-> sent
-> running
-> completed

terminal/error branches:
  timed-out | cancelled | failed
```

### UI

When a manual tab is active show a guide bar containing:

- concise instruction;
- remaining confirmation window;
- Cancel;
- Copy prompt;
- “Sent” confirmation.

### Prompt safety

The copied prompt may contain a request/turn routing identifier but must not contain:

- local admin bearer tokens;
- browser profile secrets;
- tunnel runtime keys;
- launcher control nonce unless specifically required and safe;
- hidden lifecycle commands that can instead live in connector metadata.

### Acceptance

Add a test that instruments the browser host and proves Manual mode performs **zero composer/model-picker DOM mutation calls**.

---

# PART V — CODEX RESPONSES INTEGRATION

## 16. Phase 10 — Add a dedicated Responses bridge module

### Goal

Present routed ChatGPT Web models as native model choices to Codex while preserving native Codex task/UI/context behavior.

### New modules

```text
src/bridge/
  responsesServer.ts
  requestRouter.ts
  nativePassthrough.ts
  sseEncoder.ts
  responseState.ts
  modelCatalog.ts
  inputCompiler.ts
  imageInputs.ts
  tokenBudget.ts
  errors.ts
```

Do not add these routes to the existing generic MCP HTTP file except through a small composition call.

### Provider surface

Implement only the Responses/OpenAI-compatible surface required by supported Codex clients. At minimum validate the need for:

```text
GET  /v1/models
POST /v1/responses
```

and any continuation/cancellation/prewarm behavior actually observed from the pinned/current Codex client.

Do not claim general OpenAI API compatibility unless it is tested.

### Model namespace

Use a Least-owned namespace that cannot collide with native OpenAI model names, for example:

```text
least-web/manual
least-web/instant
least-web/medium
least-web/high
least-web/xhigh
least-web/pro
```

Expose only modes genuinely available to the authenticated account/browser state.

### Native passthrough

If the local route also proxies native OpenAI models:

- fetch/forward native model catalog from the official configured provider;
- append only Least-owned routed rows;
- never replace unknown native rows with a static copy;
- preserve service-tier/effort metadata unless the routed adapter intentionally owns it.

### WebSocket/prewarm capability

If Codex attempts a transport prewarm the bridge cannot support, return the client's documented/observed explicit capability-negotiation response rather than accepting then hanging. Validate this behavior against the current Codex version before implementation.

### Acceptance

- native models remain intact;
- routed models appear exactly once;
- unsupported effort/model combinations fail explicitly;
- no silent fallback from a failed web route to another model.

---

## 17. Phase 11 — Transactional Codex integration and external-router mode

### Goal

Never corrupt or unexpectedly take ownership of the user's existing Codex routing.

### Modes

The setup UI must explicitly ask:

```text
Direct Codex route
  Least owns the Codex openai_base_url/model-provider routing needed for Least Web.

External router/provider
  Least exposes a local provider endpoint but never changes Codex routing.
```

### Route journal

Store an integration journal such as:

```text
~/.least/desktop/codex-integration-journal.json
```

Record:

- integration version;
- route-owner ID;
- target file path;
- pre-change file hash;
- exact fields/lines owned;
- original values/raw text needed for restoration;
- installed values;
- timestamp.

### Write semantics

1. read existing Codex config;
2. detect another route owner/custom base URL;
3. require explicit user choice before replacement;
4. create journal;
5. apply atomic config update;
6. verify the installed route;
7. on uninstall, restore only fields still matching values Least owns;
8. if the user changed those fields later, do not overwrite them silently — surface a conflict and provide repair instructions.

### External-provider acceptance

Starting Least Desktop in external-provider mode must **never** rewrite Codex `openai_base_url` during startup, repair, update, doctor, or autostart.

Add a regression fixture based on the class of failure described by reference issue #205.

---

## 18. Phase 12 — Prompt/context compiler and image transport

### Goal

Compile the active Codex task into a stable, bounded request for ChatGPT Web without synthetic context files or accidental prompt truncation.

### Input contract

Create a versioned inline envelope containing only authoritative task/context data received from Codex plus bridge metadata.

Keep image bytes out of the JSON text envelope. Treat images as native attachments with stable IDs.

### Token accounting

Introduce an explicit token budget service:

```text
input text tokens
platform/system reserve
image reserve
response reserve
auto-compaction reserve
hard browser composer/attachment limits
```

Use a known tokenizer implementation appropriate to the selected model family and clearly distinguish estimated vs exact counts.

### Oversize behavior

- compact before a proven boundary;
- if the task still cannot fit, fail before opening/sending a browser turn;
- never silently truncate task history or source content;
- report which budget was exceeded.

### Acceptance

- same canonical input produces stable token accounting;
- image attachment failure prevents submission;
- oversized prompt fails deterministically before browser mutation.

---

# PART VI — AUTOMATIC CHATGPT WEB ADAPTER

## 19. Phase 13 — Add Automatic Web mode as an opt-in experimental adapter

### Goal

Drive a task-bound ChatGPT Temporary Chat and translate its visible output back into Codex Responses streaming.

### Browser adapter structure

Avoid a monolithic worker. Suggested split:

```text
src/browser/chatgpt/
  selectors.ts
  pageContract.ts
  sessionProbe.ts
  temporaryChat.ts
  composer.ts
  modelPicker.ts
  effortPicker.ts
  connectorPicker.ts
  attachments.ts
  send.ts
  streamObserver.ts
  markdownProjection.ts
  reasoningProjection.ts
  toolActivityProjection.ts
  completionDetector.ts
  challengeDetector.ts
  driftError.ts
```

Desktop-owned view/session code should remain separate from DOM semantics.

### Selector policy

Every selector/interaction should:

- be narrow;
- have a semantic invariant, not just a CSS selector;
- have a bounded timeout;
- return a typed drift error;
- never fall back to an approximate model/effort if the expected target is missing.

### Chat creation

Each new conversation epoch must create a new Temporary Chat. Retain a chat only for sequential messages belonging to the same exact task/model/effort/epoch.

### Send readiness

Before Send:

- authenticated session confirmed;
- correct temporary-chat mode confirmed;
- selected model/effort confirmed;
- connector presence confirmed when full harness requires it;
- attachments accepted;
- composer contains expected request text/fingerprint;
- no security/challenge page active.

### Output projection

Separate these concepts:

- stable assistant prose -> Codex assistant output;
- reasoning/status rows -> reasoning summaries/commentary where supported;
- tool activity -> native tool lifecycle events;
- transient UI text -> ignored unless part of a known error.

Never fabricate a final response when the browser DOM is ambiguous.

### Completion fence

Do not declare a turn complete merely because visible prose stops changing.

Completion requires:

1. no pending/in-flight connector/tool activity;
2. a stable final-answer projection after the latest tool-result boundary;
3. browser status indicates generation ended;
4. activity revision remains unchanged through a final commit check.

### Acceptance

- UI drift fails closed;
- one turn is never automatically replayed through another model;
- challenge detection stops automation;
- browser navigation away from the task becomes a typed cancellation/error;
- live account testing is not part of CI.

---

# PART VII — TURN-SCOPED TOOL HARNESS

## 20. Phase 14 — Capability broker

### Goal

Allow a ChatGPT Web task to use the exact local tool capability belonging to the active outer Codex turn without turning the connector into a permanent unrestricted local shell.

### Turn capability

On each routed Codex turn derive a capability only from authoritative request metadata, not from user-authored prompt text.

Example conceptual structure:

```text
TurnCapability {
  id
  secretTokenHash
  traceId
  taskId
  cwd
  workspaceRoots
  sandboxPolicy
  approvalPolicy
  model
  effort
  toolRegistrySnapshot
  createdAt
  expiresAt
  state
}
```

### Rules

- token is random and turn-scoped;
- token cannot be reused after terminal completion/revocation;
- tool names must exist in that turn's captured registry;
- no arbitrary tool-name synthesis;
- caller-authored prompt text cannot expand workspace roots;
- Least's own path/permission rules still apply where Least tools are used;
- outer Codex approvals/sandbox remain authoritative for Codex-owned tools;
- connector schema identity is versioned.

### Two tool classes

Support both intentionally:

1. **Outer Codex tools** — tools supplied by the current Codex Responses request and executed through Codex's native task lifecycle.
2. **Least native tools** — structured Least operations (`context_pack`, `read_many`, `apply_patch`, `agent_*`, etc.) exposed through a controlled adapter when appropriate.

Prefer Least native structured operations where they produce a better bounded contract, but do not break Codex-native approval/UI semantics by silently replacing a requested Codex tool.

### Connector identity versioning

Use a stable public ABI name such as:

```text
Least Native v1
Least Manual v1
Least Native DEV v1
```

When the schema changes incompatibly, create a new identity. Do not silently refresh/fallback to a stale connector that may expose an older action contract.

### Acceptance

- expired/revoked token rejects every tool call;
- token from task A cannot call task B's tools;
- tool not present in captured registry is rejected;
- path/sandbox authority cannot be supplied by prompt text;
- final completion cannot race an in-flight tool claim.

---

## 21. Phase 15 — Tool-call bridge and causal activity fence

### State

Every broker call gets:

```text
callId
turnId
toolName
argumentsHash
claimedAt
startedAt
settledAt
status
result/error metadata
```

### Exact-once dispatch

- claim idempotently by `callId`;
- duplicate delivery returns the existing state/result;
- never execute a mutating call twice because of network retry;
- terminal result is immutable.

### Activity revision

Maintain an incrementing `activityRevision` for each turn. Any new tool claim/result invalidates a pending final-answer commit.

Final completion flow:

```text
candidate final output observed
-> capture activityRevision
-> prove pending tools == 0
-> re-read final browser projection
-> verify revision unchanged
-> atomically mark completed
```

This prevents “final answer committed while a new tool call was concurrently claimed.”

---

# PART VIII — CONTINUATION AND COMPACTION

## 22. Phase 16 — Formal turn/session state machine

### Goal

Avoid ad hoc booleans for the most failure-prone part of the product.

### Turn states

Use an explicit state machine such as:

```text
created
  -> opening
  -> prompt-ready
  -> submitting
  -> generating
  -> tool-pending
  -> tool-running
  -> generating
  -> finalizing
  -> completed

special transitions:
  generating/finalizing -> compacting
  compacting -> superseded
  any non-terminal -> cancelling -> cancelled
  any non-terminal -> failed
```

Terminal states:

```text
completed
cancelled
failed
superseded
```

Terminal states are immutable.

### Identity

Separate:

```text
taskId        stable native Codex task
conversationKey = task + model + effort + epoch
turnId        one user/assistant turn
traceId       one browser/bridge execution attempt
callId        one tool invocation
```

Never overload one identifier across these scopes.

### Invariants

- a completed `traceId` can never be registered again;
- compaction creates a new epoch and new trace;
- superseding a retained browser chat does not mutate the already-completed turn;
- a continuation can only bind to the immediately valid predecessor state.

Convert reference issue #318 into tests that attempt to reuse a completed trace after compaction and prove it is impossible by construction.

---

## 23. Phase 17 — Context compaction transaction

### Goal

Preserve long-running task continuity without hidden duplicate turns or one giant timeout.

### Compaction transaction

```text
request compaction
-> freeze/record source epoch
-> obtain structured checkpoint
-> validate checkpoint schema + source identity
-> settle/close source browser helper activity
-> mark source epoch superseded
-> persist replacement/canonical context
-> create new epoch
-> open fresh Temporary Chat on next message
```

### Checkpoint authority

Checkpoint transfer should use a one-shot control capability/schema. Do not parse arbitrary assistant prose and hope it represents a valid checkpoint.

### Fallback

If the retained source chat is unavailable:

- build a dedicated read-only Temporary Chat from canonical Codex task history;
- expose no ordinary mutating tool environment;
- obtain the same structured checkpoint shape;
- fail explicitly on ambiguity.

### Timeout model

Do **not** use one timeout for:

```text
multipart upload + attachment processing + send + model reasoning + result parsing
```

Track phases separately:

```text
transport-stage timeout
attachment-acceptance timeout
final-send-acceptance timeout
model-generation timeout
structured-result timeout
settlement timeout
```

Each phase must update progress timestamps. A stalled upload fails as transport stall rather than masquerading as “model took too long.”

Convert reference issue #316 into a deterministic test where multipart stage 1 stops progressing and verify early stage-specific failure.

### Acceptance

- no duplicate browser turn at compaction boundary;
- no reuse of terminal trace;
- process crash during compaction leaves recoverable persisted transaction state;
- retry does not blindly replay an unchanged known-oversized payload forever.

---

# PART IX — SETUP AND MCP WIZARD

## 24. Phase 18 — Desktop Setup surface

### Required rows

For Automatic Web mode:

1. Sign in to ChatGPT.
2. Run browser smoke test.
3. Install/verify Least Web model route.
4. Show Codex restart requirement when necessary.
5. Configure Full Harness connector optionally/when requested.

For Manual Web mode:

1. Install/verify manual model route.
2. Configure the separate manual connector/tunnel if tool control requires it.
3. Show model profile selection.

For Direct Connector mode:

1. verify Least core;
2. select tunnel/public connector strategy;
3. produce/copy connector URL safely;
4. verify the ChatGPT Developer Mode connector manually.

### Repeatability

Setup actions should be safely repeatable:

- “Install” becomes “Repair/Reinstall”;
- connector credentials can be replaced intentionally;
- doctor explains exactly which layer is unhealthy.

---

## 25. Phase 19 — MCP/tunnel wizard

### Wizard

Use a three-step interaction:

1. **Create/select tunnel / endpoint**
2. **Configure local credentials/runtime**
3. **Create/attach exact ChatGPT connector and verify**

Show a short embedded tutorial animation/video per step if useful, but keep written steps fully sufficient.

### Credential handling

For desktop secrets prefer Electron `safeStorage` / OS-protected encryption when available. If a platform/runtime requires a file fallback:

- user-only permissions;
- never print value in logs;
- never place value in process command line;
- never put secret in renderer state after setup completes;
- allow explicit rotation/removal.

### Existing Least tunnels

Do not remove Least's current Cloudflare/Tailscale/ngrok options. Treat them as the Direct Connector transport family.

If Full Web Harness requires OpenAI's supported outbound tunnel mechanism, isolate it as a separate connector runtime with its own credentials and doctor checks.

### Verification

Verification must prove the exact connector identity and schema expected for this mode. A stale legacy connector is a migration error, not a fallback.

### Acceptance

- setup works without terminal copy/paste for normal desktop users;
- advanced users can still configure via CLI;
- credentials are never exposed in Activity export;
- connector proof failure includes correlation/operation ID for diagnostics.

---

# PART X — ACTIVITY, DIAGNOSTICS, AND EXISTING DASHBOARD CONVERGENCE

## 26. Phase 20 — Structured launcher/runtime logging

### Event schema

```text
timestamp
level
event
component
operationId?
traceId?
taskId?
turnId?
callId?
status?
durationMs?
safe metadata
```

### Never log by default

- prompt text;
- source-file contents;
- raw tool output;
- cookies/storage;
- bearer tokens;
- tunnel keys;
- auth headers;
- full environment;
- private connector secrets.

### Safe export

“Export safe log” must run a second redaction pass over already-safe structured logs and write a human-shareable bundle.

Add adversarial fixtures with fake API keys, JWTs, cookies, `.env` content, home paths, and prompt snippets and assert they do not survive export.

---

## 27. Phase 21 — Doctor

### Doctor checks

Group checks by component:

```text
Desktop
- state readable/version supported
- packaged runtime integrity
- supervisor health
- autostart state

Least Core
- MCP server health
- config/settings validity
- workspace root/permissions
- hooks/YOLO state
- tool registry

Browser
- browser host responsive
- session authenticated
- Temporary Chat usable
- model capabilities observed
- no security challenge

Codex
- detected version
- route ownership
- model catalog
- restart required
- external-router mode consistency

Harness
- tunnel binary/runtime
- credentials present
- connector identity/schema proof
- capability broker health

Agents
- configured local agents
- terminal backend
- Groundcrew health
```

### UI

Each doctor check returns:

```text
id
status: ok | warning | error
short message
optional detail
repair action ID if safe
```

Do not turn every warning into an automatic repair. Route changes, credential replacement, or destructive cleanup require explicit user action.

---

## 28. Phase 22 — Merge the current dashboard's strengths into Desktop

The current dashboard should not be discarded. Its telemetry/data model becomes the basis for richer Least-only surfaces.

### Activity

Reference parity:

- recent events;
- status dot;
- timestamp;
- safe detail;
- export safe log.

### Tools

Keep/upgrade:

- call counts;
- error counts;
- p50/p95/max latency;
- bytes raw/visible;
- compaction savings;
- backend/cache hit;
- currently running calls.

### Agents

Desktop should exceed reference functionality:

- jobs grouped by state;
- agent/profile/model;
- worktree/branch;
- terminal backend;
- elapsed/idle time;
- last commands/output tail;
- Cancel/Resume/Cleanup actions with confirmation;
- open terminal/attach hint;
- final diff/result.

### Git

- branch;
- changed files;
- staged/unstaged/untracked;
- compact diff/review entrypoint;
- no mutation until explicit action.

### Performance

Surface `least_perf`/cache/output stats directly in desktop.

### Compatibility

Keep the standalone web dashboard for headless/remote use. Desktop becomes the richer primary UI, not the only UI.

---

# PART XI — SETTINGS AND PRODUCT DETAIL

## 29. Phase 23 — Settings parity

Implement at minimum:

### General

- Launch at login.
- Keep running when main window closes.
- Show browser during automatic turns.
- Usage/interaction mode.
- Language.
- Context mode / larger-context experimental switch when proven.

### Least safety

- current write mode;
- bash mode;
- YOLO mode status;
- allowed roots;
- project hooks enabled;
- external HTTP policy;
- agent sandbox default.

Do not allow dangerous settings to become one-click toggles with no explanation. YOLO remains an explicit high-risk action with a persistent visible badge.

### Diagnostics

- Run doctor.
- Cancel active web turns.
- Stop/restart runtime.
- Export safe logs.

### Integration

- Direct route vs external provider.
- Repair Codex integration.
- Remove Codex integration and restore owned prior config.
- Connector/tunnel repair.

### About

- Least version;
- desktop version;
- runtime version;
- platform/arch;
- profile (production/development);
- relevant local home path with privacy-safe shortening in normal UI.

---

# PART XII — PACKAGING, UPDATE, AND OS INTEGRATION

## 30. Phase 24 — Cross-platform packaging

### Targets

Match the reference product class:

```text
macOS: DMG + ZIP
Windows: per-user NSIS installer
Linux: AppImage
```

Additional package formats can come later.

### Requirements

- no admin/elevation for normal install;
- per-user app data;
- desktop/start menu integration on Windows;
- standard application category/metadata;
- app icon owned by Least;
- packaged core runtime;
- checksums for release artifacts.

### Code signing

Treat unsigned builds as development/early-release only. Production-quality distribution should add:

- Apple signing/notarization;
- Windows Authenticode signing;
- release provenance/attestation where practical.

Do not call an unsigned package equivalent to a production-signed app.

---

## 31. Phase 25 — Autostart and close semantics

### Launch at login

Use OS-native per-user startup mechanisms and verify state rather than assuming write success.

### Close behavior

If `keepRunningOnClose=true`:

- closing window hides UI;
- supervisor/runtime remains alive;
- tray/menu-bar affordance is available where appropriate;
- active browser turns continue only if the chosen mode explicitly permits it.

If false:

- begin drain;
- if active turn exists, show explicit cancellation/quit choice;
- flush state;
- terminate owned children.

Never kill the core runtime mid-mutation because the user clicked window close without feedback.

---

## 32. Phase 26 — Secure updater

### Update states

```text
disabled
idle
checking
up-to-date
available(version)
downloading(version)
installing(version)
error(message)
```

### Rules

- verify release metadata and checksum/signature before install;
- drain active requests/turns/mutations first;
- stage new runtime/application separately;
- verify staged runtime manifest;
- only then switch/relaunch;
- preserve userData/browser profile/settings;
- rollback or remain on prior version when validation fails.

### Acceptance

- update cannot partially replace runtime files while old runtime is active;
- failed download/verification leaves current app usable;
- update preserves login and connector configuration;
- update does not silently change usage mode or route ownership.

---

# PART XIII — TESTING AND RELEASE ENGINEERING

## 33. Phase 27 — Test architecture

### Unit tests

Cover:

- desktop state migrations;
- IPC schema validation;
- runtime descriptor;
- lifecycle drain counters;
- route journal apply/restore/conflict;
- model catalog merging;
- request router;
- token budget;
- conversation keys;
- turn state transitions;
- exact-once broker calls;
- capability expiration/revocation;
- compaction transaction/recovery;
- browser tab ownership;
- manual mode “no DOM mutation” invariant;
- selector drift typed failures;
- challenge detection;
- safe-log redaction;
- updater state machine.

### Fake ChatGPT fixture

Build a local deterministic web fixture that reproduces the DOM states the adapter needs:

- signed out;
- signed in;
- temporary chat;
- model picker;
- effort picker;
- connector picker;
- image attachment acceptance;
- generating response;
- reasoning/status rows;
- tool activity;
- final answer;
- unexpected layout drift;
- challenge/security warning;
- timeout/no-progress.

Automatic browser CI runs **only** against this fixture.

### Responses/Codex fixture

Build synthetic native request fixtures for:

- ordinary turn;
- image turn;
- sequential continuation;
- tools;
- tool results;
- cancellation;
- compaction;
- subagent-related tools if supported;
- unknown/new fields (forward compatibility);
- native passthrough.

### Packaged-app smoke

For each OS:

- build package;
- install/extract in disposable environment;
- launch app;
- verify packaged runtime manifest;
- verify runtime supervisor health;
- open renderer;
- exercise mocked browser surface;
- cleanly quit.

---

## 34. Phase 28 — Cross-platform CI

Replace the current Linux-only release confidence with a matrix:

```text
macOS
Ubuntu
Windows
```

Suggested jobs:

```text
core-build-test
core-smoke
bench-budget
renderer-typecheck
renderer-unit
browser-fixture-tests
desktop-main-tests
package
package-smoke
security-redaction-tests
artifact-manifest-check
```

Keep platform-specific tests for:

- Windows path/PowerShell/NSIS behavior;
- macOS app lifecycle and signing metadata;
- Linux AppImage ABI/runtime libraries/Wayland-X11 launch.

### Performance budgets

Track but do not immediately hard-fail on every noisy benchmark. Stable budgets should cover:

- launcher cold start;
- core health ready time;
- IPC round-trip;
- browser-view bounds update/coalescing;
- tab create/close memory delta;
- normal Least tool latencies;
- package size.

---

## 35. Phase 29 — Live release validation gate

CI cannot prove a real ChatGPT login, live connector, real Codex version, or account-specific model picker. Create:

```text
docs/release-validation-desktop.md
```

For every release candidate record:

```text
Least version
Desktop version
OS/version
Codex version
ChatGPT plan
clean install vs upgrade
usage mode
result per check
privacy-safe log for failure
```

### Required live gate — Automatic mode

1. clean desktop install;
2. embedded login;
3. Temporary Chat usable;
4. browser smoke;
5. install routed models;
6. restart Codex and verify catalog exactly once;
7. complete simple streamed turn;
8. complete image turn;
9. full-harness tool call with approval behavior;
10. task with multiple tool rounds;
11. continuation in retained chat;
12. cross compaction boundary;
13. cancellation by closing tab;
14. cancellation through launcher;
15. quit/reopen recovery;
16. route uninstall/restoration;
17. update from previous release.

### Required live gate — Manual mode

1. model appears;
2. prompt copies correctly;
3. launcher performs no auto-send;
4. user can select model/connector manually;
5. Sent confirmation transitions correctly;
6. tool round works when connector configured;
7. compaction produces a fresh correct continuation;
8. timeout/cancel is recoverable.

### Direct Connector gate

Ensure the existing official Least connector path still works after every desktop release.

Any failed mandatory gate blocks stable release or is explicitly documented as an alpha limitation.

---

# PART XIV — SECURITY MODEL

## 36. Phase 30 — Write the new desktop/browser threat model before calling Automatic mode stable

Create:

```text
docs/desktop-security-model.md
```

### Trust boundaries

Explicitly document:

- Least core;
- Electron main;
- renderer;
- persistent ChatGPT browser profile;
- Codex client;
- outbound tunnel provider;
- ChatGPT custom connector;
- local repository contents;
- tool outputs;
- websites/prompt text;
- local external agents.

Repository content and model output are untrusted data even though the user trusts the repo generally.

### Security invariants

1. Core/control listeners are loopback-only unless the user intentionally configures a connector/tunnel endpoint.
2. Admin lifecycle endpoint always uses a random secret.
3. Browser profile never leaves the local application directory.
4. Renderer cannot directly execute shell/filesystem APIs.
5. Capability tokens are turn-scoped and revocable.
6. Prompt text cannot declare authoritative workspace roots/sandbox policy.
7. Secrets do not appear in argv/logs/export/state snapshots.
8. Connector ABI identity is versioned.
9. Automatic mode never retries around an account security challenge.
10. Unsupported browser state/model/connector fails closed.
11. Existing Least path guards remain in force.
12. Desktop must not automatically inherit YOLO because a prior headless session used it.

### YOLO policy

Current development sessions may intentionally run Least in YOLO mode, but desktop should make the risk unmistakable:

- startup warning when enabled;
- persistent red/amber badge;
- Settings explanation;
- safe defaults when creating a new desktop profile;
- no project config is allowed to silently enable it.

---

# PART XV — PERFORMANCE AND RESOURCE CONTROL

## 37. Phase 31 — Desktop/browser performance telemetry

Extend current Least telemetry with local-only desktop metrics:

```text
launcher cold start
core-ready latency
renderer first paint
IPC p50/p95
browser view creation time
auth check latency
task setup latency
prompt compile latency
attachment latency
send acceptance latency
first-token/first-visible-output latency
tool round-trip latency
compaction stage durations
per-view WebContents memory
Electron main/renderer/core RSS/CPU
open tab count
```

### Browser resource policy

- do not keep unlimited hidden views;
- five-task cap initially;
- retire superseded epoch views;
- release crashed/closed views promptly;
- no continuous polling when event-driven state is available;
- coalesce DOM observation and bounds updates;
- browser diagnostics screenshots disabled by default.

### UI performance

- avoid global rerender on every log entry;
- bounded log/event collections;
- memoized/virtualized large tables if necessary;
- move expensive formatting off hot render paths;
- no layout measurements in ordinary React render.

---

# PART XVI — LEAST-SPECIFIC SUPERIORITY

## 38. Phase 32 — Native Tools surface

Make Least's structured tool architecture visible as a product advantage.

Display:

- tool groups;
- enabled/disabled based on tool mode/toolset;
- current permissions;
- call/error counts;
- p95 latency;
- model-visible byte savings;
- recent calls;
- retrieval keys for compacted output.

Do not expose raw secret-containing arguments by default.

---

## 39. Phase 33 — Native Agents surface

Treat local agent orchestration as a first-class desktop feature:

```text
Codex
Claude Code
Grok build
PIV/Pi
custom registered profiles
```

Support:

- doctor/profile health;
- plan/start;
- job graph;
- status/watchdog;
- live tail;
- attach/open terminal hint;
- cancel;
- resume;
- cleanup;
- final diff/result.

A ChatGPT Web routed task should be able to delegate through this exact same Least agent layer when authorized.

---

## 40. Phase 34 — Context/efficiency surface

Expose what `codex-chatgpt-web` does not specialize in:

- `context_pack` selections;
- project map/index health;
- file/cache hit rates;
- output-compaction savings;
- raw-output retrieval count;
- token/context budgeting for routed turns;
- current compaction epoch.

This gives users a reason to choose Least beyond “same thing with another logo.”

---

# PART XVII — WHAT NOT TO COPY

## 41. Explicit non-parity decisions

### Do not gate onboarding on GitHub stars/X follows

Social actions can be links in About, not setup blockers.

### Do not default to browser automation

Least already has an official Developer Mode connector architecture. Keep it the recommended path. Automatic Web mode should be opt-in and clearly marked experimental until live stability/security evidence is strong.

### Do not build giant god files

Avoid recreating:

- one enormous renderer `App.tsx`;
- one enormous browser worker;
- browser integration inside Least's already-large core server.

Use explicit service/module boundaries from phase 1 onward.

### Do not use a single end-to-end timeout

Transport, browser readiness, tool calls, model generation, and compaction each need separate progress/timeout semantics.

### Do not silently take Codex route ownership

External-router/provider mode is a first-class setup choice, not a hidden state bit.

### Do not treat DOM automation as an API guarantee

Every automatic browser release remains sensitive to ChatGPT UI changes. Manual and Direct Connector modes are permanent fallback/product modes, not temporary scaffolding.

### Do not silently recover by switching models or modes

Fail closed and tell the user which invariant failed.

---

# PART XVIII — IMPLEMENTATION SLICING

## 42. Recommended PR/worktree sequence

Keep each phase independently testable. Suggested sequence:

### PR 01 — Parity ledger + baseline

- pin reference SHA;
- create parity docs;
- capture Least baseline;
- no product behavior change.

### PR 02 — Core modularization

- split tool registrations;
- add runtime service composition;
- prove tool/schema parity.

### PR 03 — Control plane/lifecycle

- control protocol;
- admin auth;
- health/snapshot/drain/shutdown;
- lifecycle tests.

### PR 04 — Desktop scaffold

- Electron/Vite/React package;
- safe preload;
- shell/sidebar/titlebar;
- mocked snapshot.

### PR 05 — Desktop state + profiles

- atomic persisted state;
- prod/dev isolation;
- onboarding.

### PR 06 — Runtime supervisor

- packaged core runtime;
- integrity manifest;
- restart budget;
- doctor integration.

### PR 07 — Browser host shell

- persistent partition;
- native view bounds;
- tabs/navigation/zoom;
- mocked/non-automated content.

### PR 08 — Manual Web mode

- task tabs;
- prompt compiler/copy;
- countdown/Sent/cancel;
- zero-DOM-mutation test.

### PR 09 — Browser authentication

- embedded login;
- popup handling;
- session probe;
- challenge detector.

### PR 10 — Responses bridge/model catalog

- `/v1/models`;
- `/v1/responses` minimum supported contract;
- namespace;
- SSE;
- synthetic Codex tests.

### PR 11 — Codex route journal

- direct/external-provider mode;
- transactional apply/restore;
- conflict tests.

### PR 12 — Token/context/image pipeline

- prompt envelope;
- tokenizer budget;
- image attachments;
- hard-boundary tests.

### PR 13 — Automatic browser adapter

- selectors/page contract;
- temporary chat;
- model/effort selection;
- send/stream/final output;
- fake ChatGPT fixture.

### PR 14 — Capability broker

- turn token;
- registry binding;
- exact-once calls;
- activity fence;
- security tests.

### PR 15 — Continuation + compaction

- state machine;
- retained epoch;
- structured checkpoint;
- stage-specific timeouts;
- crash recovery;
- #318/#316 regression classes.

### PR 16 — MCP/tunnel wizard

- credential storage;
- connector ABI identities;
- verification;
- tutorial content.

### PR 17 — Activity/doctor/safe logs

- structured logging;
- safe export;
- correlation IDs;
- doctor UI.

### PR 18 — Settings/autostart/uninstall

- settings parity;
- route removal;
- cancel turns;
- close semantics.

### PR 19 — Existing dashboard convergence

- Tools/Agents/Git/Performance data in Desktop;
- preserve standalone dashboard.

### PR 20 — Packaging/updater

- DMG/ZIP;
- NSIS;
- AppImage;
- checksums;
- staged update/rollback.

### PR 21 — Cross-platform CI

- macOS/Windows/Linux matrix;
- packaged-app smoke;
- platform-specific tests.

### PR 22 — Release-validation gate + security docs

- live checklists;
- desktop threat model;
- support/repair docs.

### PR 23 — Product polish audit

- visual parity ledger;
- accessibility;
- keyboard/focus;
- responsive behavior;
- error/loading/update states;
- documentation.

---

## 43. Dependency order / critical path

```text
Parity baseline
    │
    ▼
Core modularization
    │
    ├──────────────► Control plane ─► Runtime supervisor ─► Desktop shell
    │                                             │
    │                                             ▼
    │                                       Browser host
    │                                             │
    │                                       Manual mode
    │                                             │
    ▼                                             ▼
Responses bridge ─► Codex route journal ─► Context compiler
    │                                             │
    └──────────────────────────────┬──────────────┘
                                   ▼
                         Automatic browser adapter
                                   │
                                   ▼
                         Capability broker
                                   │
                                   ▼
                     Continuation + compaction
                                   │
                 ┌─────────────────┴────────────────┐
                 ▼                                  ▼
          Setup/MCP wizard                    Diagnostics
                 │                                  │
                 └─────────────────┬────────────────┘
                                   ▼
                      Packaging / updater / CI
                                   │
                                   ▼
                       Live release validation
```

Do not implement compaction before turn identity/state is formalized. Do not implement automatic DOM automation before Manual mode and the Responses bridge prove task lifecycle correctness.

---

# PART XIX — ACCEPTANCE MATRIX

## 44. “Parity complete” criteria

The project is not complete because the desktop window looks similar. All of the following must be true.

### Existing Least compatibility

- [ ] `least` CLI still works.
- [ ] direct MCP stdio works.
- [ ] direct MCP HTTP works.
- [ ] current ChatGPT Developer Mode connector workflow works.
- [ ] structured file/search/edit/git/test tools retain schema/behavior.
- [ ] agent lifecycle tools retain behavior.
- [ ] standalone dashboard remains usable.

### Desktop product

- [ ] first-launch onboarding complete.
- [ ] responsive sidebar/titlebar complete.
- [ ] Browser/Setup/MCP/Activity/Settings complete.
- [ ] Tools/Agents/Git/Performance Least extensions complete.
- [ ] all loading/error/success states present.
- [ ] update state present.
- [ ] accessibility/keyboard audit passes.

### Browser/session

- [ ] persistent login profile.
- [ ] no cookie/profile handoff to external browser.
- [ ] task-bound tabs.
- [ ] bounded concurrency.
- [ ] navigation/zoom/show-hide.
- [ ] cancellation by close.
- [ ] challenge/security-warning hard stop.

### Manual Web

- [ ] zero automated composer/model-picker mutation.
- [ ] prompt copy/Sent/cancel works.
- [ ] timeouts recover cleanly.
- [ ] manual continuation/compaction works.

### Automatic Web

- [ ] Temporary Chat lifecycle.
- [ ] model/effort verification.
- [ ] images.
- [ ] streaming output.
- [ ] tool activity.
- [ ] final completion fence.
- [ ] DOM drift fails closed.
- [ ] no auto model/mode fallback.

### Codex integration

- [ ] native model catalog preserved.
- [ ] Least models namespaced.
- [ ] direct-route mode transactional.
- [ ] external-provider mode never mutates Codex route.
- [ ] uninstall restores only Least-owned settings.
- [ ] route conflict is surfaced.

### Tool harness

- [ ] turn-scoped random capability.
- [ ] exact registry binding.
- [ ] task isolation.
- [ ] exact-once tool calls.
- [ ] approvals/sandbox authority preserved.
- [ ] completion cannot race tool claim.

### Continuation/compaction

- [ ] conversation identity uses task/model/effort/epoch.
- [ ] terminal traces immutable.
- [ ] completed trace never reused.
- [ ] compaction creates new epoch.
- [ ] checkpoint structured and one-shot.
- [ ] fallback built from canonical history.
- [ ] timeout phases separated.
- [ ] crash recovery tested.

### Diagnostics/security

- [ ] doctor covers every layer.
- [ ] safe log export proven by adversarial tests.
- [ ] secrets absent from argv/logs/state exports.
- [ ] control admin token required.
- [ ] browser automation explicitly opt-in.
- [ ] YOLO cannot silently propagate into new desktop profile.

### Packaging/release

- [ ] Windows package + smoke.
- [ ] macOS package + smoke.
- [ ] Linux AppImage + smoke.
- [ ] packaged runtime integrity manifest.
- [ ] update is staged/verified/drained.
- [ ] cross-platform CI green.
- [ ] live account release gate completed for declared supported modes/platforms.

---

## 45. “Better than reference” criteria

After parity, Least should demonstrate these concrete advantages:

- [ ] Direct official connector remains a supported primary mode with no browser automation dependency.
- [ ] structured Least tools are first-class in the full harness.
- [ ] multiple local agent providers are manageable from one desktop surface.
- [ ] output/token/cache efficiency is visible and measurable.
- [ ] external-router mode is designed in from the beginning.
- [ ] compaction transport and generation timeouts are separated.
- [ ] completed trace reuse is structurally impossible.
- [ ] automatic security-challenge recovery never attempts to evade product controls.
- [ ] browser worker and renderer are modular, not god modules.
- [ ] existing CLI/headless workflows remain intact.

---

# PART XX — IMPLEMENTATION RULES FOR AGENTS

## 46. Rules to put in every implementation prompt

1. Read this master plan and the relevant parity-ledger rows first.
2. Pin reference inspection to `9a7428a9d1fced9baaa85112994c02c011a3b7c9` unless explicitly updating the reference baseline.
3. Do not modify unrelated current dirty-worktree files.
4. Do not copy reference branding/assets/text verbatim when equivalent Least-owned design/copy can express the same behavior.
5. Preserve existing Least CLI/MCP contracts unless a migration is explicitly approved.
6. Add tests in the same PR as state/lifecycle/security behavior.
7. No hidden fallback from failed browser/model/connector state.
8. No automatic account-security-challenge retry.
9. No route mutation in external-provider mode.
10. No renderer filesystem/shell privileges.
11. No long-lived global capability token for tool execution.
12. No compaction implementation without explicit epoch/trace invariants.
13. No update/uninstall while owned active work is undrained.
14. No “done” claim without updating the parity ledger and acceptance evidence.

---

## 47. Audit procedure after each major phase

Run an audit with four outputs:

### A. Code completion

For every planned file/module mark:

```text
implemented
partially implemented
missing
intentionally changed
```

### B. Behavioral parity

Replay the relevant parity-ledger scenarios and attach deterministic screenshots/test output.

### C. Regression

Run:

```text
npm run build
npm run smoke
```

plus the phase-specific tests and desktop package smoke once available.

### D. Risk review

Check specifically:

- new secrets/logging;
- new route ownership behavior;
- browser/session retention;
- leaked child processes;
- state-machine terminal reuse;
- duplicate mutating tool execution;
- regressions in direct Least MCP.

The audit result should be a percentage only after the concrete ledger is counted. Do not estimate completion from file count.

---

## 48. Recommended first implementation milestone

Do **not** start with full automatic ChatGPT automation.

The strongest first milestone is:

```text
Least Desktop v0

✓ Electron shell
✓ Setup / Activity / Settings
✓ packaged/self-supervised Least core
✓ existing Direct Connector setup
✓ BrowserHost with persistent launcher browser
✓ Manual Web task tab/prompt workflow
✓ Codex local model route + transactional restore
✓ safe diagnostics
✓ Windows/Linux/macOS package smoke

No automatic DOM send/read yet.
```

That milestone proves the desktop, runtime supervision, routing, packaging, state, and manual task lifecycle while keeping the risk surface bounded.

Then add Automatic Web mode behind an experimental toggle only after the formal turn/broker/compaction infrastructure exists.

---

## 49. Final target architecture

```text
                               ┌──────────────────────────┐
                               │      Least Desktop       │
                               │ Electron + React + Vite  │
                               └────────────┬─────────────┘
                                            │ typed IPC
                         ┌──────────────────┴──────────────────┐
                         │                                     │
                ┌────────▼────────┐                   ┌────────▼────────┐
                │  Browser Host   │                   │ Runtime Supervisor│
                │ persistent auth │                   │ drain/restart/update│
                │ task-bound tabs │                   └────────┬────────┘
                └────────┬────────┘                            │
                         │                                     ▼
                         │                            ┌───────────────────┐
                         │                            │    Least Core      │
                         │                            │ MCP + tools + agents│
                         │                            └───────┬───────────┘
                         │                                    │
                         │             ┌──────────────────────┼──────────────────────┐
                         │             │                      │                      │
                         │     ┌───────▼────────┐     ┌──────▼───────┐      ┌──────▼───────┐
                         │     │Responses Bridge│     │Capability    │      │Direct MCP     │
                         │     │model catalog/SSE│    │Broker        │      │ChatGPT/Grok   │
                         │     └───────┬────────┘     └──────┬───────┘      └──────────────┘
                         │             │                     │
                         │             ▼                     ▼
                         │        Codex Desktop       exact turn tools
                         │             ▲
                         └─────────────┘
                         ChatGPT Web adapter
                         manual or automatic
```

The architectural objective is not “Least becomes another browser wrapper.” It is:

> **Least becomes a polished desktop local-agent platform that can use ChatGPT Web inside Codex when desired, while still retaining a safer official connector mode and a stronger local structured-tool/orchestration core than the reference application.**

That is the standard to use when deciding whether a parity feature belongs in Least.
