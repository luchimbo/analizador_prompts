"use client";

import { useEffect, useMemo, useState } from "react";

import { getPromptPlanDescription, getPromptPlanLabel, inferPromptCount, isLegacyPromptCount, isSupportedPromptCount, STANDARD_PROMPT_COUNT } from "@/lib/audit-metrics";
import type { AuditRunResponse, ProductListItem, ProductRunRequest, PromptAuditResult, RunListItem, RunProgressEvent, SavedProduct } from "@/lib/types";

const providers = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "custom", label: "Custom" },
] as const;

type ProviderValue = (typeof providers)[number]["value"];
type LoadingAction = "boot" | "add-product" | "select-product" | "prompts" | "run" | "run-detail" | null;

const LOCKED_LANGUAGE = "es";
const LOCKED_MARKET = "Argentina";

interface HealthConfig {
  defaultOpenAiModel?: string;
  defaultGeminiModel?: string;
}

interface CatalogBrandRule {
  brand: string;
  skuCount: number;
  classification: "internal" | "external";
  source: "default" | "override";
}

interface CatalogBrandResponse {
  items: CatalogBrandRule[];
  totals?: {
    totalBrands: number;
    internalBrands: number;
    externalBrands: number;
    internalSkus: number;
    externalSkus: number;
  };
}

