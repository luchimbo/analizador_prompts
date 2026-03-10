import { env, assertOpenRouterKey } from "@/lib/env";
import { extractUrls, safeJsonParse, uniquePreserveOrder } from "@/lib/utils";

interface ChatOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  requestId?: string;
  temperature?: number;
  maxTokens?: number;
  enableWebSearch?: boolean;
}

interface OpenRouterMessage {
  content: string | Array<{ type?: string; text?: string }>;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: OpenRouterMessage }>;
}

export async function openRouterChat(options: ChatOptions): Promise<string> {
  const { data } = await requestChatCompletion(options);
  return extractMessageText(data);
}

export async function openRouterChatJson<T>(options: ChatOptions): Promise<T> {
  const raw = await openRouterChat(options);
  return safeJsonParse<T>(raw);
}

export async function openRouterExecutePrompt(options: ChatOptions): Promise<{ text: string; urls: string[]; latencyMs: number }> {
  const { data, latencyMs } = await requestChatCompletion(options);
  const text = extractMessageText(data);
  const urls = uniquePreserveOrder([...extractUrls(text), ...extractNestedUrls(data)]);
  return { text, urls, latencyMs };
}

async function requestChatCompletion({
  model,
  systemPrompt,
  userPrompt,
  requestId,
  temperature = 0.2,
  maxTokens = 4000,
  enableWebSearch = false,
}: ChatOptions): Promise<{ data: OpenRouterResponse; latencyMs: number }> {
  const apiKey = assertOpenRouterKey();
  const timeoutSeconds = Math.max(5, Number.isFinite(env.requestTimeoutSeconds) ? env.requestTimeoutSeconds : 60);
  const timeoutMs = timeoutSeconds * 1000;

  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  if (enableWebSearch && env.openRouterWebPluginId) {
    payload.plugins = [{ id: env.openRouterWebPluginId }];
  }

  const startedAt = Date.now();
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${env.openRouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(requestId ? { "X-Request-Id": requestId } : {}),
        ...(env.openRouterSiteUrl ? { "HTTP-Referer": env.openRouterSiteUrl } : {}),
        "X-Title": env.openRouterAppName,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error(`OpenRouter timeout after ${timeoutSeconds}s for model ${model}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  return { data, latencyMs: Date.now() - startedAt };
}

function extractMessageText(data: OpenRouterResponse): string {
  const message = data.choices?.[0]?.message?.content;
  if (!message) {
    return "";
  }
  if (typeof message === "string") {
    return message;
  }
  return message
    .map((chunk) => (typeof chunk.text === "string" ? chunk.text : ""))
    .filter(Boolean)
    .join("\n");
}

function extractNestedUrls(value: unknown): string[] {
  const urls: string[] = [];

  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }

    for (const [key, nestedValue] of Object.entries(node)) {
      if ((key === "url" || key === "uri") && typeof nestedValue === "string") {
        urls.push(nestedValue);
      }
      walk(nestedValue);
    }
  };

  walk(value);
  return urls;
}
