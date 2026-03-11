import { normalizeWhitespace, uniquePreserveOrder } from "@/lib/utils";

const MODEL_TOKEN_PATTERN = /^(?=.*[a-z])(?=.*\d)[a-z0-9-]{3,}$/i;

export function buildProductAliases(productName: string, brandName?: string | null, manualAliases: string[] = []): string[] {
  const normalizedProductName = normalizeWhitespace(productName);
  const normalizedBrandName = normalizeWhitespace(brandName);
  const candidates = [normalizedProductName, normalizedProductName.replace(/-/g, " "), ...manualAliases].filter(Boolean);

  if (normalizedProductName && normalizedBrandName) {
    const withoutBrand = normalizeWhitespace(
      normalizedProductName.replace(new RegExp(`\\b${escapeRegExp(normalizedBrandName).replace(/\\ /g, "\\s+")}\\b`, "i"), " "),
    ).replace(/^[-\s]+|[-\s]+$/g, "");
    if (withoutBrand) {
      candidates.push(withoutBrand, withoutBrand.replace(/-/g, " "));
    }
  }

  for (const token of extractModelTokens(normalizedProductName)) {
    candidates.push(token, token.replace(/-/g, " "));
    if (normalizedBrandName) {
      candidates.push(`${normalizedBrandName} ${token}`, `${normalizedBrandName} ${token.replace(/-/g, " ")}`);
    }
  }

  return uniquePreserveOrder(candidates);
}

export function extractProductModelTokens(productName: string, aliases: string[] = []): string[] {
  const source = uniquePreserveOrder([productName, ...aliases]);
  return uniquePreserveOrder(source.flatMap((item) => extractModelTokens(item)));
}

function extractModelTokens(productName: string): string[] {
  return uniquePreserveOrder(
    normalizeWhitespace(productName)
      .split(/\s+/)
      .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9-]+$/gi, ""))
      .filter((token) => MODEL_TOKEN_PATTERN.test(token)),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
