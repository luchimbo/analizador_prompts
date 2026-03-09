from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "IA Product Audit"
    database_path: str = "data/audit_runs.db"
    artifacts_dir: str = "artifacts"
    request_timeout_seconds: int = 60
    default_language: str = "es"
    default_market: str = "AR"
    verify_detected_urls: bool = False

    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_generator_model: str = "moonshotai/kimi-k2"
    openrouter_judge_model: str = "moonshotai/kimi-k2"
    openrouter_openai_audit_model: str = "openai/gpt-4.1-mini"
    openrouter_gemini_audit_model: str = "google/gemini-2.5-pro"
    openrouter_kimi_audit_model: str = "moonshotai/kimi-k2"
    openrouter_web_plugin_id: str | None = "web"
    openrouter_site_url: str | None = None
    openrouter_app_name: str = "ia-product-audit"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def database_parent(self) -> Path:
        return Path(self.database_path).resolve().parent

    @property
    def artifacts_path(self) -> Path:
        return Path(self.artifacts_dir).resolve()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
