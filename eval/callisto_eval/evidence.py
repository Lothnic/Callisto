"""Validate and translate captured evidence; never synthesize network events.

This exporter prepares inputs, not benchmark scores. It deliberately does not
produce Playwright ZIPs or claim original WebArena live-evaluator compatibility.
"""
from __future__ import annotations

import argparse
import hashlib
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


def validate_capture(source: Path) -> dict[str, Any]:
    source = source.resolve(strict=True)
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest.get("schema") != "callisto.browser-evidence.v1" or not manifest.get("complete"):
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
            if not isinstance(entries, list) or not entries:
                raise ValueError("HAR must contain real recorded request/response entries")
            capture = har["log"].get("_capture", {})
            if capture.get("dropped") or not capture.get("complete") or capture.get("active"):
                raise ValueError("Stop network capture and resolve missing events before benchmark export")
            for entry in entries:
                if not isinstance(entry.get("request", {}).get("url"), str) or not isinstance(entry.get("response", {}).get("status"), int):
                    raise ValueError("HAR entry lacks request URL or response status")
        files.append({**artifact, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    actions = [json.loads(line) for line in (source / manifest["action_log"]["path"]).read_text().splitlines() if line]
    starts = [row["sequence"] for row in actions if row.get("event") == "start"]
    ends = [row["sequence"] for row in actions if row.get("event") == "end"]
    if len(set(starts)) != len(starts) or sorted(starts) != sorted(ends):
        raise ValueError("Action log contains unfinished or duplicated actions")
    return {"schema": "callisto.evidence-index.v1", "source": str(source), "files": files,
            "evaluation_executed": False, "playwright_trace_viewer_compatible": False}


def export_evidence(*, source: Path, destination: Path, benchmark: str, task_id: str,
                    instruction: str = "", answer: str = "", response: dict | None = None) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", task_id):
        raise ValueError("Use a single safe task identifier")
    index = validate_capture(source)
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
            index["native_input"] = "Verified 1.2.3 response schema and HAR parser validated; task-specific field coverage not checked"
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
    parser.add_argument("destination", type=Path)
    parser.add_argument("--benchmark", choices=["webvoyager", "webarena-verified"], required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--instruction", default="")
    parser.add_argument("--answer", default="")
    parser.add_argument("--response", type=Path)
    args = parser.parse_args()
    response = json.loads(args.response.read_text()) if args.response else None
    print(export_evidence(source=args.source, destination=args.destination, benchmark=args.benchmark,
                          task_id=args.task_id, instruction=args.instruction, answer=args.answer, response=response))


if __name__ == "__main__":
    main()
