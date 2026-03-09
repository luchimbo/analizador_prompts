"use client";

import { useEffect, useMemo, useState } from "react";

import type { AuditRunResponse, ProductListItem, ProductRunRequest, PromptAuditResult, RunListItem, RunProgressEvent, SavedProduct } from "@/lib/types";

const providers = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "kimi", label: "Kimi" },
] as const;

type ProviderValue = (typeof providers)[number]["value"];
type LoadingAction = "boot" | "add-product" | "select-product" | "prompts" | "run" | "run-detail" | null;

const LOCKED_LANGUAGE = "es";
const LOCKED_MARKET = "Argentina";

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
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [savingPromptId, setSavingPromptId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<{ current: number; total: number; promptId?: string; promptText?: string } | null>(null);
  const [streamedResults, setStreamedResults] = useState<PromptAuditResult[]>([]);

  const hasPendingWork = loadingAction !== null || Boolean(savingPromptId);
  const showingLiveResults = loadingAction === "run" || streamedResults.length > 0;
  const visibleResults = showingLiveResults ? streamedResults : activeRun?.results ?? [];

  useEffect(() => {
    void loadProducts();
  }, []);

  const summaryCards = useMemo(() => {
    if (!activeRun?.summary) {
      return [];
    }

    return [
      { label: "Product Hit", value: `${Math.round(activeRun.summary.productHitRate * 100)}%` },
      { label: "Vendor Hit", value: `${Math.round(activeRun.summary.vendorHitRate * 100)}%` },
      { label: "URL Accuracy", value: `${Math.round(activeRun.summary.exactUrlAccuracyRate * 100)}%` },
      { label: "Avg Competitors", value: activeRun.summary.averageCompetitors.toFixed(2) },
      { label: "Avg Rank", value: activeRun.summary.averageRankWhenPresent.toFixed(2) },
    ];
  }, [activeRun]);

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
        setEditingPromptId(null);
        setPromptDraft("");
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
      setShowPrompts(Boolean(product.promptBank));
      setProductRuns(runs);
      setEditingPromptId(null);
      setPromptDraft("");
      setRunProgress(null);
      setStreamedResults([]);

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
      setEditingPromptId(null);
      setPromptDraft("");
      await refreshProductsList(selectedProductId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudieron generar los prompts");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleRunAudit() {
    if (!selectedProductId) {
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
      };
      setStreamedResults([]);
      setActiveRun(null);
      setRunProgress({ current: 0, total: selectedProduct?.promptBank?.prompts.length ?? 50 });
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
            setRunProgress({ current: event.current ?? 0, total: event.total ?? 50 });
            setStreamedResults([]);
          }
          if (event.type === "progress") {
            setRunProgress({
              current: event.current ?? 0,
              total: event.total ?? 50,
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

  function startEditingPrompt(promptId: string, prompt: string) {
    setEditingPromptId(promptId);
    setPromptDraft(prompt);
  }

  function cancelPromptEdit() {
    setEditingPromptId(null);
    setPromptDraft("");
  }

  async function handleSavePrompt(promptId: string) {
    if (!selectedProductId) {
      return;
    }

    setSavingPromptId(promptId);
    setError(null);

    try {
      const product = await requestJson<SavedProduct>(`/api/products/${selectedProductId}/prompts`, {
        method: "PATCH",
        body: JSON.stringify({ promptId, prompt: promptDraft }),
      });
      setSelectedProduct(product);
      setEditingPromptId(null);
      setPromptDraft("");
      await refreshProductsList(selectedProductId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo guardar el prompt");
    } finally {
      setSavingPromptId(null);
    }
  }

  return (
    <div className="shell">
      <section className="hero hero-product-first">
        <div className="hero-copy">
          <span className="eyebrow">GEO Product Audit</span>
          <h1>Primero elegis el producto. Despues ves prompts, respuestas y Excel.</h1>
          <p>
            La interfaz ahora trabaja como una biblioteca de productos para el mercado argentino: agregas URLs, elegis una ficha guardada, generas sus 50 prompts, elegis que IA la responda y revisas la corrida completa desde el mismo lugar.
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
                      <span>{product.promptCount}/50 prompts</span>
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
                <h2>{selectedProduct.profile.productName}</h2>
                <p className="subtitle">
                  {selectedProduct.profile.brandName ?? "Marca no detectada"} · {selectedProduct.profile.storeName ?? "Tienda no detectada"}
                </p>
                <div className="detail-grid">
                  <div>
                    <small>Categoria</small>
                    <p>{selectedProduct.profile.category ?? "No detectada"}</p>
                  </div>
                  <div>
                    <small>Canonical</small>
                    <p>{selectedProduct.profile.canonicalUrl}</p>
                  </div>
                  <div>
                    <small>Ultima actualizacion</small>
                    <p>{formatDate(selectedProduct.updatedAt)}</p>
                  </div>
                </div>
              </article>

              <div className="stage-columns">
                <article className="card stage-card">
                  <div className="card-head">
                    <span>50 prompts</span>
                    <span>{selectedProduct.promptBank?.prompts.length ?? 0} listos</span>
                  </div>
                  <p className="stage-copy">
                    Genera el banco del producto, desplegalo y revisa exactamente que 50 consultas se van a usar antes de correr la auditoria.
                  </p>
                  <div className="actions">
                    <button onClick={handleGeneratePrompts} disabled={hasPendingWork}>
                      {loadingAction === "prompts" ? "Generando prompts..." : selectedProduct.promptBank ? "Regenerar prompts" : "Generar 50 prompts"}
                    </button>
                    <button onClick={() => setShowPrompts((current) => !current)} disabled={!selectedProduct.promptBank || Boolean(savingPromptId)}>
                      {showPrompts ? "Ocultar prompts" : "Ver 50 prompts"}
                    </button>
                  </div>

                  {showPrompts && selectedProduct.promptBank ? (
                    <div className="prompt-list prompt-list-long">
                      {selectedProduct.promptBank.prompts.map((prompt) => (
                        <div key={prompt.id} className={`prompt-row prompt-row-rich${editingPromptId === prompt.id ? " is-editing" : ""}`}>
                          <div className="prompt-badge">
                            <span>{prompt.id}</span>
                            <small>{prompt.type}</small>
                          </div>
                          <div className="prompt-content">
                            {editingPromptId === prompt.id ? (
                              <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} rows={4} />
                            ) : (
                              <p>{prompt.prompt}</p>
                            )}
                          </div>
                          <div className="prompt-actions">
                            {editingPromptId === prompt.id ? (
                              <>
                                <button onClick={() => void handleSavePrompt(prompt.id)} disabled={Boolean(savingPromptId)}>
                                  {savingPromptId === prompt.id ? "Guardando..." : "Guardar"}
                                </button>
                                <button onClick={cancelPromptEdit} disabled={Boolean(savingPromptId)}>
                                  Cancelar
                                </button>
                              </>
                            ) : (
                              <button onClick={() => startEditingPrompt(prompt.id, prompt.prompt)} disabled={hasPendingWork}>
                                Editar
                              </button>
                            )}
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
                    Elegi que motor va a responder los 50 prompts del producto seleccionado. Todas las corridas salen fijas para Argentina y quedan disponibles para revisar y descargar.
                  </p>

                  <div className="control-grid">
                    <div className="field">
                      <label htmlFor="provider">IA auditada</label>
                      <select id="provider" value={auditedProvider} onChange={(event) => setAuditedProvider(event.target.value as ProviderValue)}>
                        {providers.map((provider) => (
                          <option key={provider.value} value={provider.value}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="auditedModel">Slug opcional</label>
                      <input
                        id="auditedModel"
                        placeholder="openai/gpt-4.1-mini"
                        value={auditedModel}
                        onChange={(event) => setAuditedModel(event.target.value)}
                      />
                    </div>
                  </div>

                  <div className="actions">
                    <button className="primary" onClick={handleRunAudit} disabled={hasPendingWork || !selectedProduct}>
                      {loadingAction === "run" ? "Ejecutando los 50 prompts..." : "Responder 50 prompts"}
                    </button>
                    {activeRun ? (
                      <a className="download" href={`/api/runs/${activeRun.runId}/excel`}>
                        Descargar Excel
                      </a>
                    ) : null}
                  </div>

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
                            <strong>{run.auditedProvider}</strong>
                            <span>{formatDate(run.createdAt)}</span>
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
                    <div className="summary-strip">
                      {summaryCards.map((item) => (
                        <div key={item.label} className="summary-pill">
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <article className="card run-table-card">
                    <div className="card-head">
                      <span>{showingLiveResults ? "Resultados en vivo" : "Resultados del producto"}</span>
                      <span>
                        {showingLiveResults ? `${auditedProvider} · ${auditedModel || "modelo por defecto"}` : `${activeRun?.auditedProvider} · ${activeRun?.auditedModel}`}
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
                              <span>Comp {result.productCompetitors}</span>
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
                Cuando selecciones uno vas a poder generar sus 50 prompts, elegir la IA que responde y revisar las corridas con su Excel correspondiente.
              </p>
            </article>
          )}
        </section>
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