export function AuditDashboard() {
  const [productUrl, setProductUrl] = useState("");
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<SavedProduct | null>(null);
  const [productRuns, setProductRuns] = useState<RunListItem[]>([]);
  const [activeRun, setActiveRun] = useState<AuditRunResponse | null>(null);
  const [auditedProvider, setAuditedProvider] = useState<ProviderValue>("openai");
  const [auditedModel, setAuditedModel] = useState("");
  const [showPrompts, setShowPrompts] = useState(false);
  const [loadingAction, setLoadingAction] = useState<LoadingAction>("boot");
  const [error, setError] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<{ current: number; total: number; promptId?: string; promptText?: string } | null>(null);
  const [streamedResults, setStreamedResults] = useState<PromptAuditResult[]>([]);
  const [catalogBrandRules, setCatalogBrandRules] = useState<CatalogBrandRule[]>([]);
  const [loadingBrandRules, setLoadingBrandRules] = useState(false);
  const [savingBrand, setSavingBrand] = useState<string | null>(null);
  const [reclassifyingHistory, setReclassifyingHistory] = useState(false);
  const [reclassifyMessage, setReclassifyMessage] = useState<string | null>(null);
  const [leftCompareRunId, setLeftCompareRunId] = useState<string>("");
  const [rightCompareRunId, setRightCompareRunId] = useState<string>("");
  const [leftCompareRun, setLeftCompareRun] = useState<AuditRunResponse | null>(null);
  const [rightCompareRun, setRightCompareRun] = useState<AuditRunResponse | null>(null);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [defaultModels, setDefaultModels] = useState<Record<ProviderValue, string>>({
    openai: "",
    gemini: "",
    custom: "",
  });

  const hasPendingWork = loadingAction !== null;
  const lockedAuditTarget = selectedProduct?.lockedAuditedProvider && selectedProduct?.lockedAuditedModel
    ? {
        provider: selectedProduct.lockedAuditedProvider,
        model: selectedProduct.lockedAuditedModel,
      }
    : null;
  const hasReadyPromptBank =
    isSupportedPromptCount(selectedProduct?.promptBank?.prompts.length ?? 0) &&
    selectedProduct?.promptBank?.language === LOCKED_LANGUAGE &&
    selectedProduct?.promptBank?.market === LOCKED_MARKET;
  const selectedPromptCount = inferPromptCount(selectedProduct?.promptBank) || STANDARD_PROMPT_COUNT;
  const showingLiveResults = loadingAction === "run" || streamedResults.length > 0;
  const visibleResults = showingLiveResults ? streamedResults : activeRun?.results ?? [];

  useEffect(() => {
    void loadProducts();
    void loadHealthDefaults();
    void loadCatalogBrandRules();
  }, []);

  useEffect(() => {
    if (lockedAuditTarget) {
      return;
    }
    const nextDefaultModel = defaultModels[auditedProvider];
    if (nextDefaultModel) {
      setAuditedModel(nextDefaultModel);
    }
  }, [auditedProvider, defaultModels, lockedAuditTarget]);

  const summaryCards = useMemo(() => {
    if (!activeRun?.summary) {
      return [];
    }

    return [
      { label: "Score", value: `${activeRun.summary.overallScore.toFixed(1)}/100` },
      { label: "Nivel", value: activeRun.summary.scoreLabel },
      { label: "Muestra", value: getPromptPlanLabel(activeRun.summary.totalPrompts) },
      { label: "Product Hit", value: `${Math.round(activeRun.summary.productHitRate * 100)}%` },
      { label: "Vendor Hit", value: `${Math.round(activeRun.summary.vendorHitRate * 100)}%` },
      { label: "URL Accuracy", value: `${Math.round(activeRun.summary.exactUrlAccuracyRate * 100)}%` },
      { label: "Avg Internal", value: (activeRun.summary.averageInternalAlternatives ?? 0).toFixed(2) },
      { label: "Avg External", value: (activeRun.summary.averageExternalCompetitors ?? 0).toFixed(2) },
      { label: "Avg Rank", value: activeRun.summary.averageRankWhenPresent.toFixed(2) },
    ];
  }, [activeRun]);

  const catalogTotals = useMemo(() => {
    return catalogBrandRules.reduce(
      (acc, item) => {
        if (item.classification === "internal") {
          acc.internalBrands += 1;
          acc.internalSkus += item.skuCount;
        } else {
          acc.externalBrands += 1;
          acc.externalSkus += item.skuCount;
        }
        return acc;
      },
      {
        totalBrands: catalogBrandRules.length,
        internalBrands: 0,
        externalBrands: 0,
        internalSkus: 0,
        externalSkus: 0,
      },
    );
  }, [catalogBrandRules]);

  const comparisonSummary = useMemo(() => {
    if (!leftCompareRun?.summary || !rightCompareRun?.summary) {
      return null;
    }

    const before = leftCompareRun.summary;
    const after = rightCompareRun.summary;
    return [
      { label: "Overall Score", before: before.overallScore, after: after.overallScore, percent: false },
      { label: "Product Hit", before: before.productHitRate, after: after.productHitRate, percent: true },
      { label: "Vendor Hit", before: before.vendorHitRate, after: after.vendorHitRate, percent: true },
      { label: "URL Accuracy", before: before.exactUrlAccuracyRate, after: after.exactUrlAccuracyRate, percent: true },
      { label: "Avg Internal", before: before.averageInternalAlternatives, after: after.averageInternalAlternatives, percent: false },
      { label: "Avg External", before: before.averageExternalCompetitors, after: after.averageExternalCompetitors, percent: false },
      { label: "Avg Rank", before: before.averageRankWhenPresent, after: after.averageRankWhenPresent, percent: false },
    ];
  }, [leftCompareRun, rightCompareRun]);

  const comparisonPromptDiffs = useMemo(() => {
    if (!leftCompareRun || !rightCompareRun) {
      return [] as Array<{ promptId: string; before: PromptAuditResult; after: PromptAuditResult }>;
    }

    const leftByPrompt = new Map(leftCompareRun.results.map((result) => [result.promptId, result]));
    const rightByPrompt = new Map(rightCompareRun.results.map((result) => [result.promptId, result]));
    const diffs: Array<{ promptId: string; before: PromptAuditResult; after: PromptAuditResult }> = [];

    for (const [promptId, before] of leftByPrompt.entries()) {
      const after = rightByPrompt.get(promptId);
      if (!after) {
        continue;
      }
      if (
        before.productHit !== after.productHit ||
        before.rank !== after.rank ||
        before.internalAlternatives !== after.internalAlternatives ||
        before.externalCompetitors !== after.externalCompetitors
      ) {
        diffs.push({ promptId, before, after });
      }
    }

    return diffs;
  }, [leftCompareRun, rightCompareRun]);

  const comparisonPromptPlanNote = useMemo(() => {
    if (!leftCompareRun || !rightCompareRun) {
      return null;
    }

    const leftCount = inferPromptCount(leftCompareRun.promptBank);
    const rightCount = inferPromptCount(rightCompareRun.promptBank);
    if (!leftCount || !rightCount || leftCount === rightCount) {
      return null;
    }

    return `Comparacion entre muestras distintas: ${getPromptPlanLabel(leftCount)} vs ${getPromptPlanLabel(rightCount)}.`;
  }, [leftCompareRun, rightCompareRun]);

  async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });

    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? "Request failed");
    }
    return data;
  }

  async function loadHealthDefaults() {
    try {
      const health = await requestJson<HealthConfig>("/api/health", { method: "GET" });
      const mappedDefaults: Record<ProviderValue, string> = {
        openai: health.defaultOpenAiModel ?? "",
        gemini: health.defaultGeminiModel ?? "",
        custom: "",
      };
      setDefaultModels(mappedDefaults);

      const normalizedCurrentModel = normalizeDisplayedModel(auditedProvider, auditedModel, mappedDefaults);
      if (normalizedCurrentModel !== auditedModel) {
        setAuditedModel(normalizedCurrentModel);
      } else if (!auditedModel) {
        const initial = mappedDefaults[auditedProvider];
        if (initial) {
          setAuditedModel(initial);
        }
      }
    } catch {}
  }

  async function loadCatalogBrandRules() {
    setLoadingBrandRules(true);

    try {
      const response = await requestJson<CatalogBrandResponse>("/api/catalog/brands", { method: "GET" });
      setCatalogBrandRules(response.items ?? []);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo cargar el clasificador de marcas");
    } finally {
      setLoadingBrandRules(false);
    }
  }

  async function handleBrandClassificationChange(brand: string, classification: "internal" | "external") {
    setSavingBrand(brand);
    setError(null);

    try {
      const response = await requestJson<CatalogBrandResponse>("/api/catalog/brands", {
        method: "PATCH",
        body: JSON.stringify({ brand, classification }),
      });
      setCatalogBrandRules(response.items ?? []);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo actualizar la clasificacion");
    } finally {
      setSavingBrand(null);
    }
  }

  async function handleReclassifyHistory() {
    setReclassifyingHistory(true);
    setError(null);
    setReclassifyMessage(null);

    try {
      const response = await requestJson<{ ok: boolean; updated: number }>("/api/catalog/reclassify", { method: "POST" });
      setReclassifyMessage(`Historico recalculado: ${response.updated} filas de resultados actualizadas.`);
      if (activeRun?.runId) {
        await loadRun(activeRun.runId);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo recalcular el historico");
    } finally {
      setReclassifyingHistory(false);
    }
  }

  async function loadProducts(preferredProductId?: string) {
    setLoadingAction((current) => (current === null ? "boot" : current));
    setError(null);

    try {
      const items = await requestJson<ProductListItem[]>("/api/products", { method: "GET" });
      setProducts(items);

      const nextProductId = preferredProductId ?? selectedProductId ?? items[0]?.productId ?? null;
      if (nextProductId) {
        await loadProductWorkspace(nextProductId);
      } else {
        setSelectedProductId(null);
        setSelectedProduct(null);
        setProductRuns([]);
        setActiveRun(null);
        setRunProgress(null);
        setStreamedResults([]);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudieron cargar los productos");
    } finally {
      setLoadingAction(null);
    }
  }

  async function loadProductWorkspace(productId: string, runId?: string | null) {
    setLoadingAction("select-product");
    setError(null);

    try {
      const [product, runs] = await Promise.all([
        requestJson<SavedProduct>(`/api/products/${productId}`, { method: "GET" }),
        requestJson<RunListItem[]>(`/api/products/${productId}/runs`, { method: "GET" }),
      ]);

      setSelectedProductId(productId);
      setSelectedProduct(product);
      const nextProvider = product.lockedAuditedProvider ? (normalizeProvider(product.lockedAuditedProvider) as ProviderValue) : auditedProvider;
      if (product.lockedAuditedProvider) {
        setAuditedProvider(nextProvider);
      }
      setAuditedModel(normalizeDisplayedModel(nextProvider, product.lockedAuditedModel ?? "", defaultModels));
      setShowPrompts(Boolean(product.promptBank));
      setProductRuns(runs);
      setRunProgress(null);
      setStreamedResults([]);
      const defaultLeft = runs[1]?.runId ?? runs[0]?.runId ?? "";
      const defaultRight = runs[0]?.runId ?? "";
      setLeftCompareRunId(defaultLeft);
      setRightCompareRunId(defaultRight);
      setLeftCompareRun(null);
      setRightCompareRun(null);

      const nextRunId = runId ?? product.latestRunId ?? runs[0]?.runId ?? null;
      if (nextRunId) {
        const run = await requestJson<AuditRunResponse>(`/api/runs/${nextRunId}`, { method: "GET" });
        setActiveRun(run);
      } else {
        setActiveRun(null);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo cargar el producto seleccionado");
    } finally {
      setLoadingAction(null);
    }
  }

  async function loadRun(runId: string) {
    setLoadingAction("run-detail");
    setError(null);
    try {
      const run = await requestJson<AuditRunResponse>(`/api/runs/${runId}`, { method: "GET" });
      setActiveRun(run);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo cargar la corrida");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleAddProduct() {
    if (!productUrl) {
      return;
    }

    setLoadingAction("add-product");
    setError(null);

    try {
      const product = await requestJson<SavedProduct>("/api/products", {
        method: "POST",
        body: JSON.stringify({ productUrl, language: LOCKED_LANGUAGE, market: LOCKED_MARKET }),
      });
      setProductUrl("");
      await loadProducts(product.productId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo guardar el producto");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDeleteProduct() {
    if (!selectedProductId || !selectedProduct) {
      return;
    }

    const confirmed = window.confirm(`Eliminar producto \"${selectedProduct.profile.productName}\" y todas sus corridas?`);
    if (!confirmed) {
      return;
    }

    setLoadingAction("select-product");
    setError(null);

    try {
      await requestJson<{ ok: boolean }>(`/api/products/${selectedProductId}`, { method: "DELETE" });
      setSelectedProductId(null);
      setSelectedProduct(null);
      setProductRuns([]);
      setActiveRun(null);
      setStreamedResults([]);
      setRunProgress(null);
      setShowPrompts(false);
      await loadProducts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo eliminar el producto");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleGeneratePrompts() {
    if (!selectedProductId) {
      return;
    }

    setLoadingAction("prompts");
    setError(null);

    try {
      const product = await requestJson<SavedProduct>(`/api/products/${selectedProductId}/prompts`, {
        method: "POST",
      });
      setSelectedProduct(product);
      setShowPrompts(true);
      await refreshProductsList(selectedProductId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudieron generar los prompts");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleRunAudit(resumeRunId?: string) {
    if (!selectedProductId || !hasReadyPromptBank) {
      return;
    }

    setLoadingAction("run");
    setError(null);

    try {
      const payload: ProductRunRequest = {
        auditedProvider,
        auditedModel: auditedModel || undefined,
        language: LOCKED_LANGUAGE,
        market: LOCKED_MARKET,
        enableWebSearch: true,
        resumeRunId,
      };
      setStreamedResults([]);
      setActiveRun(null);
      setRunProgress({ current: 0, total: selectedProduct?.promptBank?.prompts.length ?? STANDARD_PROMPT_COUNT });
      const response = await fetch(`/api/products/${selectedProductId}/runs/stream`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });

      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => ({ error: "No se pudo iniciar la corrida" }))) as { error?: string };
        throw new Error(data.error ?? "No se pudo iniciar la corrida");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completedRun: AuditRunResponse | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const event = JSON.parse(trimmed) as RunProgressEvent;
          if (event.type === "started") {
            setRunProgress({ current: event.current ?? 0, total: event.total ?? selectedProduct?.promptBank?.prompts.length ?? STANDARD_PROMPT_COUNT });
            setStreamedResults([]);
          }
          if (event.type === "progress") {
            setRunProgress({
              current: event.current ?? 0,
              total: event.total ?? selectedProduct?.promptBank?.prompts.length ?? STANDARD_PROMPT_COUNT,
              promptId: event.promptId,
              promptText: event.promptText,
            });
            if (event.result) {
              setStreamedResults((current) => [...current, event.result as PromptAuditResult]);
            }
          }
          if (event.type === "error") {
            throw new Error(event.message ?? "La corrida fallo durante la ejecucion");
          }
          if (event.type === "complete" && event.run) {
            completedRun = event.run;
          }
        }
      }

      if (!completedRun) {
        throw new Error("La corrida termino sin devolver un resultado final");
      }

      setActiveRun(completedRun);
      setRunProgress({ current: completedRun.results.length, total: completedRun.results.length });
      await loadProductWorkspace(selectedProductId, completedRun.runId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo ejecutar la auditoria");
      setRunProgress(null);
      await loadProductWorkspace(selectedProductId);
    } finally {
      setLoadingAction(null);
    }
  }

  async function refreshProductsList(preferredProductId?: string) {
    const items = await requestJson<ProductListItem[]>("/api/products", { method: "GET" });
    setProducts(items);
    if (!selectedProductId && items[0]?.productId) {
      setSelectedProductId(preferredProductId ?? items[0].productId);
    }
  }

  async function handleLoadComparison() {
    if (!leftCompareRunId || !rightCompareRunId) {
      return;
    }
    setLoadingComparison(true);
    setError(null);
    try {
      const [left, right] = await Promise.all([
        requestJson<AuditRunResponse>(`/api/runs/${leftCompareRunId}`, { method: "GET" }),
        requestJson<AuditRunResponse>(`/api/runs/${rightCompareRunId}`, { method: "GET" }),
      ]);
      setLeftCompareRun(left);
      setRightCompareRun(right);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo cargar comparacion de corridas");
    } finally {
      setLoadingComparison(false);
    }
  }

  return (
    <div className="shell">
      <section className="hero hero-product-first">
        <div className="hero-copy">
          <span className="eyebrow">GEO Product Audit</span>
          <h1>Primero elegis el producto. Despues ves prompts, respuestas y Excel.</h1>
          <p>
            La interfaz trabaja como una biblioteca de productos para el mercado argentino: agregas URLs, elegis una ficha guardada, generas sus prompts, elegis que IA la responda y revisas la corrida completa desde el mismo lugar.
          </p>
        </div>
        <div className="hero-metrics hero-metrics-tight">
          <div>
            <strong>{products.length}</strong>
            <span>productos guardados</span>
          </div>
          <div>
            <strong>{selectedProduct?.promptBank?.prompts.length ?? 0}</strong>
            <span>prompts del producto</span>
          </div>
          <div>
            <strong>{productRuns.length}</strong>
            <span>corridas historicas</span>
          </div>
        </div>
      </section>

      <section className="product-intake">
        <div className="field full">
          <label htmlFor="productUrl">Agregar producto por URL</label>
          <input
            id="productUrl"
            type="url"
            placeholder="https://www.ejemplo.com/producto/midiplus-easy-piano-e2"
            value={productUrl}
            onChange={(event) => setProductUrl(event.target.value)}
          />
        </div>
        <div className="field compact field-locked">
          <label>Idioma fijo</label>
          <div className="locked-value">Espanol</div>
        </div>
        <div className="field compact field-locked">
          <label>Mercado fijo</label>
          <div className="locked-value">Argentina</div>
        </div>
        <div className="actions full">
          <button className="primary" onClick={handleAddProduct} disabled={!productUrl || hasPendingWork}>
            {loadingAction === "add-product" ? "Guardando producto..." : "Guardar producto"}
          </button>
        </div>
        {error ? <p className="error-box">{error}</p> : null}
      </section>

      <section className="workspace-grid">
        <aside className="card product-library">
          <div className="card-head">
            <span>Productos disponibles</span>
            <span>{products.length}</span>
          </div>

          {products.length ? (
            <div className="product-list">
              {products.map((product) => {
                const isActive = product.productId === selectedProductId;
                return (
                  <button
                    key={product.productId}
                    type="button"
                    className={`product-item${isActive ? " is-active" : ""}`}
                    onClick={() => void loadProductWorkspace(product.productId)}
                  >
                    <div>
                      <strong>{product.productName}</strong>
                      <p>{product.brandName ?? product.storeName ?? "Sin marca detectada"}</p>
                    </div>
                    <div className="product-meta-grid">
                      <span>{getPromptPlanDescription(product.promptCount || STANDARD_PROMPT_COUNT)}</span>
                      <span>{product.runCount} corridas</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="empty-state">Todavia no hay productos guardados. Pega una URL arriba y guardala para empezar.</p>
          )}
        </aside>

        <section className="product-stage">
          {selectedProduct ? (
            <>
              <article className="card selected-product-card">
                <div className="card-head">
                  <span>Producto seleccionado</span>
                  <span>{selectedProduct.profile.domain}</span>
                </div>
                <div className="actions">
                  <button className="danger" onClick={handleDeleteProduct} disabled={hasPendingWork}>
                    Eliminar producto
                  </button>
                </div>
                <h2>{selectedProduct.profile.productName}</h2>
                <p className="subtitle">
                  {selectedProduct.profile.brandName ?? "Marca no detectada"} · {selectedProduct.profile.storeName ?? "Tienda no detectada"}
                </p>
                <div className="detail-grid">
                  <div className="detail-card">
                    <small>Categoria</small>
                    <p>{selectedProduct.profile.category ?? "No detectada"}</p>
                  </div>
                  <div className="detail-card detail-card-wide detail-card-canonical">
                    <small>Canonical</small>
                    <p>{selectedProduct.profile.canonicalUrl}</p>
                  </div>
                  <div className="detail-card">
                    <small>Ultima actualizacion</small>
                    <p>{formatDate(selectedProduct.updatedAt)}</p>
                  </div>
                </div>
              </article>

              <div className="stage-columns">
                <article className="card stage-card">
                  <div className="card-head">
                    <span>{getPromptPlanLabel(selectedPromptCount)}</span>
                    <span>{selectedProduct.promptBank?.prompts.length ?? 0} listos</span>
                  </div>
                  <p className="stage-copy">
                    {`Genera el banco una sola vez, se guarda fijo y no se modifica. Los productos nuevos usan ${STANDARD_PROMPT_COUNT} prompts y los bancos legacy de 50 se conservan tal cual.`}
                  </p>
                  <div className="actions">
                    <button onClick={handleGeneratePrompts} disabled={hasPendingWork || Boolean(selectedProduct.promptBank)}>
                      {loadingAction === "prompts" ? "Generando prompts..." : selectedProduct.promptBank ? `${getPromptPlanLabel(selectedPromptCount)} guardados` : `Generar ${STANDARD_PROMPT_COUNT} prompts`}
                    </button>
                    <button onClick={() => setShowPrompts((current) => !current)} disabled={!selectedProduct.promptBank}>
                      {showPrompts ? "Ocultar prompts" : `Ver ${selectedPromptCount} prompts`}
                    </button>
                  </div>

                  {showPrompts && selectedProduct.promptBank ? (
                    <div className="prompt-list prompt-list-long">
                      {selectedProduct.promptBank.prompts.map((prompt) => (
                        <div key={prompt.id} className="prompt-row prompt-row-rich">
                          <div className="prompt-badge">
                            <span>{prompt.id}</span>
                            <small>{prompt.type}</small>
                          </div>
                          <div className="prompt-content">
                            <p>{prompt.prompt}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>

                <article className="card stage-card">
                  <div className="card-head">
                    <span>Responder con IA</span>
                    <span>{activeRun ? `Run ${activeRun.runId.slice(0, 8)}` : "sin correr"}</span>
                  </div>
                  <p className="stage-copy">
                    Elegi que motor va a responder los prompts del producto seleccionado. Todas las corridas salen fijas para Argentina y quedan disponibles para revisar y descargar.
                  </p>

                  {lockedAuditTarget ? (
                    <p className="locked-audit-note">
                      IA bloqueada para este producto: <strong>{formatProviderLabel(lockedAuditTarget.provider)}</strong> · <strong>{lockedAuditTarget.model}</strong>
                    </p>
                  ) : (
                    <p className="locked-audit-note">
                      La primera corrida que hagas va a bloquear este producto a la IA elegida para mantener la comparacion antes/despues.
                    </p>
                  )}

                  <div className="control-grid">
                    <div className="field">
                      <label htmlFor="provider">IA auditada</label>
                      <select
                        id="provider"
                        value={auditedProvider}
                        onChange={(event) => setAuditedProvider(event.target.value as ProviderValue)}
                        disabled={Boolean(lockedAuditTarget)}
                      >
                        {providers.map((provider) => (
                          <option key={provider.value} value={provider.value}>
                            {formatProviderOptionLabel(provider.value, defaultModels)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="auditedModel">Modelo (slug)</label>
                      <input
                        id="auditedModel"
                        placeholder={defaultModels[auditedProvider] || (auditedProvider === "gemini" ? "se toma de .env" : "openai/gpt-4.1-mini")}
                        value={auditedModel}
                        onChange={(event) => setAuditedModel(event.target.value)}
                        disabled={Boolean(lockedAuditTarget) || auditedProvider === "gemini"}
                      />
                    </div>
                  </div>

                  <p className="stage-copy">
                    {auditedProvider === "gemini"
                      ? <>
                          Modelo configurado en <strong>.env</strong> para Gemini: <strong>{defaultModels.gemini || "(sin configurar)"}</strong>
                        </>
                      : <>
                          Modelo por defecto para {auditedProvider}: <strong>{defaultModels[auditedProvider] || "(sin configurar)"}</strong>
                        </>}
                  </p>

                  <div className="actions">
                    <button className="primary" onClick={() => void handleRunAudit()} disabled={hasPendingWork || !selectedProduct || !hasReadyPromptBank}>
                      {loadingAction === "run" ? `Ejecutando ${selectedPromptCount} prompts...` : `Responder ${selectedPromptCount} prompts`}
                    </button>
                    {activeRun?.resumable ? (
                      <button onClick={() => void handleRunAudit(activeRun.runId)} disabled={hasPendingWork || !selectedProduct || !hasReadyPromptBank}>
                        {loadingAction === "run" ? "Reanudando..." : `Reanudar corrida (${activeRun.completedPrompts ?? activeRun.results.length}/${inferPromptCount(activeRun.promptBank) || selectedPromptCount})`}
                      </button>
                    ) : null}
                    {activeRun ? (
                      <a className="download" href={`/api/runs/${activeRun.runId}/excel`}>
                        Descargar Excel
                      </a>
                    ) : null}
                  </div>

                  {activeRun?.status === "failed" ? (
                    <p className="error-box">
                      Corrida fallida en etapa <strong>{activeRun.errorStage ?? "unknown"}</strong>
                      {activeRun.failedPromptId ? ` · Prompt ${activeRun.failedPromptId}` : ""}
                      {activeRun.failedPromptText ? ` · ${activeRun.failedPromptText}` : ""}
                      {activeRun.errorMessage ? ` · ${activeRun.errorMessage}` : ""}
                    </p>
                  ) : null}

                  {!hasReadyPromptBank ? (
                    <p className="empty-state">
                      Antes de generar las respuestas, primero tenes que generar y guardar el banco de prompts de este producto.
                    </p>
                  ) : null}

                  {runProgress ? (
                    <div className="progress-card" aria-live="polite">
                      <div className="progress-meta">
                        <span>
                          Progreso: {runProgress.current}/{runProgress.total}
                        </span>
                        <strong>{Math.round((runProgress.current / Math.max(runProgress.total, 1)) * 100)}%</strong>
                      </div>
                      <div className="progress-bar">
                        <div
                          className="progress-bar-fill"
                          style={{ width: `${(runProgress.current / Math.max(runProgress.total, 1)) * 100}%` }}
                        />
                      </div>
                      <p className="progress-caption">
                        {loadingAction === "run"
                          ? runProgress.promptId
                            ? `Ultimo respondido: ${runProgress.promptId} · ${runProgress.promptText}`
                            : "Preparando corrida..."
                          : "Corrida completada."}
                      </p>
                    </div>
                  ) : null}

                  <div className="run-history">
                    <div className="card-head compact-head">
                      <span>Corridas del producto</span>
                      <span>{productRuns.length}</span>
                    </div>
                    {productRuns.length ? (
                      <div className="run-history-list">
                        {productRuns.map((run) => (
                          <button
                            key={run.runId}
                            type="button"
                            className={`run-pill${activeRun?.runId === run.runId ? " is-active" : ""}`}
                            onClick={() => void loadRun(run.runId)}
                          >
                            <strong>{formatProviderLabel(run.auditedProvider)}</strong>
                            <span>{formatDate(run.createdAt)}</span>
                            <span>{run.status}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-state">Todavia no hay corridas para este producto.</p>
                    )}
                  </div>
                </article>
              </div>

              {visibleResults.length ? (
                <section className="run-section">
                  {!showingLiveResults && activeRun ? (
                    <>
                      <div className="summary-strip">
                        {summaryCards.map((item) => (
                          <div key={item.label} className="summary-pill">
                            <span>{item.label}</span>
                            <strong>{item.value}</strong>
                          </div>
                        ))}
                      </div>
                      {activeRun.summary ? (
                        <p className="stage-copy">
                          {`Score breakdown: Hit ${activeRun.summary.scoreBreakdown.productHitPoints.toFixed(2)} · Rank ${activeRun.summary.scoreBreakdown.rankPoints.toFixed(2)} · URL ${activeRun.summary.scoreBreakdown.exactUrlPoints.toFixed(2)} · Vendor ${activeRun.summary.scoreBreakdown.vendorPoints.toFixed(2)} · Ext ${activeRun.summary.scoreBreakdown.externalPressurePoints.toFixed(2)} · Int ${activeRun.summary.scoreBreakdown.internalPressurePoints.toFixed(2)}`}
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  <article className="card run-table-card">
                    <div className="card-head">
                      <span>{showingLiveResults ? "Resultados en vivo" : "Resultados del producto"}</span>
                      <span>
                        {showingLiveResults
                          ? `${formatProviderLabel(auditedProvider)} · ${auditedModel || "modelo por defecto"}`
                          : `${formatProviderLabel(activeRun?.auditedProvider)} · ${activeRun?.auditedModel}`}
                      </span>
                    </div>

                    <div className="result-list">
                      {visibleResults.map((result) => (
                        <details key={result.promptId} className="result-item">
                          <summary>
                            <div className="result-headline">
                              <strong>{result.promptId}</strong>
                              <p>{result.promptText}</p>
                            </div>
                            <div className="metric-cluster">
                              <span>Hit {result.productHit}</span>
                              <span>Vendor {result.vendorHit}</span>
                              <span>URL {result.exactUrlAccuracy}</span>
                              <span>Int {result.internalAlternatives}</span>
                              <span>Ext {result.externalCompetitors}</span>
                              <span>Rank {result.rank}</span>
                            </div>
                          </summary>
                          <div className="result-body">
                            <div>
                              <small>Request ID</small>
                              <p>{result.requestId}</p>
                            </div>
                            <div>
                              <small>Evidencia</small>
                              <p>{result.evidenceSnippet ?? "Sin evidencia destacada"}</p>
                            </div>
                            <div>
                              <small>Motivos de scoring</small>
                              <p>{result.scoringReasons?.productHitReason ?? "Sin motivo de product hit"}</p>
                              <p>{result.scoringReasons?.rankReason ?? "Sin motivo de rank"}</p>
                              <p>{result.scoringReasons?.vendorHitReason ?? "Sin motivo de vendor hit"}</p>
                              <p>{result.scoringReasons?.exactUrlReason ?? "Sin motivo de URL"}</p>
                            </div>
                            <div>
                              <small>Clasificacion de alternativas</small>
                              <pre>
                                {result.alternativeClassifications?.length
                                  ? result.alternativeClassifications
                                      .map((item) => {
                                        const match = item.matchedSku ? ` · SKU ${item.matchedSku}` : "";
                                        const brand = item.matchedBrand ? ` · Marca ${item.matchedBrand}` : "";
                                        return `${item.mention} => ${item.classification} (${item.reason})${match}${brand}`;
                                      })
                                      .join("\n")
                                  : "Sin clasificaciones registradas"}
                              </pre>
                            </div>
                            <div>
                              <small>Respuesta cruda</small>
                              <pre>{result.rawResponse}</pre>
                            </div>
                            <div>
                              <small>URLs detectadas</small>
                              <p>{result.detectedUrls.length ? result.detectedUrls.join("\n") : "No se detectaron URLs"}</p>
                            </div>
                          </div>
                        </details>
                      ))}
                    </div>
                  </article>

                  <article className="card run-table-card">
                    <div className="card-head">
                      <span>Comparar corridas</span>
                      <span>{leftCompareRunId && rightCompareRunId ? "2 seleccionadas" : "sin seleccion"}</span>
                    </div>
                    <div className="control-grid">
                      <div className="field">
                        <label htmlFor="compareLeft">Corrida A (antes)</label>
                        <select id="compareLeft" value={leftCompareRunId} onChange={(event) => setLeftCompareRunId(event.target.value)}>
                          <option value="">Seleccionar run</option>
                          {productRuns.map((run) => (
                            <option key={`left-${run.runId}`} value={run.runId}>{`${run.runId.slice(0, 8)} · ${formatDate(run.createdAt)}`}</option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="compareRight">Corrida B (despues)</label>
                        <select id="compareRight" value={rightCompareRunId} onChange={(event) => setRightCompareRunId(event.target.value)}>
                          <option value="">Seleccionar run</option>
                          {productRuns.map((run) => (
                            <option key={`right-${run.runId}`} value={run.runId}>{`${run.runId.slice(0, 8)} · ${formatDate(run.createdAt)}`}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="actions">
                      <button onClick={() => void handleLoadComparison()} disabled={loadingComparison || !leftCompareRunId || !rightCompareRunId}>
                        {loadingComparison ? "Comparando..." : "Comparar"}
                      </button>
                    </div>
                    {comparisonSummary ? (
                      <>
                        {comparisonPromptPlanNote ? <p className="stage-copy">{comparisonPromptPlanNote}</p> : null}
                        <div className="summary-strip">
                          {comparisonSummary.map((item) => {
                            const delta = item.after - item.before;
                            const beforeLabel = item.percent ? `${Math.round(item.before * 100)}%` : item.before.toFixed(2);
                            const afterLabel = item.percent ? `${Math.round(item.after * 100)}%` : item.after.toFixed(2);
                            const deltaLabel = item.percent ? `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%` : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
                            return (
                              <div key={item.label} className="summary-pill">
                                <span>{item.label}</span>
                                <strong>{`${beforeLabel} -> ${afterLabel}`}</strong>
                                <small>{deltaLabel}</small>
                              </div>
                            );
                          })}
                        </div>
                        <p className="stage-copy">Prompts con cambios relevantes: {comparisonPromptDiffs.length}</p>
                        {comparisonPromptDiffs.length ? (
                          <div className="result-list">
                            {comparisonPromptDiffs.slice(0, 20).map((diff) => (
                              <div key={diff.promptId} className="result-item">
                                <div className="result-body">
                                  <div>
                                    <small>Prompt</small>
                                    <p>{diff.promptId}</p>
                                  </div>
                                  <div>
                                    <small>Product Hit</small>
                                    <p>{`${diff.before.productHit} -> ${diff.after.productHit}`}</p>
                                  </div>
                                  <div>
                                    <small>Rank</small>
                                    <p>{`${diff.before.rank} -> ${diff.after.rank}`}</p>
                                  </div>
                                  <div>
                                    <small>Int / Ext</small>
                                    <p>{`${diff.before.internalAlternatives}/${diff.before.externalCompetitors} -> ${diff.after.internalAlternatives}/${diff.after.externalCompetitors}`}</p>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="empty-state">Selecciona dos corridas y presiona comparar para ver diferencias.</p>
                    )}
                  </article>
                </section>
              ) : null}
            </>
          ) : (
            <article className="card empty-workspace">
              <div className="card-head">
                <span>Workspace de producto</span>
                <span>esperando seleccion</span>
              </div>
              <h2>Elegi un producto guardado para trabajar por etapas.</h2>
              <p>
                Cuando selecciones uno vas a poder generar su banco de prompts, elegir la IA que responde y revisar las corridas con su Excel correspondiente.
              </p>
            </article>
          )}
        </section>
      </section>

      <section className="card run-table-card">
        <div className="card-head">
          <span>Clasificacion de competidores por marca</span>
          <span>{catalogTotals.totalBrands} marcas</span>
        </div>
        <p className="stage-copy">
          Todo SKU del catalogo entra como interno por defecto. Desde aca podes mover marcas a externo cuando ya no se venden o cuando queres tratarlas como competencia directa.
        </p>
        <div className="actions">
          <button onClick={handleReclassifyHistory} disabled={reclassifyingHistory}>
            {reclassifyingHistory ? "Recalculando historico..." : "Aplicar cambios al historico"}
          </button>
          {reclassifyMessage ? <p className="stage-copy">{reclassifyMessage}</p> : null}
        </div>
        <div className="summary-strip">
          <div className="summary-pill">
            <span>Internas</span>
            <strong>{catalogTotals.internalBrands} marcas · {catalogTotals.internalSkus} SKUs</strong>
          </div>
          <div className="summary-pill">
            <span>Externas</span>
            <strong>{catalogTotals.externalBrands} marcas · {catalogTotals.externalSkus} SKUs</strong>
          </div>
        </div>

        {loadingBrandRules ? (
          <p className="empty-state">Cargando clasificacion de marcas...</p>
        ) : catalogBrandRules.length ? (
          <div className="result-list">
            {catalogBrandRules.map((item) => (
              <div key={item.brand} className="result-item">
                <div className="result-body">
                  <div>
                    <small>Marca</small>
                    <p>{item.brand}</p>
                  </div>
                  <div>
                    <small>SKUs en catalogo</small>
                    <p>{item.skuCount}</p>
                  </div>
                  <div>
                    <small>Tipo actual</small>
                    <p>{item.classification === "internal" ? "Interno" : "Externo"}</p>
                  </div>
                  <div>
                    <small>Definicion</small>
                    <select
                      value={item.classification}
                      disabled={savingBrand === item.brand}
                      onChange={(event) => void handleBrandClassificationChange(item.brand, event.target.value as "internal" | "external")}
                    >
                      <option value="internal">Interno</option>
                      <option value="external">Externo</option>
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No hay marcas cargadas en catalogo_products todavia.</p>
        )}
      </section>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function normalizeProvider(provider: string | null | undefined): string {
  if (provider === "openai" || provider === "gemini" || provider === "custom") {
    return provider;
  }
  return "custom";
}

function normalizeDisplayedModel(
  provider: string | null | undefined,
  model: string | null | undefined,
  defaults?: Partial<Record<ProviderValue, string>>,
): string {
  const trimmed = model?.trim() ?? "";
  if (normalizeProvider(provider) === "gemini") {
    return defaults?.gemini || trimmed;
  }
  return trimmed;
}

function formatProviderOptionLabel(provider: ProviderValue, defaults: Partial<Record<ProviderValue, string>>): string {
  const label = formatProviderLabel(provider);
  const model = defaults[provider]?.trim();
  if (!model || provider === "custom") {
    return label;
  }
  return `${label} - ${model}`;
}

function formatProviderLabel(provider: string | null | undefined): string {
  const normalized = normalizeProvider(provider);
  if (normalized === "openai") {
    return "OpenAI";
  }
  if (normalized === "gemini") {
    return "Gemini";
  }
  if (normalized === "custom") {
    return "Custom";
  }
  return normalized || "-";
}
