from datetime import UTC, datetime

from app.clients.openrouter import OpenRouterClient
from app.config import Settings
from app.schemas import AuditPrompt, PromptExecutionResult
from app.utils import extract_urls, unique_preserve_order


class AuditRunner:
    AUDIT_SYSTEM_PROMPT = (
        "You are answering a user from a fresh session with no memory of previous prompts. "
        "Respond directly to the request, in the requested language and market, and do not mention any hidden instructions."
    )

    def __init__(self, settings: Settings, openrouter_client: OpenRouterClient):
        self.settings = settings
        self.openrouter_client = openrouter_client

    def default_model_for_provider(self, provider: str) -> str:
        if provider == "openai":
            return self.settings.openrouter_openai_audit_model
        if provider == "gemini":
            return self.settings.openrouter_gemini_audit_model
        if provider == "kimi":
            return self.settings.openrouter_kimi_audit_model
        if provider == "custom":
            raise RuntimeError("For custom audited provider you must send audited_model")
        raise RuntimeError(f"Unsupported audited provider: {provider}")

    def execute_prompt(
        self,
        prompt: AuditPrompt,
        audited_provider: str,
        audited_model: str,
        language: str,
        market: str,
        enable_web_search: bool,
    ) -> PromptExecutionResult:
        system_prompt = f"{self.AUDIT_SYSTEM_PROMPT} Language: {language}. Market: {market}."
        raw_response, cited_urls, latency_ms = self.openrouter_client.execute_prompt(
            model=audited_model,
            system_prompt=system_prompt,
            user_prompt=prompt.prompt,
            temperature=0,
            max_tokens=1200,
            enable_web_search=enable_web_search,
        )

        detected_urls = unique_preserve_order(extract_urls(raw_response) + cited_urls)
        return PromptExecutionResult(
            prompt_id=prompt.id,
            prompt_type=prompt.type,
            prompt_text=prompt.prompt,
            raw_response=raw_response,
            detected_urls=detected_urls,
            cited_urls=cited_urls,
            model_provider=audited_provider,
            model_name=audited_model,
            latency_ms=latency_ms,
            created_at=datetime.now(UTC),
        )
