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


def test_unknown_pod_is_rejected():
    response = client.post('/api/chaos/kill', json={'pod_name': 'unknown-pod'})
    assert response.status_code == 404


def test_metrics_are_explicitly_demo_without_prometheus():
    response = client.get('/api/metrics')
    assert response.status_code == 200
    assert response.json()['mode'] == 'demo'


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
