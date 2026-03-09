from __future__ import annotations

import re
import json
from typing import Any

import httpx

from app.clients.openrouter import OpenRouterClient
from app.config import Settings
from app.prompt_templates import JUDGE_SYSTEM_PROMPT
from app.schemas import JudgedMetrics, ProductProfile, PromptExecutionResult
from app.utils import normalize_url, normalize_whitespace, unique_preserve_order


class JudgeService:
    LIST_PATTERN = re.compile(r"^\s*(?:[-*]|\d+[\).])\s+(?P<text>.+)$")

    def __init__(self, settings: Settings, openrouter_client: OpenRouterClient):
        self.settings = settings
        self.openrouter_client = openrouter_client

    def judge(self, profile: ProductProfile, execution: PromptExecutionResult, verify_detected_urls: bool = False) -> JudgedMetrics:
        llm_metrics = self._judge_with_llm(profile, execution)
        product_hit = int(llm_metrics.get("product_hit", 0))
        rank = int(llm_metrics.get("rank", 0) or 0)
        product_competitors = int(llm_metrics.get("product_competitors", 0) or 0)
        evidence_snippet = llm_metrics.get("evidence_snippet") or self._extract_evidence(profile, execution.raw_response)
        judge_notes = llm_metrics.get("judge_notes")

        vendor_hit = 0
        if product_hit:
            vendor_hit = self._compute_vendor_hit(profile, execution.raw_response)

        exact_url_accuracy = 0
        if product_hit:
            exact_url_accuracy = self._compute_exact_url_accuracy(profile, execution.detected_urls, verify_detected_urls)

        return JudgedMetrics(
            product_hit=product_hit,
            vendor_hit=vendor_hit,
            exact_url_accuracy=exact_url_accuracy,
            product_competitors=max(product_competitors, 0),
            rank=max(rank, 0),
            evidence_snippet=evidence_snippet,
            judge_provider=llm_metrics.get("judge_provider"),
            judge_model=llm_metrics.get("judge_model"),
            judge_notes=judge_notes,
        )

    def _judge_with_llm(self, profile: ProductProfile, execution: PromptExecutionResult) -> dict[str, Any]:
        if self.openrouter_client.is_configured:
            user_prompt = self._build_user_prompt(profile, execution)
            try:
                parsed = self.openrouter_client.chat_json(
                    model=self.settings.openrouter_judge_model,
                    system_prompt=JUDGE_SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                    temperature=0,
                    max_tokens=1500,
                )
                parsed["judge_provider"] = "openrouter"
                parsed["judge_model"] = self.settings.openrouter_judge_model
                return parsed
            except Exception:
                pass

        heuristic = self._judge_with_heuristics(profile, execution)
        heuristic["judge_provider"] = "heuristic"
        heuristic["judge_model"] = "rules"
        return heuristic

    def _build_user_prompt(self, profile: ProductProfile, execution: PromptExecutionResult) -> str:
        payload = {
            "product_name": profile.product_name,
            "brand_name": profile.brand_name,
            "store_name": profile.store_name,
            "aliases": profile.aliases,
            "vendor_aliases": profile.vendor_aliases,
            "prompt": execution.prompt_text,
            "response": execution.raw_response,
        }
        return "Analyze this response and return strict JSON only.\n\n" + json.dumps(payload, ensure_ascii=True, indent=2)

    def _judge_with_heuristics(self, profile: ProductProfile, execution: PromptExecutionResult) -> dict[str, Any]:
        text = execution.raw_response
        lowered = text.casefold()
        aliases = unique_preserve_order([profile.product_name] + profile.aliases)
        product_hit = int(any(alias.casefold() in lowered for alias in aliases if alias))

        rank = self._estimate_rank(aliases, text) if product_hit else 0
        product_competitors = self._estimate_competitors(text, product_hit)
        evidence = self._extract_evidence(profile, text)
        notes = "Heuristic judge used because no LLM judge was available or it returned invalid JSON."
        return {
            "product_hit": product_hit,
            "product_competitors": product_competitors,
            "rank": rank,
            "evidence_snippet": evidence,
            "judge_notes": notes,
        }

    def _compute_vendor_hit(self, profile: ProductProfile, response_text: str) -> int:
        lowered = response_text.casefold()
        aliases = unique_preserve_order(profile.vendor_aliases + ([profile.store_name] if profile.store_name else []))
        return int(any(alias.casefold() in lowered for alias in aliases if alias))

    def _compute_exact_url_accuracy(self, profile: ProductProfile, detected_urls: list[str], verify_detected_urls: bool) -> int:
        target = normalize_url(profile.canonical_url)
        if not target:
            return 0
        for candidate in unique_preserve_order(detected_urls):
            normalized_candidate = normalize_url(candidate)
            if normalized_candidate == target:
                return 1
            if verify_detected_urls:
                resolved = self._resolve_url(candidate)
                if normalize_url(resolved) == target:
                    return 1
        return 0

    def _resolve_url(self, url: str) -> str:
        try:
            with httpx.Client(timeout=self.settings.request_timeout_seconds, follow_redirects=True) as client:
                response = client.get(url)
                return str(response.url)
        except Exception:
            return url

    def _estimate_rank(self, aliases: list[str], response_text: str) -> int:
        bullet_lines: list[str] = []
        for line in response_text.splitlines():
            match = self.LIST_PATTERN.match(line)
            if match:
                bullet_lines.append(match.group("text"))

        if bullet_lines:
            for index, line in enumerate(bullet_lines, start=1):
                lowered_line = line.casefold()
                if any(alias.casefold() in lowered_line for alias in aliases if alias):
                    return index
            return 0

        sentences = re.split(r"(?<=[.!?])\s+", response_text)
        for index, sentence in enumerate(sentences[:10], start=1):
            lowered_sentence = sentence.casefold()
            if any(alias.casefold() in lowered_sentence for alias in aliases if alias):
                return index
        return 1

    def _estimate_competitors(self, response_text: str, product_hit: int) -> int:
        items = 0
        for line in response_text.splitlines():
            if self.LIST_PATTERN.match(line):
                items += 1
        if items:
            return max(items - product_hit, 0)
        return 0

    def _extract_evidence(self, profile: ProductProfile, response_text: str) -> str | None:
        aliases = unique_preserve_order([profile.product_name] + profile.aliases)
        for line in response_text.splitlines():
            cleaned = normalize_whitespace(line)
            lowered = cleaned.casefold()
            if any(alias.casefold() in lowered for alias in aliases if alias):
                return cleaned[:280]
        return None
