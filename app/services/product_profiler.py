import json
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from app.config import Settings
from app.schemas import ProductProfile, ProductProfileOverrides
from app.utils import host_to_store_name, normalize_url, normalize_whitespace, unique_preserve_order


class ProductProfiler:
    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )

    def __init__(self, settings: Settings):
        self.settings = settings

    def build_profile(self, product_url: str, overrides: ProductProfileOverrides | None = None) -> ProductProfile:
        overrides = overrides or ProductProfileOverrides()
        headers = {"User-Agent": self.USER_AGENT, "Accept-Language": "es-AR,es;q=0.9,en;q=0.8"}
        with httpx.Client(timeout=self.settings.request_timeout_seconds, follow_redirects=True, headers=headers) as client:
            response = client.get(product_url)
            response.raise_for_status()

        final_url = str(response.url)
        soup = BeautifulSoup(response.text, "lxml")
        parsed_url = urlparse(final_url)
        domain = parsed_url.netloc.lower()
        notes: list[str] = []

        page_title = normalize_whitespace(soup.title.string if soup.title and soup.title.string else "") or None
        h1 = normalize_whitespace(soup.find("h1").get_text(" ", strip=True) if soup.find("h1") else "") or None
        canonical_url = self._extract_canonical_url(soup) or final_url
        meta_description = self._extract_meta_content(soup, "description") or self._extract_meta_property(soup, "og:description")
        og_title = self._extract_meta_property(soup, "og:title")

        product_schema = self._extract_schema_object(soup, "Product")
        organization_schema = self._extract_schema_object(soup, "Organization")

        product_name = self._first_non_empty(
            overrides.product_name,
            self._schema_value(product_schema, "name"),
            og_title,
            h1,
            page_title,
        )
        if not product_name:
            raise RuntimeError("No se pudo extraer un nombre de producto util desde la URL")

        brand_name = self._first_non_empty(
            overrides.brand_name,
            self._extract_brand_name(product_schema),
            self._extract_meta_property(soup, "product:brand"),
        )
        store_name = self._first_non_empty(
            overrides.store_name,
            self._schema_value(organization_schema, "name"),
            host_to_store_name(domain),
        )
        category = self._first_non_empty(
            overrides.category,
            self._schema_value(product_schema, "category"),
            self._extract_breadcrumb_category(soup),
        )

        aliases = self._build_aliases(product_name, brand_name, overrides.aliases)
        vendor_aliases = unique_preserve_order(overrides.vendor_aliases + ([store_name] if store_name else []) + ([brand_name] if brand_name else []))
        competitor_names = unique_preserve_order(overrides.competitor_names)

        if product_schema:
            notes.append("Product schema detected")
        if organization_schema:
            notes.append("Organization schema detected")
        if overrides.model_dump(exclude_none=True, exclude_defaults=True):
            notes.append("Manual overrides applied")

        return ProductProfile(
            source_url=product_url,
            canonical_url=normalize_url(overrides.canonical_url or canonical_url),
            domain=domain,
            product_name=normalize_whitespace(product_name),
            brand_name=normalize_whitespace(brand_name) or None,
            store_name=normalize_whitespace(store_name) or None,
            category=normalize_whitespace(category) or None,
            page_title=page_title,
            meta_description=normalize_whitespace(meta_description) or None,
            aliases=aliases,
            vendor_aliases=vendor_aliases,
            competitor_names=competitor_names,
            extraction_notes=notes,
        )

    def _extract_canonical_url(self, soup: BeautifulSoup) -> str | None:
        canonical = soup.find("link", rel=lambda value: value and "canonical" in value.lower())
        if canonical and canonical.get("href"):
            return canonical.get("href")
        return None

    def _extract_meta_content(self, soup: BeautifulSoup, name: str) -> str | None:
        tag = soup.find("meta", attrs={"name": name})
        return tag.get("content") if tag and tag.get("content") else None

    def _extract_meta_property(self, soup: BeautifulSoup, prop: str) -> str | None:
        tag = soup.find("meta", attrs={"property": prop})
        return tag.get("content") if tag and tag.get("content") else None

    def _extract_schema_object(self, soup: BeautifulSoup, schema_type: str) -> dict | None:
        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            raw = script.string or script.get_text(" ", strip=True)
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            for candidate in self._iter_schema_items(payload):
                candidate_type = candidate.get("@type")
                if isinstance(candidate_type, list) and schema_type in candidate_type:
                    return candidate
                if candidate_type == schema_type:
                    return candidate
        return None

    def _iter_schema_items(self, payload: object):
        if isinstance(payload, list):
            for item in payload:
                yield from self._iter_schema_items(item)
        elif isinstance(payload, dict):
            if "@graph" in payload and isinstance(payload["@graph"], list):
                for item in payload["@graph"]:
                    yield from self._iter_schema_items(item)
            else:
                yield payload

    def _schema_value(self, schema: dict | None, key: str) -> str | None:
        if not schema:
            return None
        value = schema.get(key)
        if isinstance(value, dict):
            return value.get("name") or value.get("value")
        if isinstance(value, str):
            return value
        return None

    def _extract_brand_name(self, product_schema: dict | None) -> str | None:
        if not product_schema:
            return None
        brand = product_schema.get("brand")
        if isinstance(brand, dict):
            return brand.get("name") or brand.get("brand")
        if isinstance(brand, str):
            return brand
        return None

    def _extract_breadcrumb_category(self, soup: BeautifulSoup) -> str | None:
        breadcrumbs = soup.select("nav[aria-label*='breadcrumb'] a, .breadcrumb a")
        items = [normalize_whitespace(node.get_text(" ", strip=True)) for node in breadcrumbs]
        items = [item for item in items if item]
        if len(items) >= 2:
            return items[-2]
        return None

    def _build_aliases(self, product_name: str, brand_name: str | None, manual_aliases: list[str]) -> list[str]:
        candidates = [product_name]
        if brand_name and product_name.lower().startswith(brand_name.lower()):
            candidates.append(product_name[len(brand_name) :].strip(" -"))
        candidates.extend(manual_aliases)
        compact = product_name.replace("-", " ")
        if compact != product_name:
            candidates.append(compact)
        return unique_preserve_order(candidates)

    def _first_non_empty(self, *values: str | None) -> str | None:
        for value in values:
            cleaned = normalize_whitespace(value)
            if cleaned:
                return cleaned
        return None
