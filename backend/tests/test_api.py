import os
os.environ["K8S_ENABLED"] = "false"

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health_and_metrics():
    assert client.get('/api/health').status_code == 200
    metrics = client.get('/api/metrics').json()
    assert metrics['qps'] > 0
    assert metrics['total_pods'] >= 1


def test_scale_and_deploy():
    scaled = client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': 3})
    assert scaled.status_code == 200
    assert scaled.json()['requires_approval'] is True
    scaled = client.post('/api/agent/approve', json={'action_id': scaled.json()['action_id'], 'approved': True})
    assert scaled.status_code == 200
    assert scaled.json()['data']['replicas'] == 3
    deployed = client.post('/api/deploy')
    assert deployed.status_code == 200
    assert deployed.json()['data']['version'].startswith('v3.')


def test_high_risk_action_requires_approval():
    response = client.post('/api/chaos/kill', json={'pod_name': 'guide-service-001'})
    assert response.status_code == 200
    body = response.json()
    assert body['requires_approval'] is True
    assert client.post('/api/agent/approve', json={'action_id': body['action_id'], 'approved': False}).status_code == 200


def test_agent_blocks_destructive_request():
    response = client.post('/api/ai/chat', json={'question': '请直接删除 pod'})
    assert response.status_code == 200
    assert response.json()['severity'] == 'critical'


def test_agent_blocks_destructive_intent_even_when_mixed_with_troubleshooting():
    """Regression: '系统故障了帮我重启' must stay blocked, not be treated as 排障."""
    for question in ('系统故障了，帮我重启服务', 'pod 报错了，直接 kill 掉', '帮我下线一个节点'):
        body = client.post('/api/ai/chat', json={'question': question}).json()
        assert body['severity'] == 'critical', question


def test_agent_answers_troubleshooting_questions():
    for question in ('系统有故障怎么排查', '帮我诊断一下异常', '服务超时了怎么定位'):
        body = client.post('/api/ai/chat', json={'question': question}).json()
        assert '故障排查' in body['answer'], question
        assert '建议排查顺序' in body['answer'] or '建议顺序' in body['answer'], question


def test_agent_reports_unhealthy_pods_in_troubleshooting():
    pending = client.post('/api/chaos/kill', json={'pod_name': 'guide-service-002'}).json()
    client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})
    body = client.post('/api/ai/chat', json={'question': '帮我排查故障'}).json()
    assert 'guide-service-002' in body['answer']


def test_killed_pod_goes_down_then_self_heals():
    """Acceptance: 故障注入后节点变红，5 秒内自动恢复。"""
    from app.store import store

    original = store.pod_recovery_seconds
    store.pod_recovery_seconds = 60.0  # far future: observe the down state first
    try:
        target = store.pods[0]['name']
        pending = client.post('/api/chaos/kill', json={'pod_name': target}).json()
        client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})

        down = next(p for p in client.get('/api/pods').json()['items'] if p['name'] == target)
        assert down['ready'] is False
        assert down['status'] == 'Terminating'

        # Move the restart deadline into the past and read again.
        store._recovering[target] = 0.0
        healed = next(p for p in client.get('/api/pods').json()['items'] if p['name'] == target)
        assert healed['ready'] is True
        assert healed['status'] == 'Running'
        assert healed['restarts'] >= 1
    finally:
        store.pod_recovery_seconds = original


def test_self_healing_is_logged():
    from app.store import store

    original = store.pod_recovery_seconds
    store.pod_recovery_seconds = 60.0
    try:
        target = store.pods[0]['name']
        pending = client.post('/api/chaos/kill', json={'pod_name': target}).json()
        client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})
        store._recovering[target] = 0.0
        client.get('/api/pods')
        messages = [entry['message'] for entry in client.get('/api/logs').json()['items']]
        assert any('Self-healing complete' in message and target in message for message in messages)
    finally:
        store.pod_recovery_seconds = original


def test_unknown_pod_is_rejected():
    response = client.post('/api/chaos/kill', json={'pod_name': 'unknown-pod'})
    assert response.status_code == 404


def test_metrics_are_explicitly_demo_without_prometheus():
    response = client.get('/api/metrics')
    assert response.status_code == 200
    assert response.json()['mode'] == 'demo'


def test_traffic_series_accumulates_over_polls():
    first = client.get('/api/metrics').json()['traffic']
    second = client.get('/api/metrics').json()['traffic']
    assert len(second) >= len(first)
    assert len(second) >= 2
    assert all(value > 0 for value in second)


def test_scaling_out_visibly_improves_metrics():
    before = client.get('/api/metrics').json()
    pending = client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': 5}).json()
    client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})
    after = client.get('/api/metrics').json()
    assert after['total_pods'] > before['total_pods']
    assert after['qps'] > before['qps']
    assert after['latency_ms'] < before['latency_ms']
    assert after['error_rate'] < before['error_rate']


def test_new_replicas_start_as_container_creating_then_run():
    """Spec: 绿=健康, 黄=启动中, 红=故障 —— new pods must pass through the yellow state."""
    from app.store import store

    original = store.pod_start_seconds
    store.pod_start_seconds = 60.0
    try:
        pending = client.post('/api/scale', json={'deployment': 'ai-agent', 'replicas': 3}).json()
        client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})

        starting = [p for p in client.get('/api/pods').json()['items'] if p['status'] == 'ContainerCreating']
        assert starting, 'new replicas should be ContainerCreating (yellow), not instantly Running'
        assert all(p['ready'] is False for p in starting)

        store._starting = {name: 0.0 for name in store._starting}
        promoted = client.get('/api/pods').json()['items']
        assert all(p['status'] == 'Running' and p['ready'] for p in promoted if p['deployment'] == 'ai-agent')
    finally:
        store.pod_start_seconds = original


