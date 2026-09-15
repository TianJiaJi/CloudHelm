from __future__ import annotations
from typing import Any
from .config import Settings
from .store import RuntimeStore


class K8sUnavailable(RuntimeError):
    pass


class ClusterAdapter:
    def __init__(self, settings: Settings, store: RuntimeStore) -> None:
        self.settings = settings
        self.store = store
        self.apps = None
        self.core = None
        if settings.k8s_enabled:
            try:
                from kubernetes import client, config
                try:
                    config.load_kube_config()
                except Exception:
                    config.load_incluster_config()
                self.apps = client.AppsV1Api()
                self.core = client.CoreV1Api()
                self.core.get_api_resources(_request_timeout=2)
            except Exception:
                self.apps = None
                self.core = None

    @property
    def live(self) -> bool:
        return self.apps is not None and self.core is not None

    def _require_live(self) -> None:
        if not self.live:
            raise K8sUnavailable("Kubernetes API is unavailable")

    def pods(self) -> list[dict[str, Any]]:
        if not self.live:
            raise K8sUnavailable("Kubernetes API is unavailable")
        result = self.core.list_namespaced_pod(self.settings.namespace)
        return [{"name": item.metadata.name, "deployment": (item.metadata.labels or {}).get("app", "unknown"), "status": item.status.phase, "ready": item.status.phase == "Running", "restarts": sum((container.restart_count or 0) for container in (item.status.container_statuses or []))} for item in result.items]

    def deployment_names(self) -> set[str]:
        self._require_live()
        result = self.apps.list_namespaced_deployment(self.settings.namespace)
        return {item.metadata.name for item in result.items}

    def deploy(self, deployment: str, version: str) -> None:
        self._require_live()
        self.apps.patch_namespaced_deployment(deployment, self.settings.namespace, {"spec": {"template": {"metadata": {"annotations": {"cloudhelm.io/release": version}}}}})

    def scale(self, deployment: str, replicas: int) -> None:
        self._require_live()
        self.apps.patch_namespaced_deployment_scale(deployment, self.settings.namespace, {"spec": {"replicas": replicas}})

    def validate_pod(self, pod_name: str) -> None:
        self._require_live()
        pod = self.core.read_namespaced_pod(pod_name, self.settings.namespace)
        app = (pod.metadata.labels or {}).get("app")
        if app not in self.settings.deployment_names:
            raise K8sUnavailable("Pod is outside the allowed deployment scope")

    def delete_pod(self, pod_name: str) -> None:
        self.validate_pod(pod_name)
        self.core.delete_namespaced_pod(pod_name, self.settings.namespace)

    def update_image(self, deployment: str, image: str) -> None:
        self._require_live()
        self.apps.patch_namespaced_deployment(deployment, self.settings.namespace, {"spec": {"template": {"spec": {"containers": [{"name": deployment, "image": image}]}}}})
