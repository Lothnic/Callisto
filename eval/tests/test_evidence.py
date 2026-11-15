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


def test_interrupted_capture_is_inspectable_but_not_exportable(tmp_path):
    source = capture(tmp_path)
    manifest = json.loads((source / 'manifest.json').read_text())
    manifest['complete'] = False
    (source / 'manifest.json').write_text(json.dumps(manifest))
    (source / 'actions.jsonl').write_text(json.dumps({'event': 'start', 'sequence': 1}) + '\n' +
        json.dumps({'event': 'end', 'sequence': 1, 'success': False, 'interrupted': True, 'outcome': 'unknown'}) + '\n')
    with pytest.raises(ValueError, match='completed'):
        validate_capture(source)
    index = validate_capture(source, allow_incomplete=True)
    assert index['action_outcomes'][0]['outcome'] == 'unknown'
    assert not index['capture_complete']


def test_action_log_requires_ordered_terminal_events(tmp_path):
    source = capture(tmp_path)
    (source / 'actions.jsonl').write_text(json.dumps({'event': 'end', 'sequence': 1}) + '\n' +
        json.dumps({'event': 'start', 'sequence': 1}) + '\n')
    with pytest.raises(ValueError, match='before start'):
        validate_capture(source)


def test_task_coverage_requires_observed_nonredacted_fields_and_attributed_pngs(tmp_path):
    from callisto_eval.evidence import check_requirements
    source = capture(tmp_path)
    entry = {'request': {'url': 'https://fixture.test/api/orders?page=1', 'method': 'POST',
                         'postData': {'text': json.dumps({'sku': 'A'})}},
             'response': {'status': 200, 'content': {'text': json.dumps({'id': 123, 'token': '[REDACTED]'})}}}
    (source / 'network.har').write_text(json.dumps({'log': {'entries': [entry], '_capture': {'complete': True}}}))
    manifest = json.loads((source / 'manifest.json').read_text())
    manifest['files'][0]['after_sequence'] = 1
    manifest['files'].append({'path': 'network.har', 'format': 'har-1.2'})
    (source / 'manifest.json').write_text(json.dumps(manifest))
    index = validate_capture(source)
    spec = {'schema': 'callisto.task-evidence.v1',
            'network': [{'method': 'POST', 'url_glob': 'https://fixture.test/api/orders*', 'status': 200,
                         'request_json_pointers': ['/sku'], 'response_json_pointers': ['/id']}],
            'screenshots': {'min_count': 1, 'after_each_action': True}}
    assert check_requirements(index, spec)['passed']
    spec['network'][0]['response_json_pointers'] = ['/token']
    report = check_requirements(index, spec)
    assert not report['passed'] and not report['checks'][0]['passed']
    with pytest.raises(ValueError, match='not covered'):
        export_evidence(source=source, destination=tmp_path / 'export', benchmark='webvoyager',
                        task_id='fixture', instruction='Find', answer='Done', requirements=spec)
    spec['network'][0]['response_json_pointers'] = ['/missing']
    assert not check_requirements(index, spec)['passed']
    spec['network'] = []
    index['files'][1].pop('after_sequence')
    assert not check_requirements(index, spec)['passed']
