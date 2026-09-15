from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "CloudHelm 运维作战室"
    namespace: str = "cloudhelm"
    demo_fallback: bool = True
    k8s_enabled: bool = True
    allowed_deployments: str = "guide-service,ai-agent,data-dashboard,miniapp-api"
    prometheus_url: str = ""
    image_registries: str = "cloudhelm,registry.local"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_prefix="")

    @property
    def deployment_names(self) -> set[str]:
        return {item.strip() for item in self.allowed_deployments.split(",") if item.strip()}

    @property
    def approved_registries(self) -> set[str]:
        return {item.strip() for item in self.image_registries.split(",") if item.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
