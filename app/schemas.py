from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


PromptType = Literal["problem", "discovery", "comparison", "transactional", "branded"]
AuditedProvider = Literal["openai", "gemini", "kimi", "custom"]
RunStatus = Literal["pending", "running", "completed", "failed"]


class ProductProfileOverrides(BaseModel):
    product_name: str | None = None
    brand_name: str | None = None
    store_name: str | None = None
    canonical_url: str | None = None
    category: str | None = None
    aliases: list[str] = Field(default_factory=list)
    vendor_aliases: list[str] = Field(default_factory=list)
    competitor_names: list[str] = Field(default_factory=list)


class ProductProfile(BaseModel):
    source_url: str
    canonical_url: str
    domain: str
    product_name: str
    brand_name: str | None = None
    store_name: str | None = None
    category: str | None = None
    page_title: str | None = None
    meta_description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    vendor_aliases: list[str] = Field(default_factory=list)
    competitor_names: list[str] = Field(default_factory=list)
    extraction_notes: list[str] = Field(default_factory=list)


class ProfileRequest(BaseModel):
    product_url: str
    overrides: ProductProfileOverrides | None = None


class AuditPrompt(BaseModel):
    id: str
    type: PromptType
    prompt: str


class PromptBank(BaseModel):
    product_name: str
    brand_name: str | None = None
    category: str | None = None
    language: str
    market: str
    prompts: list[AuditPrompt]


class PromptBankRequest(BaseModel):
    product_url: str
    language: str = "es"
    market: str = "AR"
    overrides: ProductProfileOverrides | None = None


class PromptExecutionResult(BaseModel):
    prompt_id: str
    prompt_type: PromptType
    prompt_text: str
    raw_response: str
    detected_urls: list[str] = Field(default_factory=list)
    cited_urls: list[str] = Field(default_factory=list)
    model_provider: str
    model_name: str
    latency_ms: int
    created_at: datetime


class JudgedMetrics(BaseModel):
    product_hit: int
    vendor_hit: int
    exact_url_accuracy: int
    product_competitors: int
    rank: int
    evidence_snippet: str | None = None
    judge_provider: str | None = None
    judge_model: str | None = None
    judge_notes: str | None = None


class PromptAuditResult(BaseModel):
    prompt_id: str
    prompt_type: PromptType
    prompt_text: str
    raw_response: str
    detected_urls: list[str] = Field(default_factory=list)
    cited_urls: list[str] = Field(default_factory=list)
    model_provider: str
    model_name: str
    latency_ms: int
    created_at: datetime
    product_hit: int
    vendor_hit: int
    exact_url_accuracy: int
    product_competitors: int
    rank: int
    evidence_snippet: str | None = None
    judge_provider: str | None = None
    judge_model: str | None = None
    judge_notes: str | None = None


class RunSummary(BaseModel):
    total_prompts: int
    product_hit_rate: float
    vendor_hit_rate: float
    exact_url_accuracy_rate: float
    average_competitors: float
    average_rank_when_present: float


class AuditRunRequest(BaseModel):
    product_url: str
    audited_provider: AuditedProvider = "openai"
    audited_model: str | None = None
    language: str = "es"
    market: str = "AR"
    enable_web_search: bool = True
    verify_detected_urls: bool | None = None
    overrides: ProductProfileOverrides | None = None


class AuditRunResponse(BaseModel):
    run_id: str
    status: RunStatus
    created_at: datetime
    audited_provider: str
    audited_model: str
    product_profile: ProductProfile
    prompt_bank: PromptBank
    results: list[PromptAuditResult]
    summary: RunSummary | None = None
    export_path: str | None = None
    error_message: str | None = None


class RunListItem(BaseModel):
    run_id: str
    status: RunStatus
    created_at: datetime
    audited_provider: str
    audited_model: str
    product_name: str | None = None
    export_path: str | None = None
