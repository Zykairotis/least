#!/usr/bin/env python3
"""Cross-platform Agent Deck invocation wrapper with IV resolution and safety gates."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

DEFAULT_TIMEOUT = 120.0
DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[2]
COMMON_BINARIES = [
    Path.home() / ".local" / "bin" / "agent-deck",
    Path.home() / "bin" / "agent-deck",
]


def emit(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def fail(message: str, code: int = 2, **details: Any) -> int:
    emit({"ok": False, "error": message, **details})
    return code


def resolve_agent_deck(explicit: str | None = None) -> str | None:
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("AGENT_DECK_BIN"):
        candidates.append(os.environ["AGENT_DECK_BIN"])
    located = shutil.which("agent-deck")
    if located:
        candidates.append(located)
    candidates.extend(str(path) for path in COMMON_BINARIES)
    if os.name == "nt":
        candidates.extend(["agent-deck.exe", "agent-deck.cmd"])

    for candidate in candidates:
        expanded = Path(candidate).expanduser()
        if expanded.exists() and expanded.is_file():
            return str(expanded.resolve())
        located = shutil.which(candidate)
        if located:
            return located
    return None


def command_text(tokens: Iterable[str]) -> str:
    values = [str(token) for token in tokens]
    if os.name == "nt":
        return subprocess.list2cmdline(values)
    return shlex.join(values)


def config_candidates() -> list[str]:
    candidates: list[Path] = []
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        candidates.append(Path(xdg) / "agent-deck" / "config.toml")
    candidates.append(Path.home() / ".config" / "agent-deck" / "config.toml")
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "agent-deck" / "config.toml")
    return [str(path) for path in candidates if path.exists()]


def execute(
    binary: str,
    args: list[str],
    *,
    timeout: float,
    cwd: str | None = None,
    parse_json: bool = True,
) -> tuple[int, dict[str, Any]]:
    command = [binary, *args]
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return 124, {
            "ok": False,
            "command": command,
            "error": f"Agent Deck command timed out after {timeout:g} seconds",
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
        }
    except OSError as exc:
        return 127, {"ok": False, "command": command, "error": str(exc)}

    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    if completed.returncode == 0 and parse_json and stdout:
        try:
            parsed = json.loads(stdout)
            return 0, parsed if isinstance(parsed, dict) else {"ok": True, "data": parsed}
        except json.JSONDecodeError:
            pass

    payload = {
        "ok": completed.returncode == 0,
        "command": command,
        "exit_code": completed.returncode,
        "stdout": stdout,
        "stderr": stderr,
    }
    return completed.returncode, payload


def invoke(
    binary: str,
    args: list[str],
    *,
    timeout: float,
    cwd: str | None = None,
    prefer_json: bool = True,
) -> tuple[int, dict[str, Any]]:
    request = list(args)
    if prefer_json and "--json" not in request:
        request.append("--json")
    code, payload = execute(binary, request, timeout=timeout, cwd=cwd, parse_json=prefer_json)
    if code != 0 and prefer_json:
        message = f"{payload.get('stderr', '')}\n{payload.get('stdout', '')}".lower()
        if "unknown" in message and ("json" in message or "flag" in message):
            return execute(binary, args, timeout=timeout, cwd=cwd, parse_json=False)
    return code, payload


def help_text(binary: str, args: list[str], timeout: float) -> str:
    _, payload = execute(binary, [*args, "--help"], timeout=timeout, parse_json=False)
    return f"{payload.get('stdout', '')}\n{payload.get('stderr', '')}".strip()


def discovered_commands(text: str) -> list[str]:
    commands: list[str] = []
    in_commands = False
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.endswith("Commands:") or stripped == "Commands:":
            in_commands = True
            continue
        if in_commands and not stripped:
            if commands:
                break
            continue
        if in_commands:
            token = stripped.split()[0] if stripped else ""
            token = token.rstrip(",")
            if token and token[0].isalnum() and token not in commands:
                commands.append(token)
    return commands


def iv_records(root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not root.exists():
        return records
    for profile_path in sorted(root.glob("*/references/tool-profile.json")):
        try:
            profile = json.loads(profile_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        skill_dir = profile_path.parents[1]
        wrapper = skill_dir / "scripts" / "tool.py"
        executable = profile.get("tool_spec") or profile.get("executable")
        available = bool(executable and (Path(str(executable)).expanduser().exists() or shutil.which(str(executable))))
        records.append(
            {
                "skill": profile.get("id") or skill_dir.name,
                "display_name": profile.get("display_name") or skill_dir.name,
                "purpose": profile.get("purpose"),
                "status": profile.get("status", "unknown"),
                "available_now": available,
                "wrapper": str(wrapper) if wrapper.exists() else None,
                "capabilities": profile.get("capabilities", {}),
            }
        )
    return records


def resolve_iv(
    name: str,
    root: Path,
    iv_args: list[str],
    allow_needs_review: bool,
) -> tuple[str, dict[str, Any]]:
    skill_dir = root.expanduser().resolve() / name
    profile_path = skill_dir / "references" / "tool-profile.json"
    wrapper = skill_dir / "scripts" / "tool.py"
    if not profile_path.exists():
        raise ValueError(f"IV profile not found: {profile_path}")
    if not wrapper.exists():
        raise ValueError(f"IV wrapper not found: {wrapper}")
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    status = str(profile.get("status", "unknown"))
    if status == "unavailable":
        raise ValueError(f"IV {name} is unavailable")
    if status == "needs-review" and not allow_needs_review:
        raise ValueError(f"IV {name} is needs-review; pass --allow-needs-review after reviewing it")
    command = command_text([sys.executable, str(wrapper), "run", *iv_args])
    return command, profile


def require_confirmation(args: argparse.Namespace, operation: str) -> None:
    if not getattr(args, "confirm", False):
        raise ValueError(f"{operation} is destructive or high-impact; pass --confirm after explicit user approval")


def session_action(
    binary: str,
    profile_prefix: list[str],
    action: str,
    session: str,
    timeout: float,
    extra: list[str] | None = None,
) -> int:
    code, payload = invoke(binary, [*profile_prefix, "session", action, session, *(extra or [])], timeout=timeout)
    emit(payload)
    return code


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__)
    main.add_argument("--bin", help="Agent Deck executable path")
    main.add_argument("--profile", help="Agent Deck profile")
    main.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    sub = main.add_subparsers(dest="action", required=True)

    for name in ("doctor", "version", "capabilities", "profiles", "groups", "sessions", "summary", "current"):
        sub.add_parser(name)

    tools = sub.add_parser("tools")
    tools.add_argument("--skill-root", default=str(DEFAULT_SKILL_ROOT))

    ui_doctor = sub.add_parser("ui-doctor")
    ui_doctor.add_argument("--skill-root", default=str(DEFAULT_SKILL_ROOT))

    register_source = sub.add_parser("register-source")
    register_source.add_argument("name")
    register_source.add_argument("path")
    register_source.add_argument("--confirm", action="store_true")

    unregister_source = sub.add_parser("unregister-source")
    unregister_source.add_argument("name")
    unregister_source.add_argument("--confirm", action="store_true")

    for name in ("show", "children", "output", "attach", "focus", "start", "stop", "restart", "revive", "fork", "archive", "unarchive"):
        item = sub.add_parser(name)
        item.add_argument("session")

    send = sub.add_parser("send")
    send.add_argument("session")
    send_group = send.add_mutually_exclusive_group(required=True)
    send_group.add_argument("--message")
    send_group.add_argument("--message-file")

    remove = sub.add_parser("remove")
    remove.add_argument("session")
    remove.add_argument("--confirm", action="store_true")

    set_parent = sub.add_parser("set-parent")
    set_parent.add_argument("child")
    set_parent.add_argument("parent")
    unset_parent = sub.add_parser("unset-parent")
    unset_parent.add_argument("child")

    launch = sub.add_parser("launch")
    launch.add_argument("path")
    source = launch.add_mutually_exclusive_group(required=True)
    source.add_argument("--cmd")
    source.add_argument("--iv")
    launch.add_argument("--iv-root", default=str(DEFAULT_SKILL_ROOT))
    launch.add_argument("--iv-arg", action="append", default=[])
    launch.add_argument("--allow-needs-review", action="store_true")
    launch.add_argument("--title")
    launch.add_argument("--group")
    launch.add_argument("--parent")
    prompt = launch.add_mutually_exclusive_group()
    prompt.add_argument("--message")
    prompt.add_argument("--message-file")
    launch.add_argument("--model")
    launch.add_argument("--idle-timeout")
    launch.add_argument("--mcp", action="append", default=[])
    launch.add_argument("--skill", action="append", default=[])
    launch.add_argument("--worktree")
    launch.add_argument("--new-branch", action="store_true")
    launch.add_argument("--location")
    launch.add_argument("--title-lock", action="store_true")
    launch.add_argument("--no-transition-notify", action="store_true")
    launch.add_argument("--wait", action="store_true")

    create_group = sub.add_parser("create-group")
    create_group.add_argument("name")
    delete_group = sub.add_parser("delete-group")
    delete_group.add_argument("name")
    delete_group.add_argument("--confirm", action="store_true")
    move_group = sub.add_parser("move-group")
    move_group.add_argument("session")
    move_group.add_argument("group")

    for name in ("skill-list", "skill-sources", "mcp-list", "worktree-list"):
        sub.add_parser(name)
    for name in ("skill-attached", "mcp-attached", "worktree-info"):
        item = sub.add_parser(name)
        item.add_argument("session")
    for name in ("skill-attach", "skill-detach"):
        item = sub.add_parser(name)
        item.add_argument("session")
        item.add_argument("skill")
    for name in ("mcp-attach", "mcp-detach"):
        item = sub.add_parser(name)
        item.add_argument("session")
        item.add_argument("mcp")

    finish = sub.add_parser("worktree-finish")
    finish.add_argument("session")
    finish.add_argument("--no-merge", action="store_true")
    finish.add_argument("--into")
    finish.add_argument("--confirm", action="store_true")
    cleanup = sub.add_parser("worktree-cleanup")
    cleanup.add_argument("--force", action="store_true")
    cleanup.add_argument("--confirm", action="store_true")

    raw = sub.add_parser("raw")
    raw.add_argument("--confirm", action="store_true")
    raw.add_argument("arguments", nargs=argparse.REMAINDER)
    return main


def main() -> int:
    args = parser().parse_args()
    binary = resolve_agent_deck(args.bin)
    if not binary:
        return fail("agent-deck executable was not found", searched=["AGENT_DECK_BIN", "PATH", *map(str, COMMON_BINARIES)])

    profile_prefix = ["--profile", args.profile] if args.profile else []
    timeout = args.timeout

    try:
        if args.action == "doctor":
            version_code, version = execute(binary, ["--version"], timeout=timeout, parse_json=False)
            top_help = help_text(binary, [], timeout)
            session_help = help_text(binary, ["session"], timeout)
            status_code, status = invoke(binary, [*profile_prefix, "status"], timeout=timeout)
            profiles_code, profiles = invoke(binary, [*profile_prefix, "profile", "list"], timeout=timeout)
            result = {
                "ok": version_code == 0 and status_code == 0 and profiles_code == 0,
                "executable": binary,
                "version": version.get("stdout", ""),
                "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
                "config_files": config_candidates(),
                "terminal_candidates": {"tmux": shutil.which("tmux"), "zellij": shutil.which("zellij")},
                "top_level_commands": discovered_commands(top_help),
                "session_commands": discovered_commands(session_help),
                "status": status,
                "profiles": profiles,
            }
            emit(result)
            return 0 if result["ok"] else 1

        if args.action == "version":
            code, payload = execute(binary, ["--version"], timeout=timeout, parse_json=False)
            emit(payload)
            return code

        if args.action == "capabilities":
            top_help = help_text(binary, [], timeout)
            session_help = help_text(binary, ["session"], timeout)
            launch_help = help_text(binary, ["launch"], timeout)
            emit({
                "ok": True,
                "executable": binary,
                "top_level_commands": discovered_commands(top_help),
                "session_commands": discovered_commands(session_help),
                "supports": {
                    "json": "--json" in top_help or "--json" in session_help,
                    "parent_child": "set-parent" in session_help and "children" in session_help,
                    "message_file": "message-file" in launch_help,
                    "worktree_launch": "worktree" in launch_help,
                    "custom_command": "--cmd" in launch_help or "-cmd" in launch_help,
                    "skills": "skill" in top_help,
                    "mcps": "mcp" in top_help,
                    "remotes": "remote" in top_help,
                    "web_ui": "web" in top_help,
                    "conductor": "conductor" in top_help,
                },
            })
            return 0

        if args.action == "tools":
            root = Path(args.skill_root).expanduser().resolve()
            emit({"ok": True, "skill_root": str(root), "tools": iv_records(root)})
            return 0

        if args.action == "ui-doctor":
            root = Path(args.skill_root).expanduser().resolve()
            source_code, source_payload = invoke(binary, [*profile_prefix, "skill", "source", "list"], timeout=timeout)
            skill_code, skill_payload = invoke(binary, [*profile_prefix, "skill", "list"], timeout=timeout)
            source_items = source_payload.get("sources", []) if isinstance(source_payload, dict) else []
            skill_items = skill_payload.get("skills", []) if isinstance(skill_payload, dict) else []
            source_registered = any(
                item.get("path") and Path(str(item["path"])).expanduser().resolve() == root
                for item in source_items
                if isinstance(item, dict)
            )
            skill_visible = any(
                isinstance(item, dict)
                and item.get("name") == "agent-deck-iv"
                and item.get("source_path")
                and Path(str(item["source_path"])).expanduser().resolve().parent == root
                for item in skill_items
            )
            result = {
                "ok": source_code == 0 and skill_code == 0 and source_registered and skill_visible,
                "skill_root": str(root),
                "source_registered": source_registered,
                "skill_visible": skill_visible,
                "attachable_session_tools": ["claude", "gemini", "codex", "pi"],
                "ui_model": {
                    "skills": "attach or detach from supported agent sessions; skills are not session cards",
                    "sessions": "open with Enter/attach and remove after stopping",
                },
                "sources": source_items,
            }
            emit(result)
            return 0 if result["ok"] else 1

        if args.action == "register-source":
            require_confirmation(args, "skill source registration")
            root = Path(args.path).expanduser().resolve()
            if not root.exists() or not root.is_dir():
                raise ValueError(f"skill source path is not a directory: {root}")
            code, payload = execute(
                binary,
                [*profile_prefix, "skill", "source", "add", args.name, str(root)],
                timeout=timeout,
                parse_json=False,
            )
            emit(payload)
            return code

        if args.action == "unregister-source":
            require_confirmation(args, "skill source removal")
            code, payload = execute(
                binary,
                [*profile_prefix, "skill", "source", "remove", args.name],
                timeout=timeout,
                parse_json=False,
            )
            emit(payload)
            return code

        simple = {
            "profiles": ["profile", "list"],
            "groups": ["group", "list"],
            "sessions": ["list"],
            "summary": ["status"],
            "current": ["session", "current"],
            "skill-list": ["skill", "list"],
            "skill-sources": ["skill", "source", "list"],
            "mcp-list": ["mcp", "list"],
            "worktree-list": ["worktree", "list"],
        }
        if args.action in simple:
            code, payload = invoke(binary, [*profile_prefix, *simple[args.action]], timeout=timeout)
            emit(payload)
            return code

        if args.action == "show":
            code, payload = invoke(binary, [*profile_prefix, "session", "show", args.session], timeout=timeout)
            emit(payload)
            return code

        if args.action in {"children", "output"}:
            code, payload = invoke(binary, [*profile_prefix, "session", args.action, args.session], timeout=timeout)
            emit(payload)
            return code

        if args.action == "attach":
            command = [binary, *profile_prefix, "session", "attach", args.session]
            if not (sys.stdin.isatty() and sys.stdout.isatty()):
                emit({
                    "ok": False,
                    "interactive_required": True,
                    "session": args.session,
                    "attach_command": command_text(command),
                    "error": "attach requires an interactive terminal",
                })
                return 2
            os.execv(binary, command)
            return 0

        if args.action == "focus":
            return session_action(binary, profile_prefix, "focus", args.session, timeout)

        if args.action in {"start", "stop", "restart", "archive", "unarchive", "fork"}:
            return session_action(binary, profile_prefix, args.action, args.session, timeout)

        if args.action == "revive":
            code, payload = invoke(binary, [*profile_prefix, "session", "revive", "--name", args.session], timeout=timeout)
            emit(payload)
            return code

        if args.action == "send":
            message = args.message
            if args.message_file:
                message = Path(args.message_file).expanduser().read_text(encoding="utf-8")
            code, payload = invoke(binary, [*profile_prefix, "session", "send", args.session, message], timeout=timeout)
            emit(payload)
            return code

        if args.action == "remove":
            require_confirmation(args, "session removal")
            return session_action(binary, profile_prefix, "remove", args.session, timeout)

        if args.action == "set-parent":
            code, payload = invoke(binary, [*profile_prefix, "session", "set-parent", args.child, args.parent], timeout=timeout)
            emit(payload)
            return code
        if args.action == "unset-parent":
            code, payload = invoke(binary, [*profile_prefix, "session", "unset-parent", args.child], timeout=timeout)
            emit(payload)
            return code

        if args.action == "launch":
            project = Path(args.path).expanduser().resolve()
            if not project.exists() or not project.is_dir():
                raise ValueError(f"project path is not a directory: {project}")
            iv_profile = None
            command = args.cmd
            if args.iv:
                command, iv_profile = resolve_iv(args.iv, Path(args.iv_root), args.iv_arg, args.allow_needs_review)
            launch_args = [*profile_prefix, "launch", str(project), "--cmd", command, "--json"]
            if args.title:
                launch_args.extend(["--title", args.title])
            if args.group:
                launch_args.extend(["--group", args.group])
            if args.parent:
                launch_args.extend(["--parent", args.parent])
            if args.message:
                launch_args.extend(["--message", args.message])
            if args.message_file:
                prompt_path = Path(args.message_file).expanduser().resolve()
                if not prompt_path.exists():
                    raise ValueError(f"message file not found: {prompt_path}")
                launch_args.extend(["--message-file", str(prompt_path)])
            if args.model:
                launch_args.extend(["--model", args.model])
            if args.idle_timeout:
                launch_args.extend(["--idle-timeout", args.idle_timeout])
            for value in args.mcp:
                launch_args.extend(["--mcp", value])
            for value in args.skill:
                launch_args.extend(["--skill", value])
            if args.worktree:
                launch_args.extend(["--worktree", args.worktree])
            if args.new_branch:
                launch_args.append("--new-branch")
            if args.location:
                launch_args.extend(["--location", args.location])
            if args.title_lock:
                launch_args.append("--title-lock")
            if args.no_transition_notify:
                launch_args.append("--no-transition-notify")
            if not args.wait:
                launch_args.append("--no-wait")
            code, payload = execute(binary, launch_args, timeout=timeout, parse_json=True)
            if iv_profile and isinstance(payload, dict):
                payload = {**payload, "iv": {"name": args.iv, "status": iv_profile.get("status"), "command": command}}
            emit(payload)
            return code

        if args.action == "create-group":
            code, payload = invoke(binary, [*profile_prefix, "group", "create", args.name], timeout=timeout)
            emit(payload)
            return code
        if args.action == "delete-group":
            require_confirmation(args, "group deletion")
            code, payload = invoke(binary, [*profile_prefix, "group", "delete", args.name], timeout=timeout)
            emit(payload)
            return code
        if args.action == "move-group":
            code, payload = invoke(binary, [*profile_prefix, "group", "move", args.session, args.group], timeout=timeout)
            emit(payload)
            return code

        attached = {
            "skill-attached": ["skill", "attached", args.session],
            "mcp-attached": ["mcp", "attached", args.session],
            "worktree-info": ["worktree", "info", args.session],
        }
        if args.action in attached:
            code, payload = invoke(binary, [*profile_prefix, *attached[args.action]], timeout=timeout)
            emit(payload)
            return code

        if args.action in {"skill-attach", "skill-detach"}:
            verb = "attach" if args.action == "skill-attach" else "detach"
            code, payload = invoke(
                binary,
                [*profile_prefix, "skill", verb, args.session, args.skill],
                timeout=timeout,
            )
            emit(payload)
            return code

        if args.action in {"mcp-attach", "mcp-detach"}:
            verb = "attach" if args.action == "mcp-attach" else "detach"
            code, payload = invoke(
                binary,
                [*profile_prefix, "mcp", verb, args.session, args.mcp],
                timeout=timeout,
            )
            emit(payload)
            return code

        if args.action == "worktree-finish":
            require_confirmation(args, "worktree finish")
            worktree_args = [*profile_prefix, "worktree", "finish", args.session]
            if args.no_merge:
                worktree_args.append("--no-merge")
            if args.into:
                worktree_args.extend(["--into", args.into])
            code, payload = invoke(binary, worktree_args, timeout=timeout)
            emit(payload)
            return code
        if args.action == "worktree-cleanup":
            require_confirmation(args, "worktree cleanup")
            worktree_args = [*profile_prefix, "worktree", "cleanup"]
            if args.force:
                worktree_args.append("--force")
            code, payload = invoke(binary, worktree_args, timeout=timeout)
            emit(payload)
            return code

        if args.action == "raw":
            raw_args = [item for item in args.arguments if item != "--"]
            if not raw_args:
                raise ValueError("raw requires Agent Deck arguments")
            if raw_args[0] == "uninstall":
                raise ValueError("agent-deck uninstall is forbidden through this wrapper")
            read_only_prefixes = {
                ("list",), ("ls",), ("status",), ("version",), ("help",),
                ("profile", "list"), ("group", "list"), ("remote", "list"),
                ("remote", "sessions"), ("session", "show"), ("session", "current"),
                ("session", "children"), ("session", "output"), ("skill", "list"),
                ("mcp", "list"), ("worktree", "list"), ("worktree", "info"),
            }
            is_read_only = any(tuple(raw_args[: len(prefix)]) == prefix for prefix in read_only_prefixes)
            if not is_read_only:
                require_confirmation(args, "raw mutation")
            code, payload = invoke(binary, [*profile_prefix, *raw_args], timeout=timeout)
            emit(payload)
            return code

        return fail(f"unsupported action: {args.action}")
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        return fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
