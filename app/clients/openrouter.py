import json
from time import perf_counter
from typing import Any

import httpx

from app.config import Settings
from app.utils import extract_urls, safe_json_loads, unique_preserve_order


class OpenRouterClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def is_configured(self) -> bool:
        return bool(self.settings.openrouter_api_key)

    def chat(self, model: str, system_prompt: str, user_prompt: str, temperature: float = 0.2, max_tokens: int = 4000) -> str:
        data, _ = self._chat_completion(
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_web_search=False,
        )
        return self._extract_message_text(data)

    def execute_prompt(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0,
        max_tokens: int = 1200,
        enable_web_search: bool = False,
    ) -> tuple[str, list[str], int]:
        data, latency_ms = self._chat_completion(
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_web_search=enable_web_search,
        )
        text = self._extract_message_text(data)
        urls = unique_preserve_order(extract_urls(text) + self._extract_urls(data))
        return text, urls, latency_ms

    def _chat_completion(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_tokens: int,
        enable_web_search: bool,
    ) -> tuple[dict[str, Any], int]:
        if not self.is_configured:
            raise RuntimeError("OPENROUTER_API_KEY is not configured")

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if enable_web_search and self.settings.openrouter_web_plugin_id:
            payload["plugins"] = [{"id": self.settings.openrouter_web_plugin_id}]

        start = perf_counter()
        with httpx.Client(timeout=self.settings.request_timeout_seconds) as client:
            response = client.post(f"{self.settings.openrouter_base_url}/chat/completions", headers=self._headers(), json=payload)
            response.raise_for_status()
            data = response.json()
        latency_ms = int((perf_counter() - start) * 1000)
        return data, latency_ms

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "X-Title": self.settings.openrouter_app_name,
        }
        if self.settings.openrouter_site_url:
            headers["HTTP-Referer"] = self.settings.openrouter_site_url
        return headers

    def _extract_message_text(self, data: dict[str, Any]) -> str:
        message = data["choices"][0]["message"]["content"]
        if isinstance(message, list):
            parts = []
            for chunk in message:
                if isinstance(chunk, dict) and chunk.get("type") == "text":
                    parts.append(chunk.get("text", ""))
            return "\n".join(part for part in parts if part)
        return str(message)

    def _extract_urls(self, data: Any) -> list[str]:
        urls: list[str] = []

        def walk(node: Any) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    if key in {"url", "uri"} and isinstance(value, str):
                        urls.append(value)
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(data)
        return urls

    def chat_json(self, model: str, system_prompt: str, user_prompt: str, temperature: float = 0.2, max_tokens: int = 4000) -> dict:
        raw = self.chat(model=model, system_prompt=system_prompt, user_prompt=user_prompt, temperature=temperature, max_tokens=max_tokens)
        parsed = safe_json_loads(raw)
        if not isinstance(parsed, dict):
            raise json.JSONDecodeError("Expected JSON object", raw, 0)
        return parsed
