import { STANDARD_PROMPT_COUNT, STANDARD_TYPE_COUNTS } from "@/lib/audit-metrics";
import { env, getOpenRouterGeneratorModel } from "@/lib/env";
import { openRouterChatJson } from "@/lib/openrouter";
import type { AuditPrompt, ProductProfile, PromptBank, PromptType } from "@/lib/types";
import { normalizeWhitespace } from "@/lib/utils";

const GENERATOR_SYSTEM_PROMPT = `You generate high quality search prompts for a GEO audit focused on a single product URL.
You must return strict JSON only.

Rules:
- Generate exactly ${STANDARD_PROMPT_COUNT} prompts.
- Use these exact type counts:
  - ${STANDARD_TYPE_COUNTS.problem} problem
  - ${STANDARD_TYPE_COUNTS.discovery} discovery
  - ${STANDARD_TYPE_COUNTS.comparison} comparison
  - ${STANDARD_TYPE_COUNTS.transactional} transactional
  - ${STANDARD_TYPE_COUNTS.branded} branded
- Keep prompts natural, varied, and non-duplicated.
- Most prompts must be unbranded and realistic for a buyer.
- Do not mention the target product in problem, discovery, or most comparison prompts unless it is natural.
- Branded prompts can mention the product and the brand directly.
- Keep the prompts in the requested language and aligned to the requested market.

JSON schema:
{
  "productName": "string",
  "brandName": "string or null",
  "category": "string or null",
  "language": "string",
  "market": "string",
  "prompts": [
    {"id": "P01", "type": "problem", "prompt": "..."}
  ]
}`;

interface PromptBankPayload {
  productName?: string;
  brandName?: string | null;
  category?: string | null;
  language?: string;
  market?: string;
  prompts?: Array<{ id?: string; type?: PromptType; prompt?: string }>;
}

export async function generatePromptBank(profile: ProductProfile, language = env.defaultLanguage, market = env.defaultMarket): Promise<PromptBank> {
  try {
    return validatePromptBank(await generateWithLlm(profile, language, market));
  } catch {
    return validatePromptBank(generateFallback(profile, language, market));
  }
}

async function generateWithLlm(profile: ProductProfile, language: string, market: string): Promise<PromptBank> {
  const payload = {
    productName: profile.productName,
    brandName: profile.brandName,
    storeName: profile.storeName,
    category: profile.category,
    canonicalUrl: profile.canonicalUrl,
    aliases: profile.aliases,
    vendorAliases: profile.vendorAliases,
    language,
    market,
  };

  const parsed = await openRouterChatJson<PromptBankPayload>({
    model: getOpenRouterGeneratorModel(),
    systemPrompt: GENERATOR_SYSTEM_PROMPT,
    userPrompt: `Generate the prompt bank for this product profile and return strict JSON only.\n\n${JSON.stringify(payload, null, 2)}`,
    temperature: 0.7,
    maxTokens: 5000,
  });

  return {
    productName: parsed.productName ?? profile.productName,
    brandName: parsed.brandName ?? profile.brandName ?? null,
    category: parsed.category ?? profile.category ?? null,
    language: parsed.language ?? language,
    market: parsed.market ?? market,
    prompts: (parsed.prompts ?? []).map((item, index) => ({
      id: item.id ?? `P${String(index + 1).padStart(2, "0")}`,
      type: item.type ?? "problem",
      prompt: normalizeWhitespace(item.prompt ?? ""),
    })),
  };
}

function generateFallback(profile: ProductProfile, language: string, market: string): PromptBank {
  const prompts = language.startsWith("es") ? spanishTemplates(profile, market) : englishTemplates(profile, market);
  return validatePromptBank({
    productName: profile.productName,
    brandName: profile.brandName ?? null,
    category: profile.category ?? null,
    language,
    market,
    prompts: prompts.map((item, index) => ({
      id: `P${String(index + 1).padStart(2, "0")}`,
      type: item.type,
      prompt: item.prompt,
    })),
  });
}

export function validatePromptBank(bank: PromptBank): PromptBank {
  if (bank.prompts.length !== STANDARD_PROMPT_COUNT) {
    throw new Error(`El generador no devolvio exactamente ${STANDARD_PROMPT_COUNT} prompts`);
  }

  const seen = new Set<string>();
  const counts = new Map<PromptType, number>();

  const prompts = bank.prompts.map((prompt, index) => {
    const text = normalizeWhitespace(prompt.prompt);
    const lowered = text.toLowerCase();
    if (!text || seen.has(lowered)) {
      throw new Error("Se detectaron prompts vacios o duplicados");
    }
    seen.add(lowered);
    counts.set(prompt.type, (counts.get(prompt.type) ?? 0) + 1);
    return {
      id: `P${String(index + 1).padStart(2, "0")}`,
      type: prompt.type,
      prompt: text,
    } satisfies AuditPrompt;
  });

  for (const [type, expected] of Object.entries(STANDARD_TYPE_COUNTS) as Array<[PromptType, number]>) {
    if ((counts.get(type) ?? 0) !== expected) {
      throw new Error(`La distribucion de tipos no coincide para ${type}`);
    }
  }

  return { ...bank, prompts };
}

