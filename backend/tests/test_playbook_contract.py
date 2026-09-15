"""The demo playbook quotes exact log lines the presenter reads out loud.

Those quotes are effectively a contract between the docs and the behaviour, so
assert them. Without this, renaming a log message silently invalidates the
playbook — and you only find out in front of an audience.
"""

import re
import time

from app.main import app
from app.store import store
from fastapi.testclient import TestClient

client = TestClient(app)


def _logs() -> list[str]:
    return [entry['message'] for entry in client.get('/api/logs').json()['items']]


def _first(pattern: str) -> str:
    for message in _logs():
        if re.search(pattern, message):
            return message
    return ''


def _fresh():
    """Start from a clean log buffer so assertions cannot match an older line."""
    client.delete('/api/logs')


def test_step_deploy_log_matches_playbook():
    _fresh()
    body = client.post('/api/deploy').json()
    assert _first(r'Deployment completed: release v3\.\d+') == f"Deployment completed: release {body['data']['version']}"


def test_step_scale_logs_match_playbook():
    _fresh()
    # Scale *up* from whatever the current state is, otherwise there are no newly
    # created replicas and no start-up log to assert.
    current = sum(1 for pod in store.snapshot_pods() if pod['deployment'] == 'guide-service')
    target = min(current + 2, 20)

    pending = client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': target}).json()
    client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})
    assert _first(rf'Scaled guide-service to {target} replicas')

    store._starting = {name: 0.0 for name in store._starting}  # re-arm the start delay
    client.get('/api/pods')
    assert _first(r'Pod guide-service-\d+ is Running')


def test_step_chaos_logs_match_playbook():
    _fresh()
    target = next(p['name'] for p in client.get('/api/pods').json()['items'] if p['deployment'] == 'guide-service')
    pending = client.post('/api/chaos/kill', json={'pod_name': target}).json()
    client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})
    assert _first(r'Chaos injection approved: deleted .*; self-healing started')

    store._recovering[target] = 0.0  # re-arm the deadline instead of changing the delay after the fact
    client.get('/api/pods')
    assert _first(rf'Self-healing complete: {re.escape(target)} recovered \(restarts=\d+\)')


def test_step_rollback_log_matches_playbook():
    _fresh()
    client.post('/api/rollback')
    assert _first(r'Rollback completed: v3\.\d+ -> v3\.\d+')


def test_step_diagnostics_log_matches_playbook():
    _fresh()
    client.get('/api/diagnostics')
    assert _first(r'Diagnostics completed \((live|demo)\): ')


def test_step_circuit_breaker_log_matches_playbook():
    _fresh()
    client.post('/api/circuit-breaker')
    assert _first(r'AI service circuit opened; guide service switched to local cache')


def test_step_integration_logs_match_playbook():
    _fresh()
    client.get('/api/integration-check')
    lines = [m for m in _logs() if m.startswith('Integration ')]
    assert len(lines) == 4
    assert all(re.match(r'Integration [\w-]+: \d+/\d+ ready', line) for line in lines)


def test_step_ai_answer_states_its_data_source():
    answer = client.post('/api/ai/chat', json={'question': '系统健康度如何'}).json()['answer']
    assert '数据来源' in answer
    assert '演示数据' in answer or '实时集群数据' in answer


def test_playbook_quotes_actually_appear_in_the_doc():
    """Guard the other direction: the strings above must still be documented."""
    from pathlib import Path

    doc = (Path(__file__).resolve().parents[2] / 'docs' / 'DEMO-PLAYBOOK.md').read_text(encoding='utf-8')
    for quoted in (
        'Deployment completed: release v3.N',
        'Scaled guide-service to N replicas',
        'Pod ... is Running',
        'self-healing started',
        'Self-healing complete',
        'Rollback completed: v3.N -> v3.N-1',
        'Diagnostics completed (live|demo): ...',
        'AI service circuit opened; guide service switched to local cache',
        'Integration <service>: n/m ready',
    ):
        assert quoted in doc, f'playbook no longer documents: {quoted}'