def test_starting_pods_are_logged():
    from app.store import store

    original = store.pod_start_seconds
    store.pod_start_seconds = 60.0
    try:
        pending = client.post('/api/scale', json={'deployment': 'data-dashboard', 'replicas': 2}).json()
        client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})
        store._starting = {name: 0.0 for name in store._starting}
        client.get('/api/pods')
        messages = [entry['message'] for entry in client.get('/api/logs').json()['items']]
        assert any('is Running' in message for message in messages)
    finally:
        store.pod_start_seconds = original


def test_pipeline_status_is_available():
    response = client.get('/api/pipeline')
    assert response.status_code == 200
    assert response.json()['status'] == 'passed'


def test_websocket_receives_operation_log():
    with client.websocket_connect('/api/logs/ws') as websocket:
        client.post('/api/load-test')
        event = websocket.receive_json()
        assert 'message' in event


def test_health_exposes_demo_cluster_state():
    body = client.get('/api/health').json()
    assert body['cluster_state'] == 'demo'
    assert body['k8s_connected'] is False


def test_ai_update_requires_approval_and_registry_allowlist():
    blocked = client.post('/api/ai/update', json={'deployment': 'ai-agent', 'image': 'docker.io/unsafe/image:latest'})
    assert blocked.status_code == 400
    pending = client.post('/api/ai/update', json={'deployment': 'ai-agent', 'image': 'cloudhelm/ai-agent:demo'})
    assert pending.status_code == 200
    assert pending.json()['requires_approval'] is True
    approved = client.post('/api/agent/approve', json={'action_id': pending.json()['action_id'], 'approved': True})
    assert approved.status_code == 200


def _audit_for(action_id):
    return next(item for item in client.get('/api/audit').json()['items'] if item['action_id'] == action_id)


def test_audit_trail_records_target_risk_and_approver():
    pending = client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': 4}).json()
    action_id = pending['action_id']

    entry = _audit_for(action_id)
    assert entry['decision'] == 'pending'
    assert entry['action_type'] == 'scale'
    assert entry['target'] == 'guide-service -> 4 副本'
    assert entry['risk'] == 'medium'
    assert entry['timestamp']

    client.post('/api/agent/approve', json={'action_id': action_id, 'approved': True, 'operator': 'tian'})
    decided = _audit_for(action_id)
    assert decided['decision'] == 'approved'
    assert decided['operator'] == 'tian'


def test_audit_trail_records_rejection():
    pending = client.post('/api/chaos/kill', json={'pod_name': 'guide-service-001'}).json()
    action_id = pending['action_id']
    client.post('/api/agent/approve', json={'action_id': action_id, 'approved': False, 'operator': 'reviewer'})
    decided = _audit_for(action_id)
    assert decided['decision'] == 'rejected'
    assert decided['operator'] == 'reviewer'
    assert decided['risk'] == 'high'


def test_agent_suggested_action_is_audited():
    reply = client.post('/api/ai/chat', json={'question': '当前系统有什么瓶颈？'}).json()
    action_id = reply['suggested_action']['action_id']
    entry = _audit_for(action_id)
    assert entry['decision'] == 'pending'
    assert entry['action_type'] == 'scale'


def test_integration_check_reports_every_managed_service():
    """六类核心流程之一的全端联调必须有真实实现, 而非旁白。"""
    body = client.get('/api/integration-check').json()
    assert body['success'] is True
    assert body['mode'] == 'demo'
    names = [item['service'] for item in body['services']]
    assert names == sorted(['guide-service', 'ai-agent', 'data-dashboard', 'miniapp-api'])
    assert body['passed'] == body['total'] == len(names)
    assert all(item['connected'] for item in body['services'])
    assert '全端联调通过' in body['summary']


def test_integration_check_detects_a_broken_service():
    from app.store import store

    original = store.pod_recovery_seconds
    store.pod_recovery_seconds = 60.0
    try:
        # Earlier tests may have scaled this service, so take down *all* its replicas.
        targets = [p['name'] for p in store.pods if p['deployment'] == 'data-dashboard']
        assert targets
        for target in targets:
            pending = client.post('/api/chaos/kill', json={'pod_name': target}).json()
            client.post('/api/agent/approve', json={'action_id': pending['action_id'], 'approved': True})

        body = client.get('/api/integration-check').json()
        broken = next(item for item in body['services'] if item['service'] == 'data-dashboard')
        assert broken['connected'] is False
        assert 'ready' in broken['failed_checks']
        assert body['passed'] < body['total']
        assert '未连通' in body['summary']
    finally:
        store.pod_recovery_seconds = original


def test_integration_check_is_audited():
    client.get('/api/integration-check')
    actions = [item['action_type'] for item in client.get('/api/audit').json()['items']]
    assert 'integration_check' in actions


def test_deploy_and_rollback_are_audited():
    client.post('/api/deploy')
    client.post('/api/rollback')
    decisions = [(item['action_type'], item['decision']) for item in client.get('/api/audit').json()['items']]
    assert ('deploy', 'executed') in decisions
    assert ('rollback', 'executed') in decisions


def test_clear_logs_empties_buffer_and_is_audited():
    client.post('/api/load-test')
    assert client.get('/api/logs').json()['items']
    cleared = client.delete('/api/logs').json()
    assert cleared['success'] is True
    assert cleared['cleared'] > 0
    assert client.get('/api/logs').json()['items'] == []
    actions = [(item['action_type'], item['decision']) for item in client.get('/api/audit').json()['items']]
    assert ('clear_logs', 'executed') in actions
