from typing import Any, Literal
from pydantic import BaseModel, Field


class ScaleRequest(BaseModel):
    deployment: str = "guide-service"
    replicas: int = Field(ge=1, le=20)


class PodKillRequest(BaseModel):
    pod_name: str = Field(min_length=1, max_length=128)


class ImageUpdateRequest(BaseModel):
    deployment: str = "ai-agent"
    image: str = Field(min_length=1, max_length=256)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)


class AgentApprovalRequest(BaseModel):
    action_id: str = Field(min_length=1, max_length=64)
    approved: bool


class SettingsRequest(BaseModel):
    demo_fallback: bool


class ActionResponse(BaseModel):
    success: bool
    message: str
    mode: Literal["live", "demo"]
    action_id: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
