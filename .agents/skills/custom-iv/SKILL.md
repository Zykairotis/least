---
name: custom-iv
description: Discover unfamiliar local command-line tools and create minimal cross-platform interactive invocation (IV) skills by inspecting executable metadata, safe help and version output, local documentation, POSIX man pages when available, and user-approved official documentation. Generate wrapper scripts, concise references, UI metadata, optional non-sensitive assets, and a discoverable tool profile. Use when a user asks to add an unknown or custom external tool, create or improve a custom IV, understand how an unfamiliar CLI should be invoked, or list previously generated IV tools and their capabilities.
---

# Custom IV

Create small, truthful skills that make an unfamiliar local tool usable by another agent without rediscovering its invocation contract every time.

## Collect the request

Require:

- the tool name or executable path
- the user's intended workflow
- the target skill root

Accept optional local documentation paths, official documentation URLs, safe assets, and a preferred generated skill name.

Do not generate an IV until the intended workflow is concrete enough to determine which capabilities matter.

## Inspect the tool safely

Use `scripts/custom_iv.py inspect` for local discovery.

Inspect only:

- executable resolution and file metadata
- operating system and architecture
- bounded version probes
- bounded help probes
- POSIX man output when available
- user-supplied local documentation
- user-supplied official documentation URLs as references

Use official online documentation through an available web or documentation tool when local discovery is incomplete. Prefer primary vendor documentation.

Never launch the bare tool during discovery. Never run login, initialization, installation, update, configuration mutation, deletion, deployment, publication, push, reset, or similarly stateful commands merely to learn the interface.

## Derive the invocation contract

Read [references/iv-contract.md](references/iv-contract.md).

Record only verified facts. Mark uncertain capabilities as unknown rather than inferring support.

Determine:

- executable and required runtime
- safe version and help commands
- working-directory behavior
- argument and prompt transport
- interactive terminal requirements
- non-interactive support
- session, attach, resume, interrupt, and result behavior
- configuration and instruction files
- authentication requirements
- permission or unrestricted modes
- mutating operations requiring confirmation
- expected outputs and failure signals

## Build the IV

Use `scripts/custom_iv.py build` after reviewing discovery output.

Generate only the files needed by the tool:

- `SKILL.md`
- `agents/openai.yaml`
- `scripts/tool.py`
- `references/tool-profile.json`
- `references/discovery.txt`
- `assets/` only when user-approved static files materially improve operation

Keep generated instructions concise. Store raw bounded discovery evidence in `references/discovery.txt`; store normalized machine-readable facts in `references/tool-profile.json`.

Use `scripts/tool.py` as the default cross-platform wrapper. It must invoke the resolved executable without shell interpolation and expose doctor, help, version, and argument pass-through operations.

Do not embed secrets, tokens, credentials, private keys, environment files, or personal configuration in generated skills or assets.

## Refine generated skills

After generation:

1. Read the generated profile and discovery evidence.
2. Remove irrelevant probes and documentation.
3. Add only verified workflow-specific instructions.
4. Add tool-specific scripts only when the generic wrapper cannot express the required operation reliably.
5. Add references only when they reduce repeated rediscovery.
6. Add assets only when the user supplied or approved them.
7. Preserve unsupported capabilities as explicit limitations.

Do not add speculative commands, generic tutorials, example prompts, or unrelated features.

## Verify

Run the generated wrapper's doctor, help, and version operations.

Perform an interactive or mutating smoke test only with explicit user approval. Avoid authentication changes and external side effects during validation.

Confirm:

- the executable resolves on the current host
- generated paths are portable within the user's skill root
- wrapper subprocess calls do not use a shell
- profile commands match observed output
- the generated skill contains no sensitive data
- the generated skill's frontmatter and UI metadata are valid

If verification is incomplete, set the generated profile status to `needs-review` and state the exact unresolved capability.

## List installed IV tools

Use `scripts/custom_iv.py list` to scan a skill root for generated tool profiles.

Report each tool's skill name, executable, detected platform, profile status, intended workflow, and verified capabilities. Do not claim that a listed tool is currently installed unless its executable resolves during the current check.

## Cross-platform behavior

Use Python standard-library functionality and argument arrays rather than shell strings.

Support Windows, macOS, Linux, BSD-like systems, and other Python-supported hosts where the target executable is available. Treat man pages as optional POSIX evidence, not a universal requirement. Resolve paths and executable suffixes using the host operating system.

Keep operating-system-specific behavior inside the generated profile or wrapper. Do not hardcode the current user's operating system into the skill contract.
