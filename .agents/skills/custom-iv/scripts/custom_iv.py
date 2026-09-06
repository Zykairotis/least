#!/usr/bin/env python3
"""Inspect unfamiliar CLIs and generate minimal cross-platform IV skills."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

GENERATOR_ID = "custom-iv"
DEFAULT_MAX_OUTPUT = 20_000
DEFAULT_TIMEOUT = 5.0
MAX_ASSET_BYTES = 10 * 1024 * 1024


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def normalize_text(value: str) -> str:
    return " ".join(value.split())


def kebab(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    if not value:
        raise ValueError("could not derive a valid skill name")
    if not value.endswith("-iv"):
        value += "-iv"
    if len(value) > 64:
        raise ValueError("generated skill name exceeds 64 characters")
    return value


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def redact(text: str) -> str:
    text = re.sub(
        r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b\s*[:=]\s*[^\s]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text)
    text = re.sub(
        r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        text,
        flags=re.DOTALL,
    )
    return text


def bounded(text: str, limit: int) -> str:
    text = redact(text.replace("\x00", ""))
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n[truncated after {limit} characters]"


def resolve_tool(tool_spec: str) -> str | None:
    candidate = Path(tool_spec).expanduser()
    if candidate.exists() and candidate.is_file():
        return str(candidate.resolve())
    found = shutil.which(tool_spec)
    if found:
        return str(Path(found).resolve())
    return None


def command_prefix(executable: str) -> list[str]:
    path = Path(executable)
    suffix = path.suffix.lower()
    if os.name == "nt" and suffix in {".cmd", ".bat"}:
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", executable]
    if suffix == ".ps1":
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell:
            return [powershell, "-NoProfile", "-File", executable]
    if suffix == ".py":
        return [sys.executable, executable]
    return [executable]


def safe_environment() -> dict[str, str]:
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    env["PAGER"] = "cat"
    env["MANPAGER"] = "cat"
    return env


def run_probe(command: list[str], timeout: float, max_output: int) -> dict[str, Any]:
    started = now_iso()
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=timeout,
            shell=False,
            env=safe_environment(),
        )
        return {
            "command": command,
            "started_at": started,
            "exit_code": completed.returncode,
            "timed_out": False,
            "stdout": bounded(completed.stdout, max_output),
            "stderr": bounded(completed.stderr, max_output),
        }
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return {
            "command": command,
            "started_at": started,
            "exit_code": None,
            "timed_out": True,
            "stdout": bounded(stdout, max_output),
            "stderr": bounded(stderr, max_output),
        }
    except OSError as exc:
        return {
            "command": command,
            "started_at": started,
            "exit_code": None,
            "timed_out": False,
            "stdout": "",
            "stderr": bounded(str(exc), max_output),
        }


def combined_output(probe: dict[str, Any]) -> str:
    return f"{probe.get('stdout', '')}\n{probe.get('stderr', '')}".strip()


def choose_probe(
    prefix: list[str],
    candidates: Iterable[list[str]],
    timeout: float,
    max_output: int,
    mode: str,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []
    for suffix in candidates:
        probe = run_probe(prefix + suffix, timeout, max_output)
        attempts.append(probe)
        output = combined_output(probe)
        if not output or probe["timed_out"]:
            continue
        lowered = output.lower()
        if mode == "help":
            if any(marker in lowered for marker in ("usage", "options", "commands", "help")):
                return probe, attempts
        elif mode == "version":
            if probe["exit_code"] in {0, 1, 2} and len(output) <= max_output:
                return probe, attempts
    return None, attempts


def read_local_document(path: Path, max_output: int) -> dict[str, Any]:
    try:
        data = path.read_text(encoding="utf-8", errors="replace")
        return {
            "source": str(path.resolve()),
            "kind": "local",
            "content": bounded(data, max_output),
            "error": None,
        }
    except OSError as exc:
        return {
            "source": str(path),
            "kind": "local",
            "content": "",
            "error": str(exc),
        }


def inspect_tool(
    tool_spec: str,
    docs: list[str],
    timeout: float,
    max_output: int,
) -> dict[str, Any]:
    executable = resolve_tool(tool_spec)
    report: dict[str, Any] = {
        "schema_version": 1,
        "generator": GENERATOR_ID,
        "generated_at": now_iso(),
        "tool_spec": tool_spec,
        "executable": executable,
        "host": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "version_probe": None,
        "help_probe": None,
        "man_probe": None,
        "probe_attempts": {"version": [], "help": []},
        "documentation": [],
    }
    if executable:
        prefix = command_prefix(executable)
        version_probe, version_attempts = choose_probe(
            prefix,
            (["--version"], ["-V"], ["version"]),
            timeout,
            max_output,
            "version",
        )
        help_probe, help_attempts = choose_probe(
            prefix,
            (["--help"], ["-h"], ["help"], ["/?"]),
            timeout,
            max_output,
            "help",
        )
        report["version_probe"] = version_probe
        report["help_probe"] = help_probe
        report["probe_attempts"] = {"version": version_attempts, "help": help_attempts}

        if os.name != "nt" and shutil.which("man"):
            man_name = Path(tool_spec).name or Path(executable).name
            report["man_probe"] = run_probe(
                [shutil.which("man") or "man", "-P", "cat", man_name],
                timeout,
                max_output,
            )

    for source in docs:
        if is_url(source):
            report["documentation"].append(
                {"source": source, "kind": "official-url", "content": "", "error": None}
            )
            continue
        report["documentation"].append(read_local_document(Path(source).expanduser(), max_output))

    return report


def symbolic_command(probe: dict[str, Any] | None, executable: str | None) -> list[str] | None:
    if not probe or not executable:
        return None
    command = list(probe.get("command") or [])
    prefix = command_prefix(executable)
    if command[: len(prefix)] == prefix:
        return ["{executable}"] + command[len(prefix) :]
    return None


def discovery_text(report: dict[str, Any]) -> str:
    sections: list[str] = []
    sections.append("CUSTOM IV DISCOVERY")
    sections.append(json.dumps({"generated_at": report["generated_at"], "host": report["host"]}, indent=2))

    for label, key in (("VERSION", "version_probe"), ("HELP", "help_probe"), ("MAN", "man_probe")):
        probe = report.get(key)
        if not probe:
            continue
        sections.append(f"\n[{label}]\n{json.dumps(probe, indent=2, ensure_ascii=False)}")

    for document in report.get("documentation", []):
        sections.append(f"\n[DOCUMENTATION]\n{json.dumps(document, indent=2, ensure_ascii=False)}")

    return redact("\n".join(sections).strip() + "\n")


def generated_wrapper() -> str:
    return '''#!/usr/bin/env python3
"""Cross-platform wrapper generated by custom-iv."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROFILE = Path(__file__).resolve().parents[1] / "references" / "tool-profile.json"


