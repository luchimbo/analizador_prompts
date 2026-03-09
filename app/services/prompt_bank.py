import json
from collections import Counter
from typing import cast

from app.clients.openrouter import OpenRouterClient
from app.config import Settings
from app.prompt_templates import GENERATOR_SYSTEM_PROMPT
from app.schemas import AuditPrompt, ProductProfile, PromptBank, PromptType
from app.utils import normalize_whitespace


class PromptBankService:
    TYPE_COUNTS = {
        "problem": 20,
        "discovery": 10,
        "comparison": 10,
        "transactional": 5,
        "branded": 5,
    }

    def __init__(self, settings: Settings, openrouter_client: OpenRouterClient):
        self.settings = settings
        self.openrouter_client = openrouter_client

    def generate(self, profile: ProductProfile, language: str, market: str) -> PromptBank:
        if self.openrouter_client.is_configured:
            try:
                bank = self._generate_with_llm(profile, language, market)
                return self._validate(bank)
            except Exception:
                pass
        return self._validate(self._generate_fallback(profile, language, market))

    def _generate_with_llm(self, profile: ProductProfile, language: str, market: str) -> PromptBank:
        payload = {
            "product_name": profile.product_name,
            "brand_name": profile.brand_name,
            "store_name": profile.store_name,
            "category": profile.category,
            "canonical_url": profile.canonical_url,
            "aliases": profile.aliases,
            "vendor_aliases": profile.vendor_aliases,
            "market": market,
            "language": language,
        }
        user_prompt = (
            "Generate the prompt bank for this product profile. "
            "Return strict JSON only.\n\n"
            f"{json.dumps(payload, ensure_ascii=True, indent=2)}"
        )
        parsed = self.openrouter_client.chat_json(
            model=self.settings.openrouter_generator_model,
            system_prompt=GENERATOR_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            temperature=0.7,
            max_tokens=5000,
        )

        prompts = [AuditPrompt(**prompt) for prompt in parsed.get("prompts", [])]
        return PromptBank(
            product_name=parsed.get("product_name") or profile.product_name,
            brand_name=parsed.get("brand_name") or profile.brand_name,
            category=parsed.get("category") or profile.category,
            language=parsed.get("language") or language,
            market=parsed.get("market") or market,
            prompts=prompts,
        )

    def _generate_fallback(self, profile: ProductProfile, language: str, market: str) -> PromptBank:
        if language.lower().startswith("es"):
            prompts = self._spanish_templates(profile, market)
        else:
            prompts = self._english_templates(profile, market)

        audit_prompts = [
            AuditPrompt(id=f"P{index:02d}", type=cast(PromptType, prompt_type), prompt=text)
            for index, (prompt_type, text) in enumerate(prompts, start=1)
        ]
        return PromptBank(
            product_name=profile.product_name,
            brand_name=profile.brand_name,
            category=profile.category,
            language=language,
            market=market,
            prompts=audit_prompts,
        )

    def _spanish_templates(self, profile: ProductProfile, market: str) -> list[tuple[str, str]]:
        category = profile.category or "esta categoria"
        brand = profile.brand_name or "la marca"
        product = profile.product_name
        market_suffix = f" en {market}" if market else ""

        problem_prompts = [
            f"Que {category} recomiendan para empezar{market_suffix}?",
            f"Busco el mejor {category} relacion precio calidad{market_suffix}.",
            f"Que {category} conviene para alguien que recien arranca{market_suffix}?",
            f"Necesito un {category} facil de usar y confiable{market_suffix}.",
            f"Que {category} me conviene para practicar todos los dias{market_suffix}?",
            f"Que {category} recomiendan para usar en casa sin complicaciones{market_suffix}?",
            f"Busco un {category} rendidor para estudio y practica{market_suffix}.",
            f"Que {category} elegirian para un usuario intermedio{market_suffix}?",
            f"Cual es un buen {category} para regalar{market_suffix}?",
            f"Que {category} ofrece buen equilibrio entre calidad y precio{market_suffix}?",
            f"Que {category} conviene si quiero algo durable{market_suffix}?",
            f"Que {category} recomiendan para espacio chico{market_suffix}?",
            f"Busco un {category} portable y comodo de usar{market_suffix}.",
            f"Que {category} recomiendan para home studio{market_suffix}?",
            f"Necesito un {category} para aprender rapido y no renegar{market_suffix}.",
            f"Que {category} vale la pena comprar hoy{market_suffix}?",
            f"Que {category} recomiendan para alguien que quiere algo serio sin gastar de mas{market_suffix}?",
            f"Busco opciones de {category} con buena reputacion{market_suffix}.",
            f"Que {category} recomiendan si quiero una compra segura{market_suffix}?",
            f"Cual seria una recomendacion inteligente de {category}{market_suffix}?",
        ]
        discovery_prompts = [
            f"Cuales son las mejores opciones de {category}{market_suffix}?",
            f"Que marcas suelen destacarse en {category}{market_suffix}?",
            f"Que modelos populares hay dentro de {category}{market_suffix}?",
            f"Que opciones recomendarias dentro de {category} para distintos presupuestos{market_suffix}?",
            f"Cuales son las opciones mas recomendadas de {category}{market_suffix}?",
            f"Que {category} suele aparecer como recomendado por expertos{market_suffix}?",
            f"Que alternativas interesantes hay hoy dentro de {category}{market_suffix}?",
            f"Que {category} me conviene mirar antes de comprar{market_suffix}?",
            f"Como descubrir buenos modelos de {category}{market_suffix}?",
            f"Que opciones de {category} tienen mejor valor general{market_suffix}?",
        ]
        comparison_prompts = [
            f"Que diferencias hay entre opciones economicas y gama media en {category}{market_suffix}?",
            f"Que conviene mas en {category}: precio bajo o mejores prestaciones{market_suffix}?",
            f"Que suele recomendarse mas en {category} cuando se compara calidad y precio{market_suffix}?",
            f"Cuales son los mejores {category} frente a otras alternativas conocidas{market_suffix}?",
            f"Que {category} compite mejor contra marcas reconocidas{market_suffix}?",
            f"Que modelos de {category} suelen compararse entre si{market_suffix}?",
            f"Si comparas marcas de {category}, cuales salen mejor paradas{market_suffix}?",
            f"Que {category} esta mejor posicionado frente a la competencia{market_suffix}?",
            f"Que {category} recomendarias si estoy comparando varias opciones{market_suffix}?",
            f"Que opciones de {category} suelen ganar en comparativas reales{market_suffix}?",
        ]
        transactional_prompts = [
            f"Donde conviene comprar un {category}{market_suffix}?",
            f"Que {category} recomendarias comprar hoy{market_suffix}?",
            f"Que opcion de {category} conviene comprar online{market_suffix}?",
            f"Que {category} elegir para comprar con buena relacion precio calidad{market_suffix}?",
            f"Cual seria una compra recomendada dentro de {category}{market_suffix}?",
        ]
        branded_prompts = [
            f"Vale la pena comprar el {product}{market_suffix}?",
            f"Que opinion tenes del {product}{market_suffix}?",
            f"El {product} es una buena opcion frente a otras alternativas{market_suffix}?",
            f"Donde comprarias el {product}{market_suffix}?",
            f"Recomendarias el {product} de {brand} y donde lo comprarias{market_suffix}?",
        ]
        all_prompts: list[tuple[PromptType, str]] = []
        for value in problem_prompts:
            all_prompts.append(("problem", value))
        for value in discovery_prompts:
            all_prompts.append(("discovery", value))
        for value in comparison_prompts:
            all_prompts.append(("comparison", value))
        for value in transactional_prompts:
            all_prompts.append(("transactional", value))
        for value in branded_prompts:
            all_prompts.append(("branded", value))
        return [(prompt_type, normalize_whitespace(text)) for prompt_type, text in all_prompts]

    def _english_templates(self, profile: ProductProfile, market: str) -> list[tuple[str, str]]:
        category = profile.category or "this category"
        brand = profile.brand_name or "the brand"
        product = profile.product_name
        market_suffix = f" in {market}" if market else ""
        problem_prompts = [
            f"What {category} would you recommend for a beginner{market_suffix}?",
            f"What is the best value for money option in {category}{market_suffix}?",
            f"Which {category} is easiest to start with{market_suffix}?",
            f"What {category} would you recommend for daily use{market_suffix}?",
            f"Which {category} gives a safe purchase choice{market_suffix}?",
            f"What {category} is good for home use{market_suffix}?",
            f"What {category} is good for a small space{market_suffix}?",
            f"Which {category} would you buy for balanced quality and price{market_suffix}?",
            f"What {category} is good for intermediate users{market_suffix}?",
            f"Which {category} would you recommend as a gift{market_suffix}?",
            f"What {category} is worth buying right now{market_suffix}?",
            f"What {category} is reliable and easy to use{market_suffix}?",
            f"Which {category} is a smart first purchase{market_suffix}?",
            f"Which {category} would you suggest for home studio use{market_suffix}?",
            f"What {category} is durable and practical{market_suffix}?",
            f"Which {category} is good without overspending{market_suffix}?",
            f"What {category} would you recommend for someone learning fast{market_suffix}?",
            f"Which {category} stands out for overall value{market_suffix}?",
            f"What {category} would you trust most{market_suffix}?",
            f"Which {category} would you recommend today{market_suffix}?",
        ]
        discovery_prompts = [
            f"What are the best options in {category}{market_suffix}?",
            f"Which brands stand out in {category}{market_suffix}?",
            f"What popular models exist in {category}{market_suffix}?",
            f"Which {category} models are most recommended{market_suffix}?",
            f"How would you discover strong options in {category}{market_suffix}?",
            f"What {category} should I consider before buying{market_suffix}?",
            f"Which {category} options have the best overall value{market_suffix}?",
            f"What are the most trusted options in {category}{market_suffix}?",
            f"Which {category} is most commonly recommended{market_suffix}?",
            f"What are interesting alternatives in {category}{market_suffix}?",
        ]
        comparison_prompts = [
            f"What is the difference between entry and mid range options in {category}{market_suffix}?",
            f"Which {category} wins when comparing quality and price{market_suffix}?",
            f"Which {category} competes best against well known brands{market_suffix}?",
            f"What models in {category} are usually compared against each other{market_suffix}?",
            f"Which {category} is best positioned against competitors{market_suffix}?",
            f"What {category} would you compare before buying{market_suffix}?",
            f"Which {category} options perform best in real comparisons{market_suffix}?",
            f"What {category} do people compare most often{market_suffix}?",
            f"Which {category} stands out in product comparisons{market_suffix}?",
            f"What {category} gives the best tradeoff in comparisons{market_suffix}?",
        ]
        transactional_prompts = [
            f"Where should I buy a {category}{market_suffix}?",
            f"Which {category} would you buy online right now{market_suffix}?",
            f"What {category} is the smartest buy today{market_suffix}?",
            f"Which {category} would you recommend purchasing{market_suffix}?",
            f"What is a safe online purchase choice in {category}{market_suffix}?",
        ]
        branded_prompts = [
            f"Is the {product} worth buying{market_suffix}?",
            f"What do you think about the {product}{market_suffix}?",
            f"Would you recommend the {product} over other options{market_suffix}?",
            f"Where would you buy the {product}{market_suffix}?",
            f"Would you recommend the {product} from {brand}{market_suffix}?",
        ]
        all_prompts: list[tuple[PromptType, str]] = []
        for value in problem_prompts:
            all_prompts.append(("problem", value))
        for value in discovery_prompts:
            all_prompts.append(("discovery", value))
        for value in comparison_prompts:
            all_prompts.append(("comparison", value))
        for value in transactional_prompts:
            all_prompts.append(("transactional", value))
        for value in branded_prompts:
            all_prompts.append(("branded", value))
        return [(prompt_type, normalize_whitespace(text)) for prompt_type, text in all_prompts]

    def _validate(self, bank: PromptBank) -> PromptBank:
        prompts = bank.prompts
        if len(prompts) != 50:
            raise RuntimeError("El generador no devolvio exactamente 50 prompts")

        normalized_prompts: list[AuditPrompt] = []
        seen: set[str] = set()
        type_counts = Counter()
        for index, prompt in enumerate(prompts, start=1):
            text = normalize_whitespace(prompt.prompt)
            lowered = text.casefold()
            if not text or lowered in seen:
                raise RuntimeError("Se detectaron prompts vacios o duplicados")
            seen.add(lowered)
            normalized_prompts.append(AuditPrompt(id=f"P{index:02d}", type=prompt.type, prompt=text))
            type_counts[prompt.type] += 1

        if dict(type_counts) != self.TYPE_COUNTS:
            raise RuntimeError("La distribucion de tipos del prompt bank no coincide con la esperada")

        return PromptBank(
            product_name=bank.product_name,
            brand_name=bank.brand_name,
            category=bank.category,
            language=bank.language,
            market=bank.market,
            prompts=normalized_prompts,
        )
