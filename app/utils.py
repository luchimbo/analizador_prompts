import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


URL_REGEX = re.compile(r"https?://[^\s<>()\[\]{}\"']+")
TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"}


def ensure_directory(path: str | Path) -> Path:
    directory = Path(path)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def normalize_whitespace(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(value.split()).strip()


def unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        cleaned = normalize_whitespace(value)
        if not cleaned:
            continue
        lowered = cleaned.casefold()
        if lowered in seen:
            continue
        seen.add(lowered)
        output.append(cleaned)
    return output


def strip_code_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned.replace("```", "", 1)
    if cleaned.endswith("```"):
        cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()


def safe_json_loads(text: str) -> Any:
    cleaned = strip_code_fences(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def extract_urls(text: str) -> list[str]:
    if not text:
        return []
    matches = URL_REGEX.findall(text)
    cleaned = [match.rstrip(".,);]") for match in matches]
    return unique_preserve_order(cleaned)


def normalize_url(url: str | None) -> str:
    if not url:
        return ""
    parsed = urlparse(url.strip())
    scheme = parsed.scheme.lower() or "https"
    netloc = parsed.netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    query_pairs = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key.lower() not in TRACKING_PARAMS]
    query = urlencode(query_pairs)
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    normalized = parsed._replace(scheme=scheme, netloc=netloc, path=path, query=query, fragment="")
    return urlunparse(normalized)


def host_to_store_name(host: str) -> str:
    parts = [part for part in host.lower().split(".") if part and part not in {"www", "com", "net", "org", "ar"}]
    if not parts:
        return host
    label = parts[0].replace("-", " ").replace("_", " ")
    return label.title()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)
