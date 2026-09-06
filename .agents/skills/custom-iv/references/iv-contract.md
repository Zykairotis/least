# IV contract

Use this contract for every generated interactive invocation skill.

## Required profile fields

Store these fields in `references/tool-profile.json`:

- `schema_version`
- `id`
- `display_name`
- `purpose`
- `status`
- `executable`
- `detected_platform`
- `version_command`
- `help_command`
- `documentation`
- `capabilities`
- `limitations`
- `generated_at`

Use `null` or `unknown` for unverified values. Do not invent support.

## Capability fields

Track:

- `interactive`
- `non_interactive`
- `accepts_stdin`
- `supports_cwd`
- `supports_attach`
- `supports_resume`
- `supports_interrupt`
- `supports_result_capture`

Each capability must be `true`, `false`, or `unknown`.

## Generated wrapper

Create `scripts/tool.py` with these operations:

- `doctor`: resolve the configured executable and report availability
- `help`: run the verified help command
- `version`: run the verified version command
- `run`: pass explicit arguments directly to the executable

Invoke subprocesses with argument arrays and `shell=False`. Let `run` inherit the terminal so interactive tools remain usable.

## Generated skill instructions

Require the generated skill to:

- read its profile before invocation
- run doctor before first use on a host
- use only verified commands and flags
- request confirmation before authentication or state-changing operations
- consult discovery evidence when a required command is unclear
- report unsupported or unknown capabilities directly

## Evidence

Store bounded command output and local documentation excerpts in `references/discovery.txt`.

Record:

- the exact probe command
- exit code
- whether the probe timed out
- captured standard output and standard error
- documentation source path or URL

Redact obvious secrets before writing evidence.

## Assets

Create `assets/` only for user-approved, non-sensitive static files required by the tool. Reject environment files, private keys, credential files, authentication databases, and token stores.

## Status values

Use:

- `ready`: required workflow capabilities were verified
- `needs-review`: the skill was generated but one or more required capabilities remain uncertain
- `unavailable`: the executable could not be resolved on the current host
