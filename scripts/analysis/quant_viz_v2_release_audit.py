#!/usr/bin/env python3
"""Independent release audit for the project-local quant-viz Skill v2.

This script is deliberately outside the Skill package. It validates the Skill as a
release artifact without connecting to ClickHouse or mutating market data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Iterable


REQUIRED_V2_REFERENCES = {
    "failure-mechanisms.md",
    "analytical-claims.md",
    "perception-and-encoding.md",
    "visual-recipes.md",
}
REQUIRED_RUNTIME_SCRIPTS = {
    "inspect_dataset.py",
    "inspect_svg_complexity.py",
    "validate_financial_aggregation.py",
    "validate_svg.py",
    "validate_timeseries.py",
    "validate_viz_manifest.py",
    "validate_viz_run.py",
}
SECRET_KEY_RE = re.compile(r"(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)", re.I)
CASE_HINT_KEYS = {"id", "prompt"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--strict", action="store_true", help="Fail on missing behavioral/render evidence")
    return parser.parse_args()


def run(command: list[str], cwd: Path, timeout: int = 300) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        return {
            "command": command,
            "returncode": result.returncode,
            "stdout_tail": result.stdout[-4000:],
            "stderr_tail": result.stderr[-4000:],
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "command": command,
            "returncode": 124,
            "stdout_tail": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
            "stderr_tail": (exc.stderr or "")[-4000:] if isinstance(exc.stderr, str) else "",
            "timed_out": True,
        }


def iter_json(path: Path) -> Iterable[tuple[Path, Any]]:
    for candidate in path.rglob("*.json") if path.exists() else []:
        try:
            yield candidate, json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue


def count_cases(value: Any) -> int:
    if isinstance(value, dict):
        own = 1 if CASE_HINT_KEYS.issubset(value) else 0
        return own + sum(count_cases(item) for item in value.values())
    if isinstance(value, list):
        return sum(count_cases(item) for item in value)
    return 0


def find_metric_documents(root: Path) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for path, value in iter_json(root):
        text = json.dumps(value, sort_keys=True).lower()
        if ("repair" in text and "regression" in text) or all(term in text for term in ("baseline", "v1", "v2")):
            found.append({"path": str(path), "bytes": path.stat().st_size})
    return found


def markdown_links(skill_md: Path) -> list[str]:
    text = skill_md.read_text(encoding="utf-8")
    return re.findall(r"\]\(([^)#]+)(?:#[^)]+)?\)", text)


def load_env_secret_values(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.exists():
        return values
    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if SECRET_KEY_RE.search(key) and len(value) >= 8:
            values[key] = value
    return values


def secret_hits(skill: Path, package: Path | None, env_values: dict[str, str]) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    if not env_values:
        return hits
    for path in skill.rglob("*"):
        if not path.is_file():
            continue
        try:
            content = path.read_bytes()
        except OSError:
            continue
        for key, value in env_values.items():
            if value.encode() in content:
                hits.append({"secret_key": key, "path": str(path.relative_to(skill))})
    if package and package.exists():
        package_bytes = package.read_bytes()
        for key, value in env_values.items():
            if value.encode() in package_bytes:
                hits.append({"secret_key": key, "path": package.name})
    return hits


def package_facts(package: Path) -> dict[str, Any]:
    if not package.exists():
        return {"exists": False}
    facts: dict[str, Any] = {
        "exists": True,
        "bytes": package.stat().st_size,
        "sha256": hashlib.sha256(package.read_bytes()).hexdigest(),
    }
    try:
        with zipfile.ZipFile(package) as archive:
            bad = archive.testzip()
            names = archive.namelist()
            facts.update(
                {
                    "entries": len(names),
                    "bad_entry": bad,
                    "single_root": sorted({name.split("/", 1)[0] for name in names if name}),
                    "cache_entries": [name for name in names if "__pycache__" in name or name.endswith(".pyc")],
                    "skill_entrypoint": "quant-viz/SKILL.md" in names,
                }
            )
    except zipfile.BadZipFile:
        facts["bad_zip"] = True
    return facts


def main() -> int:
    args = parse_args()
    repo = args.repo.resolve()
    skill = repo / ".agents" / "skills" / "quant-viz"
    report_path = args.output or repo / "docs" / "plans" / "2026-08-29-quant-viz-skill-v2-machine-audit.json"
    failures: list[str] = []
    warnings: list[str] = []

    if not skill.is_dir():
        print(f"quant-viz Skill not found: {skill}", file=sys.stderr)
        return 2

    references = sorted(path.name for path in (skill / "references").glob("*.md"))
    scripts = sorted(path.name for path in (skill / "scripts").glob("*.py") if path.name != "_common.py")
    tests = sorted(path.name for path in (skill / "tests").glob("test_*.py"))
    skill_text = (skill / "SKILL.md").read_text(encoding="utf-8")
    links = markdown_links(skill / "SKILL.md")
    broken_links = [link for link in links if not (skill / link).exists()]

    missing_refs = sorted(REQUIRED_V2_REFERENCES - set(references))
    missing_scripts = sorted(REQUIRED_RUNTIME_SCRIPTS - set(scripts))
    if missing_refs:
        failures.append(f"missing required v2 references: {missing_refs}")
    if missing_scripts:
        failures.append(f"missing required runtime scripts: {missing_scripts}")
    if broken_links:
        failures.append(f"broken SKILL.md links: {broken_links}")
    if len(skill_text.splitlines()) >= 500:
        failures.append("SKILL.md is not below 500 lines")

    behavioral_roots = [skill / "tests" / "behavioral", skill / "evals"]
    behavioral_cases = 0
    for root in behavioral_roots:
        for _, value in iter_json(root):
            behavioral_cases += count_cases(value)
    if behavioral_cases < 72:
        message = f"behavioral case count below target: {behavioral_cases} < 72"
        (failures if args.strict else warnings).append(message)

    recipe_root = skill / "assets" / "visual-recipes"
    recipe_dirs = sorted(path for path in recipe_root.iterdir() if path.is_dir()) if recipe_root.exists() else []
    complete_recipes: list[str] = []
    incomplete_recipes: list[str] = []
    for recipe in recipe_dirs:
        if (recipe / "figure.svg").is_file() and (recipe / "manifest.json").is_file():
            complete_recipes.append(recipe.name)
        else:
            incomplete_recipes.append(recipe.name)
    if len(complete_recipes) < 10:
        message = f"complete visual recipes below target: {len(complete_recipes)} < 10"
        (failures if args.strict else warnings).append(message)
    if incomplete_recipes:
        failures.append(f"incomplete visual recipes: {incomplete_recipes}")

    commands: list[dict[str, Any]] = []
    commands.append(
        run(
            [sys.executable, "-m", "unittest", "discover", "-s", str(skill / "tests"), "-t", str(skill), "-p", "test_*.py"],
            cwd=repo,
            timeout=600,
        )
    )
    commands.append(run([sys.executable, "-m", "compileall", "-q", str(skill / "scripts"), str(skill / "tests")], cwd=repo))

    quick_validate = Path("/home/mewtwo/.codex/skills/.system/skill-creator/scripts/quick_validate.py")
    if quick_validate.exists():
        commands.append(
            run(
                ["uv", "run", "--with", "pyyaml", "python", str(quick_validate), str(skill)],
                cwd=repo,
                timeout=300,
            )
        )
    else:
        warnings.append("system quick_validate.py not found")

    recipe_results: list[dict[str, Any]] = []
    for recipe_name in complete_recipes:
        recipe = recipe_root / recipe_name
        checks = [
            run([sys.executable, str(skill / "scripts" / "validate_svg.py"), str(recipe / "figure.svg"), "--format", "json"], cwd=repo),
            run([sys.executable, str(skill / "scripts" / "inspect_svg_complexity.py"), str(recipe / "figure.svg"), "--format", "json"], cwd=repo),
            run([sys.executable, str(skill / "scripts" / "validate_viz_manifest.py"), str(recipe / "manifest.json"), "--format", "json"], cwd=repo),
        ]
        recipe_results.append({"recipe": recipe_name, "checks": checks})

    for result in commands:
        if result["returncode"] != 0:
            failures.append(f"command failed: {' '.join(result['command'])}")
    for recipe in recipe_results:
        for result in recipe["checks"]:
            if result["returncode"] != 0:
                failures.append(f"recipe {recipe['recipe']} failed: {' '.join(result['command'])}")

    metric_documents: list[dict[str, Any]] = []
    for root in [skill / "tests", repo / "artifacts" / "quant-viz-skill-evals", repo / "docs" / "plans"]:
        metric_documents.extend(find_metric_documents(root))
    if not metric_documents:
        message = "no machine-readable repairs/regressions comparison document found"
        (failures if args.strict else warnings).append(message)

    render_evidence = []
    for pattern in ("*playwright*.json", "*visual*result*.json", "*render*qa*.json", "*screenshot*.png"):
        for root in (skill / "tests", repo / "artifacts" / "quant-viz-skill-evals"):
            if root.exists():
                render_evidence.extend(str(path) for path in root.rglob(pattern))
    if not render_evidence:
        message = "no rendered/browser QA evidence found"
        (failures if args.strict else warnings).append(message)

    package = repo / "skill.zip"
    package_info = package_facts(package)
    if not package_info.get("exists"):
        warnings.append("skill.zip not present in candidate workspace")
    else:
        if package_info.get("bad_entry") or package_info.get("bad_zip"):
            failures.append("skill.zip integrity failure")
        if package_info.get("cache_entries"):
            failures.append("skill.zip contains Python cache artifacts")
        if package_info.get("bytes", 0) > 25 * 1024 * 1024:
            failures.append("skill.zip exceeds 25 MB")
        if not package_info.get("skill_entrypoint"):
            failures.append("skill.zip lacks quant-viz/SKILL.md")

    env_values = load_env_secret_values(repo / ".env")
    leaks = secret_hits(skill, package if package.exists() else None, env_values)
    if leaks:
        failures.append("Skill/package contains one or more exact .env secret values")

    report = {
        "status": "pass" if not failures else "fail",
        "strict": args.strict,
        "repo": str(repo),
        "skill": str(skill),
        "skill_md_lines": len(skill_text.splitlines()),
        "reference_count": len(references),
        "runtime_script_count": len(scripts),
        "test_module_count": len(tests),
        "behavioral_case_count": behavioral_cases,
        "complete_recipe_count": len(complete_recipes),
        "complete_recipes": complete_recipes,
        "incomplete_recipes": incomplete_recipes,
        "broken_links": broken_links,
        "metric_documents": metric_documents,
        "render_evidence": sorted(set(render_evidence)),
        "package": package_info,
        "secret_hit_keys_and_paths": leaks,
        "commands": commands,
        "recipe_results": recipe_results,
        "warnings": warnings,
        "failures": failures,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "behavioral_cases": behavioral_cases,
        "recipes": len(complete_recipes),
        "failures": failures,
        "warnings": warnings,
        "report": str(report_path),
    }, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
