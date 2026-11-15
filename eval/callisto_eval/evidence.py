"""Validate and translate captured evidence; never synthesize network events.

This exporter prepares inputs, not benchmark scores. It deliberately does not
produce Playwright ZIPs or claim original WebArena live-evaluator compatibility.
"""
from __future__ import annotations

import argparse
import hashlib
from fnmatch import fnmatchcase
import json
from pathlib import Path
import re
import shutil
import struct
import zlib
from typing import Any


def _validate_png(data: bytes) -> None:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Invalid PNG signature")
    cursor, chunks = 8, []
    while cursor + 12 <= len(data):
        size = struct.unpack_from('!I', data, cursor)[0]
        kind = data[cursor + 4:cursor + 8]
        end = cursor + 12 + size
        if end > len(data):
            raise ValueError("Truncated PNG chunk")
        content = data[cursor + 8:cursor + 8 + size]
        crc = struct.unpack_from('!I', data, cursor + 8 + size)[0]
        if zlib.crc32(kind + content) != crc:
            raise ValueError("Invalid PNG chunk checksum")
        if not chunks:
            if kind != b'IHDR' or size != 13:
                raise ValueError("PNG must start with IHDR")
            width, height = struct.unpack_from('!II', content)
            if not (0 < width <= 16384 and 0 < height <= 16384):
                raise ValueError("Invalid PNG dimensions")
        chunks.append(kind)
        cursor = end
        if kind == b'IEND':
            if size or cursor != len(data) or b'IDAT' not in chunks:
                raise ValueError("Invalid PNG ending")
            return
    raise ValueError("PNG lacks a complete IEND chunk")