function spanishTemplates(profile: ProductProfile, market: string): AuditPrompt[] {
  const category = profile.category ?? "esta categoria";
  const brand = profile.brandName ?? "la marca";
  const product = profile.productName;
  const suffix = market ? ` en ${market}` : "";

  const groups: Array<[PromptType, string[]]> = [
    ["problem", [
      `Que ${category} recomiendan para empezar${suffix}?`,
      `Busco el mejor ${category} relacion precio calidad${suffix}.`,
      `Que ${category} conviene para alguien que recien arranca${suffix}?`,
      `Necesito un ${category} facil de usar y confiable${suffix}.`,
      `Que ${category} me conviene para practicar todos los dias${suffix}?`,
      `Que ${category} recomiendan para usar en casa sin complicaciones${suffix}?`,
      `Busco un ${category} rendidor para estudio y practica${suffix}.`,
      `Que ${category} elegirian para un usuario intermedio${suffix}?`,
      `Cual es un buen ${category} para regalar${suffix}?`,
      `Que ${category} ofrece buen equilibrio entre calidad y precio${suffix}?`,
      `Que ${category} conviene si quiero algo durable${suffix}?`,
      `Que ${category} recomiendan para espacio chico${suffix}?`,
      `Busco un ${category} portable y comodo de usar${suffix}.`,
      `Que ${category} recomiendan para home studio${suffix}?`,
      `Necesito un ${category} para aprender rapido y no renegar${suffix}.`,
      `Que ${category} vale la pena comprar hoy${suffix}?`,
      `Que ${category} recomiendan para alguien que quiere algo serio sin gastar de mas${suffix}?`,
      `Busco opciones de ${category} con buena reputacion${suffix}.`,
      `Que ${category} recomiendan si quiero una compra segura${suffix}?`,
      `Cual seria una recomendacion inteligente de ${category}${suffix}?`,
    ]],
    ["discovery", [
      `Cuales son las mejores opciones de ${category}${suffix}?`,
      `Que marcas suelen destacarse en ${category}${suffix}?`,
      `Que modelos populares hay dentro de ${category}${suffix}?`,
      `Que opciones recomendarias dentro de ${category} para distintos presupuestos${suffix}?`,
      `Cuales son las opciones mas recomendadas de ${category}${suffix}?`,
      `Que ${category} suele aparecer como recomendado por expertos${suffix}?`,
      `Que alternativas interesantes hay hoy dentro de ${category}${suffix}?`,
      `Que ${category} me conviene mirar antes de comprar${suffix}?`,
      `Como descubrir buenos modelos de ${category}${suffix}?`,
      `Que opciones de ${category} tienen mejor valor general${suffix}?`,
    ]],
    ["comparison", [
      `Que diferencias hay entre opciones economicas y gama media en ${category}${suffix}?`,
      `Que conviene mas en ${category}: precio bajo o mejores prestaciones${suffix}?`,
      `Que suele recomendarse mas en ${category} cuando se compara calidad y precio${suffix}?`,
      `Cuales son los mejores ${category} frente a otras alternativas conocidas${suffix}?`,
      `Que ${category} compite mejor contra marcas reconocidas${suffix}?`,
      `Que modelos de ${category} suelen compararse entre si${suffix}?`,
      `Si comparas marcas de ${category}, cuales salen mejor paradas${suffix}?`,
      `Que ${category} esta mejor posicionado frente a la competencia${suffix}?`,
      `Que ${category} recomendarias si estoy comparando varias opciones${suffix}?`,
      `Que opciones de ${category} suelen ganar en comparativas reales${suffix}?`,
    ]],
    ["transactional", [
      `Donde conviene comprar un ${category}${suffix}?`,
      `Que ${category} recomendarias comprar hoy${suffix}?`,
      `Que opcion de ${category} conviene comprar online${suffix}?`,
      `Que ${category} elegir para comprar con buena relacion precio calidad${suffix}?`,
      `Cual seria una compra recomendada dentro de ${category}${suffix}?`,
    ]],
    ["branded", [
      `Vale la pena comprar el ${product}${suffix}?`,
      `Que opinion tenes del ${product}${suffix}?`,
      `El ${product} es una buena opcion frente a otras alternativas${suffix}?`,
      `Donde comprarias el ${product}${suffix}?`,
      `Recomendarias el ${product} de ${brand} y donde lo comprarias${suffix}?`,
    ]],
  ];

  return flattenPromptGroups(groups, STANDARD_TYPE_COUNTS);
}

