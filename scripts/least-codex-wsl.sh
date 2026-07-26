#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
least-codex-wsl.sh --worktree <path> --prompt-file <path> [--output-dir <path>] [--distro <name>]

Wrapper contract for Least/Groundcrew Codex WSL profiles.

Responsibilities:
- Convert Windows paths to WSL paths when wslpath is available.
- cd into the assigned worktree only.
- Run Codex non-interactively from a prompt file.
- Emit JSONL events and final result files when an output directory is supplied.

This script is a template. Test it on the target machine before enabling codex-wsl.
USAGE
}

WORKTREE=""
PROMPT_FILE=""
OUTPUT_DIR=""
DISTRO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worktree)
      WORKTREE="${2:-}"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --distro)
      DISTRO="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$WORKTREE" || -z "$PROMPT_FILE" ]]; then
  usage >&2
  exit 2
fi

if command -v wslpath >/dev/null 2>&1; then
  WORKTREE="$(wslpath -a "$WORKTREE")"
  PROMPT_FILE="$(wslpath -a "$PROMPT_FILE")"
  if [[ -n "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="$(wslpath -a "$OUTPUT_DIR")"
  fi
fi

if [[ ! -d "$WORKTREE" ]]; then
  echo "Worktree does not exist: $WORKTREE" >&2
  exit 3
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file does not exist: $PROMPT_FILE" >&2
  exit 3
fi

cd "$WORKTREE"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI was not found in PATH" >&2
  exit 4
fi

if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
  codex exec --json --sandbox workspace-write - < "$PROMPT_FILE" > "$OUTPUT_DIR/events.jsonl" 2> "$OUTPUT_DIR/stderr.log"
else
  codex exec --json --sandbox workspace-write - < "$PROMPT_FILE"
fi