def validate_capture(source: Path, *, allow_incomplete: bool = False) -> dict[str, Any]:
    source = source.resolve(strict=True)
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest.get("schema") != "callisto.browser-evidence.v1" or (not manifest.get("complete") and not allow_incomplete):
        raise ValueError("Evidence must have a completed Callisto capture manifest")
    files = []
    for artifact in [manifest["action_log"], *manifest["files"]]:
        relative = Path(artifact["path"])
        path = source / relative
        if relative.is_absolute() or path.is_symlink() or not path.resolve().is_relative_to(source):
            raise ValueError(f"Artifact escapes capture directory: {relative}")
        if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError(f"Missing or oversized evidence file: {relative}")
        data = path.read_bytes()
        if "bytes" in artifact and len(data) != artifact["bytes"]:
            raise ValueError(f"Evidence size changed: {relative}")
        if artifact["format"] == "png":
            _validate_png(data)
        if artifact["format"] == "har-1.2":
            har = json.loads(data)
            entries = har.get("log", {}).get("entries")
            if not isinstance(entries, list) or (not entries and not allow_incomplete):
                raise ValueError("HAR must contain real recorded request/response entries")
            capture = har["log"].get("_capture", {})
            if not allow_incomplete and (capture.get("dropped") or not capture.get("complete") or capture.get("active")):
                raise ValueError("Stop network capture and resolve missing events before benchmark export")
            for entry in entries:
                if not isinstance(entry.get("request", {}).get("url"), str) or not isinstance(entry.get("response", {}).get("status"), int):
                    raise ValueError("HAR entry lacks request URL or response status")
        files.append({**artifact, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    actions = [json.loads(line) for line in (source / manifest["action_log"]["path"]).read_text().splitlines() if line]
    pending, seen = set(), set()
    for row in actions:
        sequence = row.get("sequence")
        if row.get("event") == "start":
            if sequence in seen:
                raise ValueError("Action log contains duplicated actions")
            pending.add(sequence)
            seen.add(sequence)
        elif row.get("event") == "end":
            if sequence not in pending:
                raise ValueError("Action ended before start or ended twice")
            pending.remove(sequence)
    if pending and not allow_incomplete:
        raise ValueError("Action log contains unfinished actions")
    return {"schema": "callisto.evidence-index.v1", "source": str(source), "files": files,
            "capture_complete": bool(manifest.get("complete")), "pending_actions": sorted(pending),
            "action_outcomes": [row for row in actions if row.get("event") == "end"],
            "requested_evidence": manifest.get("requested_evidence", {}),
            "evaluation_executed": False, "playwright_trace_viewer_compatible": False}


def check_requirements(index: dict, requirements: dict) -> dict:
    """Check an explicit task evidence contract, independently of benchmark scoring.

    JSON pointers name required non-redacted values. URL globs match whole URLs.
    Requirements must be derived from the selected task's evaluator by its author;
    parser acceptance alone says nothing about these requirements.
    """
    if requirements.get("schema") != "callisto.task-evidence.v1":
        raise ValueError("Unsupported task evidence requirements schema")
    if set(requirements) - {"schema", "network", "screenshots", "require_successful_actions"}:
        raise ValueError("Unknown task evidence requirement")
    source = Path(index["source"])
    entries = []
    for artifact in index["files"]:
        if artifact["format"] == "har-1.2":
            entries.extend(json.loads((source / artifact["path"]).read_text())["log"]["entries"])
    def json_field(entry, side, pointer):
        if not isinstance(pointer, str) or not pointer.startswith("/") or len(pointer) > 500:
            raise ValueError("Required fields use bounded JSON pointers")
        try:
            obj = entry[side]["postData" if side == "request" else "content"]
            value = json.loads(obj["text"])
            for part in pointer[1:].split("/"):
                key = part.replace("~1", "/").replace("~0", "~")
                value = value[int(key)] if isinstance(value, list) else value[key]
            return value is not None and "[REDACTED]" not in json.dumps(value)
        except (KeyError, IndexError, TypeError, ValueError):
            return False
    checks = []
    network = requirements.get("network", [])
    if not isinstance(network, list) or len(network) > 100:
        raise ValueError("Expected at most 100 network requirements")
    for spec in network:
        if set(spec) - {"method", "url_glob", "status", "min_count", "request_json_pointers", "response_json_pointers"}:
            raise ValueError("Unknown network requirement")
        method, pattern = spec.get("method"), spec.get("url_glob")
        count = spec.get("min_count", 1)
        if not isinstance(method, str) or not isinstance(pattern, str) or not 1 <= len(pattern) <= 500 or type(count) is not int or not 1 <= count <= 1000:
            raise ValueError("Network requirement needs method, bounded URL glob and positive min_count")
        for side in ("request", "response"):
            pointers = spec.get(side + "_json_pointers", [])
            if not isinstance(pointers, list) or len(pointers) > 100 or any(not isinstance(p, str) or not p.startswith("/") or len(p) > 500 for p in pointers):
                raise ValueError("Required fields use bounded JSON pointers")
        matches = [i for i, entry in enumerate(entries)
                   if entry["request"].get("method") == method
                   and fnmatchcase(entry["request"]["url"], pattern)
                   and ("status" not in spec or entry["response"]["status"] == spec["status"])
                   and all(json_field(entry, side, pointer)
                           for side in ("request", "response")
                           for pointer in spec.get(side + "_json_pointers", []))]
        checks.append({"kind": "network", "requirement": spec, "matched_entries": matches,
                       "passed": len(matches) >= count})
    if "require_successful_actions" in requirements and type(requirements["require_successful_actions"]) is not bool:
        raise ValueError("require_successful_actions must be boolean")
    screenshots = requirements.get("screenshots", {})
    if not isinstance(screenshots, dict) or ("after_each_action" in screenshots and type(screenshots["after_each_action"]) is not bool):
        raise ValueError("Invalid screenshot requirements")
    if set(screenshots) - {"min_count", "after_each_action"}:
        raise ValueError("Unknown screenshot requirement")
    count = screenshots.get("min_count", 0)
    if type(count) is not int or not 0 <= count <= 1000:
        raise ValueError("Invalid screenshot min_count")
    pngs = [a for a in index["files"] if a["format"] == "png"]
    checks.append({"kind": "screenshots", "passed": len(pngs) >= count, "count": len(pngs), "minimum": count})
    if screenshots.get("after_each_action"):
        covered = {a.get("after_sequence") for a in pngs}
        missing = [a["sequence"] for a in index["action_outcomes"] if a["sequence"] not in covered]
        checks.append({"kind": "action_screenshots", "passed": not missing and not index["pending_actions"], "missing_sequences": missing})
    if requirements.get("require_successful_actions"):
        checks.append({"kind": "action_outcomes", "passed": not index["pending_actions"] and all(a.get("success") is True for a in index["action_outcomes"])})
    return {"schema": "callisto.task-evidence-report.v1", "passed": index["capture_complete"] and all(c["passed"] for c in checks),
            "capture_complete": index["capture_complete"], "checks": checks, "benchmark_evaluation_executed": False}


def export_evidence(*, source: Path, destination: Path, benchmark: str, task_id: str,
                    instruction: str = "", answer: str = "", response: dict | None = None,
                    requirements: dict | None = None) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", task_id):
        raise ValueError("Use a single safe task identifier")
    index = validate_capture(source)
    if requirements is not None:
        index["task_coverage"] = check_requirements(index, requirements)
        if not index["task_coverage"]["passed"]:
            raise ValueError("Task-specific evidence requirements are not covered; inspect the coverage report")
    source = Path(index["source"])
    pngs = sorted((a for a in index["files"] if a["format"] == "png"),
                  key=lambda a: int(re.search(r"(\d+)\.png$", a["path"]).group(1)))
    har = next((a for a in index["files"] if a["format"] == "har-1.2"), None)
    if benchmark == "webvoyager":
        if not pngs or not instruction.strip() or not answer.strip():
            raise ValueError("WebVoyager export requires captured PNGs, instruction and final answer")
        if "]" in answer or "\n" in answer or "Please interact with" in instruction:
            raise ValueError("Answer/instruction cannot be translated losslessly through the pinned WebVoyager regex")
    elif benchmark == "webarena-verified":
        if not har or not response:
            raise ValueError("Verified export requires a captured HAR and typed response JSON")
        # The pinned official schema, not a guessed conversion from free text.
        try:
            from webarena_verified.types.agent_response import FinalAgentResponse
        except ImportError as exc:
            raise RuntimeError("Install webarena-verified==1.2.3 to validate the native response") from exc
        response = FinalAgentResponse.model_validate(response).model_dump(mode="json")
        from webarena_verified.types.tracing import NetworkTrace
        NetworkTrace.from_har(source / har["path"])
    else:
        raise ValueError("Original WebArena requires its live environment/evaluator, not this export")
    output = destination / task_id
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        for artifact in index["files"]:
            target = output / artifact["path"]
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(source / artifact["path"], target)
            target.chmod(0o600)
        if benchmark == "webvoyager":
            messages = [
                {"role": "system", "content": "Callisto adapter: task/final answer envelope; see actions.jsonl for recorded actions."},
                {"role": "user", "content": f"Now given a task: {' '.join(instruction.split())} Please interact with the browser."},
                {"role": "assistant", "content": f"Action: ANSWER; {answer}"},
            ]
            (output / "interact_messages.json").write_text(json.dumps(messages, indent=2) + "\n")
            index["native_input"] = "WebVoyager auto-eval envelope and ordered PNGs; no model reasoning transcript"
        else:
            (output / "agent_response.json").write_text(json.dumps(response, indent=2) + "\n")
            index["native_input"] = "Verified 1.2.3 response schema and HAR parser validated; task-specific coverage only checked when an explicit requirements contract is supplied"
        index.update(benchmark=benchmark, task_id=task_id, benchmark_native_evaluation_executed=False,
                     network_redaction_may_remove_evaluator_fields=True)
        (output / "evidence_index.json").write_text(json.dumps(index, indent=2) + "\n")
        for path in output.rglob("*"):
            if path.is_file():
                path.chmod(0o600)
        return output
    except Exception:
        shutil.rmtree(output)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--benchmark", choices=["webvoyager", "webarena-verified"])
    parser.add_argument("--task-id")
    parser.add_argument("--instruction", default="")
    parser.add_argument("--answer", default="")
    parser.add_argument("--response", type=Path)
    parser.add_argument("--requirements", type=Path)
    parser.add_argument("--inspect", action="store_true", help="Diagnose complete or interrupted captures without exporting")
    args = parser.parse_args()
    requirements = json.loads(args.requirements.read_text()) if args.requirements else None
    if args.inspect:
        index = validate_capture(args.source, allow_incomplete=True)
        if requirements is not None:
            index["task_coverage"] = check_requirements(index, requirements)
        print(json.dumps(index, indent=2))
        return
    if not args.destination or not args.task_id or not args.benchmark:
        parser.error("Export requires destination, --task-id and --benchmark")
    response = json.loads(args.response.read_text()) if args.response else None
    print(export_evidence(source=args.source, destination=args.destination, benchmark=args.benchmark,
                          task_id=args.task_id, instruction=args.instruction, answer=args.answer, response=response, requirements=requirements))


if __name__ == "__main__":
    main()