function englishTemplates(profile: ProductProfile, market: string): AuditPrompt[] {
  const category = profile.category ?? "this category";
  const brand = profile.brandName ?? "the brand";
  const product = profile.productName;
  const suffix = market ? ` in ${market}` : "";

  const groups: Array<[PromptType, string[]]> = [
    ["problem", [
      `What ${category} would you recommend for a beginner${suffix}?`,
      `What is the best value for money option in ${category}${suffix}?`,
      `Which ${category} is easiest to start with${suffix}?`,
      `What ${category} would you recommend for daily use${suffix}?`,
      `Which ${category} gives a safe purchase choice${suffix}?`,
      `What ${category} is good for home use${suffix}?`,
      `What ${category} is good for a small space${suffix}?`,
      `Which ${category} would you buy for balanced quality and price${suffix}?`,
      `What ${category} is good for intermediate users${suffix}?`,
      `Which ${category} would you recommend as a gift${suffix}?`,
      `What ${category} is worth buying right now${suffix}?`,
      `What ${category} is reliable and easy to use${suffix}?`,
      `Which ${category} is a smart first purchase${suffix}?`,
      `Which ${category} would you suggest for home studio use${suffix}?`,
      `What ${category} is durable and practical${suffix}?`,
      `Which ${category} is good without overspending${suffix}?`,
      `What ${category} would you recommend for someone learning fast${suffix}?`,
      `Which ${category} stands out for overall value${suffix}?`,
      `What ${category} would you trust most${suffix}?`,
      `Which ${category} would you recommend today${suffix}?`,
    ]],
    ["discovery", [
      `What are the best options in ${category}${suffix}?`,
      `Which brands stand out in ${category}${suffix}?`,
      `What popular models exist in ${category}${suffix}?`,
      `Which ${category} models are most recommended${suffix}?`,
      `How would you discover strong options in ${category}${suffix}?`,
      `What ${category} should I consider before buying${suffix}?`,
      `Which ${category} options have the best overall value${suffix}?`,
      `What are the most trusted options in ${category}${suffix}?`,
      `Which ${category} is most commonly recommended${suffix}?`,
      `What are interesting alternatives in ${category}${suffix}?`,
    ]],
    ["comparison", [
      `What is the difference between entry and mid range options in ${category}${suffix}?`,
      `Which ${category} wins when comparing quality and price${suffix}?`,
      `Which ${category} competes best against well known brands${suffix}?`,
      `What models in ${category} are usually compared against each other${suffix}?`,
      `Which ${category} is best positioned against competitors${suffix}?`,
      `What ${category} would you compare before buying${suffix}?`,
      `Which ${category} options perform best in real comparisons${suffix}?`,
      `What ${category} do people compare most often${suffix}?`,
      `Which ${category} stands out in product comparisons${suffix}?`,
      `What ${category} gives the best tradeoff in comparisons${suffix}?`,
    ]],
    ["transactional", [
      `Where should I buy a ${category}${suffix}?`,
      `Which ${category} would you buy online right now${suffix}?`,
      `What ${category} is the smartest buy today${suffix}?`,
      `Which ${category} would you recommend purchasing${suffix}?`,
      `What is a safe online purchase choice in ${category}${suffix}?`,
    ]],
    ["branded", [
      `Is the ${product} worth buying${suffix}?`,
      `What do you think about the ${product}${suffix}?`,
      `Would you recommend the ${product} over other options${suffix}?`,
      `Where would you buy the ${product}${suffix}?`,
      `Would you recommend the ${product} from ${brand}${suffix}?`,
    ]],
  ];

  return flattenPromptGroups(groups, STANDARD_TYPE_COUNTS);
}

function flattenPromptGroups(groups: Array<[PromptType, string[]]>, counts: Record<PromptType, number>): AuditPrompt[] {
  const prompts: AuditPrompt[] = [];
  let index = 1;
  for (const [type, items] of groups) {
    const expected = counts[type] ?? items.length;
    for (const item of items.slice(0, expected)) {
      prompts.push({ id: `P${String(index).padStart(2, "0")}`, type, prompt: normalizeWhitespace(item) });
      index += 1;
    }
  }
  return prompts;
}
