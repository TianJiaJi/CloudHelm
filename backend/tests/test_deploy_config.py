"""Static consistency checks for the container/K8s startup chain.

Docker and kubectl are not available in every environment, so these tests assert
that the checked-in compose/nginx/K8s files agree with each other. They would
have caught the earlier `5173:5173` vs `listen 80` mismatch.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def _compose() -> dict:
    return yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))


def _docs(name: str) -> list[dict]:
    text = (ROOT / "deploy" / name).read_text(encoding="utf-8")
    return [doc for doc in yaml.safe_load_all(text) if doc]


def test_frontend_host_port_targets_nginx_listen_port():
    compose = _compose()
    mapping = str(compose["services"]["frontend"]["ports"][0])
    host, container = mapping.split(":")
    nginx = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    listen = re.search(r"listen\s+(\d+)", nginx).group(1)
    assert host == "5173"
    assert container == listen


def test_nginx_proxies_api_and_websockets_to_backend_service():
    nginx = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    assert "proxy_pass http://backend:8000" in nginx
    assert "proxy_set_header Upgrade $http_upgrade" in nginx
    assert 'proxy_set_header Connection "upgrade"' in nginx


def test_compose_backend_is_healthy_before_frontend_starts():
    compose = _compose()
    healthcheck = compose["services"]["backend"]["healthcheck"]
    assert "/api/health" in " ".join(healthcheck["test"])
    assert compose["services"]["frontend"]["depends_on"]["backend"]["condition"] == "service_healthy"


def test_compose_namespace_matches_k8s_manifests():
    compose_ns = _compose()["services"]["backend"]["environment"]["NAMESPACE"]
    namespace = next(doc for doc in _docs("namespace.yaml") if doc["kind"] == "Namespace")
    configmap = next(doc for doc in _docs("namespace.yaml") if doc["kind"] == "ConfigMap")
    assert compose_ns == "cloudhelm"
    assert namespace["metadata"]["name"] == compose_ns
    assert configmap["metadata"]["namespace"] == compose_ns
    assert configmap["data"]["NAMESPACE"] == compose_ns


def test_k8s_resources_share_one_namespace():
    for name in ("backend-deployment.yaml", "frontend-deployment.yaml", "rbac.yaml"):
        for doc in _docs(name):
            namespace = doc.get("metadata", {}).get("namespace")
            if namespace is not None:
                assert namespace == "cloudhelm", f"{name}: {doc['kind']} in {namespace}"


def test_container_build_definitions_exist():
    assert (ROOT / "backend" / "Dockerfile").is_file()
    assert (ROOT / "frontend" / "Dockerfile").is_file()