def load_profile():
    return json.loads(PROFILE.read_text(encoding="utf-8"))


def resolve_tool(profile):
    tool_spec = profile.get("tool_spec")
    if tool_spec:
        candidate = Path(tool_spec).expanduser()
        if candidate.exists() and candidate.is_file():
            return str(candidate.resolve())
        found = shutil.which(tool_spec)
        if found:
            return str(Path(found).resolve())
    stored = profile.get("executable")
    if stored and Path(stored).exists():
        return str(Path(stored).resolve())
    return None


def prefix(executable):
    suffix = Path(executable).suffix.lower()
    if os.name == "nt" and suffix in {".cmd", ".bat"}:
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", executable]
    if suffix == ".ps1":
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell:
            return [powershell, "-NoProfile", "-File", executable]
    if suffix == ".py":
        return [sys.executable, executable]
    return [executable]


def expand(profile, key, executable):
    command = profile.get(key)
    if not command:
        raise SystemExit(f"{key} is not verified in the tool profile")
    if command[0] != "{executable}":
        raise SystemExit(f"invalid symbolic command in {key}")
    return prefix(executable) + command[1:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd")
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("doctor")
    sub.add_parser("help")
    sub.add_parser("version")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    profile = load_profile()
    executable = resolve_tool(profile)
    if not executable:
        raise SystemExit("configured executable is unavailable on this host")

    if args.operation == "doctor":
        print(json.dumps({
            "available": True,
            "tool": profile.get("display_name"),
            "executable": executable,
            "status": profile.get("status"),
        }, indent=2))
        return

    if args.operation == "help":
        command = expand(profile, "help_command", executable)
    elif args.operation == "version":
        command = expand(profile, "version_command", executable)
    else:
        passthrough = list(args.args)
        if passthrough and passthrough[0] == "--":
            passthrough = passthrough[1:]
        command = prefix(executable) + passthrough

    completed = subprocess.run(command, cwd=args.cwd, shell=False)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
'''


def generated_skill_md(skill_name: str, display_name: str, purpose: str) -> str:
    description = (
        f"Operate {display_name} through a verified local interactive invocation profile for {purpose}. "
        f"Use when an agent needs to inspect availability, read verified help or version output, or invoke {display_name} with explicit arguments."
    )
    return f"""---
name: {skill_name}
description: {yaml_string(description)}
---

# {display_name} IV

Read `references/tool-profile.json` before invoking the tool.

Run `scripts/tool.py doctor` before first use on a host. Use the wrapper's verified help and version operations when command behavior is unclear. Use the run operation only with explicit arguments required by the user's request.

Consult `references/discovery.txt` for bounded evidence collected from the executable, local documentation, and available manual pages.

Use only verified flags and commands. Ask for confirmation before authentication, installation, configuration mutation, deletion, deployment, publication, push, reset, or other state-changing operations.

Report capabilities marked unknown or unsupported directly. Do not infer missing behavior.
"""


def generated_openai_yaml(display_name: str, skill_name: str) -> str:
    return (
        "interface:\n"
        f"  display_name: {yaml_string(display_name + ' IV')}\n"
        f"  short_description: {yaml_string('Use the verified ' + display_name + ' invocation profile')}\n"
        f"  default_prompt: {yaml_string('Use $' + skill_name + ' to operate ' + display_name + ' through its verified local wrapper.')}\n"
    )


def path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def sensitive_asset(path: Path) -> bool:
    lowered = path.name.lower()
    if lowered == ".env" or lowered.startswith(".env."):
        return True
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".kdbx"}:
        return True
    return lowered in {"id_rsa", "id_ed25519", "credentials", "credentials.json", "secrets.json"}


def copy_assets(asset_sources: list[str], target: Path) -> list[str]:
    copied: list[str] = []
    for source_text in asset_sources:
        source = Path(source_text).expanduser().resolve()
        if not source.exists():
            raise ValueError(f"asset does not exist: {source}")
        candidates = [source] if source.is_file() else [item for item in source.rglob("*") if item.is_file()]
        if any(sensitive_asset(item) for item in candidates):
            raise ValueError(f"refusing sensitive asset source: {source}")
        if path_size(source) > MAX_ASSET_BYTES:
            raise ValueError(f"asset exceeds {MAX_ASSET_BYTES} bytes: {source}")
        target.mkdir(parents=True, exist_ok=True)
        destination = target / source.name
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)
        copied.append(str(destination))
    return copied


def build_skill(args: argparse.Namespace) -> dict[str, Any]:
    purpose = normalize_text(args.purpose)
    if not purpose:
        raise ValueError("purpose must not be empty")

    report = inspect_tool(args.tool, args.doc, args.timeout, args.max_output)
    executable = report.get("executable")
    display_name = Path(args.tool).stem or args.tool
    skill_name = kebab(args.name or display_name)
    root = Path(args.root).expanduser().resolve()
    target = root / skill_name

    if target.exists():
        if not args.force:
            raise FileExistsError(f"target already exists: {target}")
        marker = target / "references" / "tool-profile.json"
        if not marker.exists():
            raise ValueError("refusing to overwrite a directory not identified as a generated IV")
        existing = json.loads(marker.read_text(encoding="utf-8"))
        if existing.get("generator") != GENERATOR_ID:
            raise ValueError("refusing to overwrite a skill created by another generator")
        shutil.rmtree(target)

    (target / "scripts").mkdir(parents=True)
    (target / "references").mkdir(parents=True)
    (target / "agents").mkdir(parents=True)

    version_command = symbolic_command(report.get("version_probe"), executable)
    help_command = symbolic_command(report.get("help_probe"), executable)
    status = "needs-review" if executable else "unavailable"

    profile = {
        "schema_version": 1,
        "generator": GENERATOR_ID,
        "id": skill_name,
        "display_name": display_name,
        "purpose": purpose,
        "status": status,
        "tool_spec": args.tool,
        "executable": executable,
        "detected_platform": report["host"],
        "version_command": version_command,
        "help_command": help_command,
        "documentation": [item["source"] for item in report.get("documentation", [])],
        "capabilities": {
            "interactive": "unknown",
            "non_interactive": "unknown",
            "accepts_stdin": "unknown",
            "supports_cwd": True,
            "supports_attach": "unknown",
            "supports_resume": "unknown",
            "supports_interrupt": True,
            "supports_result_capture": "unknown",
        },
        "limitations": [
            "Workflow-specific commands require review against discovery evidence and official documentation."
        ],
        "generated_at": now_iso(),
    }

    (target / "SKILL.md").write_text(
        generated_skill_md(skill_name, display_name, purpose), encoding="utf-8"
    )
    (target / "agents" / "openai.yaml").write_text(
        generated_openai_yaml(display_name, skill_name), encoding="utf-8"
    )
    wrapper = target / "scripts" / "tool.py"
    wrapper.write_text(generated_wrapper(), encoding="utf-8")
    if os.name != "nt":
        wrapper.chmod(0o755)
    (target / "references" / "tool-profile.json").write_text(
        json.dumps(profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (target / "references" / "discovery.txt").write_text(
        discovery_text(report), encoding="utf-8"
    )

    copied_assets = copy_assets(args.asset, target / "assets") if args.asset else []
    return {
        "skill": skill_name,
        "path": str(target),
        "status": status,
        "executable": executable,
        "assets": copied_assets,
    }


def list_skills(root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not root.exists():
        return records
    for profile_path in sorted(root.glob("*/references/tool-profile.json")):
        try:
            profile = json.loads(profile_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if profile.get("generator") != GENERATOR_ID:
            continue
        current_executable = resolve_tool(profile.get("tool_spec") or profile.get("executable") or "")
        records.append(
            {
                "skill": profile.get("id") or profile_path.parents[1].name,
                "display_name": profile.get("display_name"),
                "purpose": profile.get("purpose"),
                "status": profile.get("status"),
                "available_now": bool(current_executable),
                "executable": current_executable or profile.get("executable"),
                "platform": profile.get("detected_platform", {}).get("system"),
                "capabilities": profile.get("capabilities", {}),
            }
        )
    return records


def print_records(records: list[dict[str, Any]], as_json: bool) -> None:
    if as_json:
        print(json.dumps(records, indent=2, ensure_ascii=False))
        return
    if not records:
        print("No generated IV tools found.")
        return
    headers = ("SKILL", "AVAILABLE", "STATUS", "TOOL", "PURPOSE")
    rows = [
        (
            str(item.get("skill") or ""),
            "yes" if item.get("available_now") else "no",
            str(item.get("status") or ""),
            str(item.get("display_name") or ""),
            str(item.get("purpose") or ""),
        )
        for item in records
    ]
    widths = [max(len(headers[i]), *(len(row[i]) for row in rows)) for i in range(len(headers))]
    print("  ".join(headers[i].ljust(widths[i]) for i in range(len(headers))))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(row[i].ljust(widths[i]) for i in range(len(row))))


def parser() -> argparse.ArgumentParser:
    root_default = str(Path.home() / ".agents" / "skills")
    main_parser = argparse.ArgumentParser(description=__doc__)
    subparsers = main_parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("tool")
    inspect_parser.add_argument("--doc", action="append", default=[])
    inspect_parser.add_argument("--output")
    inspect_parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    inspect_parser.add_argument("--max-output", type=int, default=DEFAULT_MAX_OUTPUT)

    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("tool")
    build_parser.add_argument("--purpose", required=True)
    build_parser.add_argument("--name")
    build_parser.add_argument("--root", default=root_default)
    build_parser.add_argument("--doc", action="append", default=[])
    build_parser.add_argument("--asset", action="append", default=[])
    build_parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    build_parser.add_argument("--max-output", type=int, default=DEFAULT_MAX_OUTPUT)
    build_parser.add_argument("--force", action="store_true")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--root", default=root_default)
    list_parser.add_argument("--json", action="store_true")
    return main_parser


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "inspect":
            report = inspect_tool(args.tool, args.doc, args.timeout, args.max_output)
            payload = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
            if args.output:
                output = Path(args.output).expanduser()
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(payload, encoding="utf-8")
                print(output.resolve())
            else:
                print(payload, end="")
            return 0 if report.get("executable") else 2
        if args.command == "build":
            print(json.dumps(build_skill(args), indent=2, ensure_ascii=False))
            return 0
        records = list_skills(Path(args.root).expanduser().resolve())
        print_records(records, args.json)
        return 0
    except (OSError, ValueError, FileExistsError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
