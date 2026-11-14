import json
import struct
import zlib
from pathlib import Path

import pytest

from callisto_eval.evidence import export_evidence, validate_capture


def capture(tmp_path: Path) -> Path:
    directory = tmp_path / 'capture'
    directory.mkdir()
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\0\0\0\0')) + chunk(b'IEND', b'')
    (directory / 'screenshot1.png').write_bytes(png)
    (directory / 'actions.jsonl').write_text(
        json.dumps({'event': 'start', 'sequence': 1}) + '\n' +
        json.dumps({'event': 'end', 'sequence': 1}) + '\n')
    (directory / 'manifest.json').write_text(json.dumps({
        'schema': 'callisto.browser-evidence.v1', 'complete': True,
        'action_log': {'path': 'actions.jsonl', 'format': 'callisto-redacted-jsonl-v1'},
        'files': [{'path': 'screenshot1.png', 'format': 'png', 'bytes': len(png)}],
    }))
    return directory


def test_webvoyager_export_uses_captured_pngs_and_records_limits(tmp_path):
    source = capture(tmp_path)
    out = export_evidence(source=source, destination=tmp_path / 'export', benchmark='webvoyager',
                          task_id='task-fixture', instruction='Find a\nprice', answer='42 dollars')
    assert (out / 'screenshot1.png').read_bytes() == (source / 'screenshot1.png').read_bytes()
    messages = json.loads((out / 'interact_messages.json').read_text())
    assert 'Now given a task: Find a price Please interact with' in messages[1]['content']
    assert messages[-1]['content'] == 'Action: ANSWER; 42 dollars'
    index = json.loads((out / 'evidence_index.json').read_text())
    assert not index['evaluation_executed']
    assert not index['playwright_trace_viewer_compatible']
    assert all(len(file['sha256']) == 64 for file in index['files'])


def test_export_refuses_fake_paths_incomplete_actions_and_missing_network(tmp_path):
    source = capture(tmp_path)
    with pytest.raises(ValueError, match='HAR'):
        export_evidence(source=source, destination=tmp_path / 'export', benchmark='webarena-verified',
                        task_id='1', response={'task_type': 'RETRIEVE', 'status': 'SUCCESS'})
    with pytest.raises(ValueError, match='identifier'):
        export_evidence(source=source, destination=tmp_path / 'export', benchmark='webvoyager', task_id='../escape')
    (source / 'actions.jsonl').write_text(json.dumps({'event': 'start', 'sequence': 1}) + '\n')
    with pytest.raises(ValueError, match='unfinished'):
        validate_capture(source)


def test_export_refuses_changed_or_escaping_evidence(tmp_path):
    source = capture(tmp_path)
    (source / 'screenshot1.png').write_bytes(b'not a png')
    with pytest.raises(ValueError, match='size changed'):
        validate_capture(source)
    (source / 'screenshot1.png').unlink()
    (source / 'screenshot1.png').symlink_to(tmp_path / 'outside.png')
    with pytest.raises(ValueError, match='escapes'):
        validate_capture(source)
