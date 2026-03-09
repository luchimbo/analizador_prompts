import { URL } from "node:url";

export const URL_REGEX = /https?:\/\/[^\s<>()\[\]{}"']+/g;

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
]);

export function normalizeWhitespace(value?: string | null): string {
  if (!value) {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

export function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      continue;
    }
    const lowered = cleaned.toLocaleLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    output.push(cleaned);
  }

  return output;
}

export function stripCodeFences(value: string): string {
  const cleaned = value.trim();
  if (!cleaned.startsWith("```")) {
    return cleaned;
  }
  const withoutFirst = cleaned.includes("\n") ? cleaned.split("\n").slice(1).join("\n") : cleaned.replace(/^```/, "");
  return withoutFirst.replace(/```$/, "").trim();
}

export function safeJsonParse<T>(value: string): T {
  const cleaned = stripCodeFences(value);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error("Invalid JSON response from model");
  }
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  return uniquePreserveOrder(matches.map((match) => match.replace(/[.,);\]]+$/, "")));
}

export function normalizeUrl(value?: string | null): string {
  if (!value) {
    return "";
  }

  const parsed = new URL(value);
  parsed.hash = "";
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

  const kept = new URLSearchParams();
  for (const [key, paramValue] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      kept.append(key, paramValue);
    }
  }
  parsed.search = kept.toString() ? `?${kept.toString()}` : "";

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString();
}

export function hostToStoreName(host: string): string {
  const parts = host
    .toLowerCase()
    .split(".")
    .filter((part) => part && !["www", "com", "net", "org", "ar"].includes(part));

  if (!parts.length) {
    return host;
  }

  const label = parts[0].replace(/[-_]/g, " ");
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
