"use client";

import { useEffect, useMemo, useState } from "react";

import type { AuditRunResponse, ProductListItem } from "@/lib/types";

interface ComparisonItem {
  label: string;
  before: number;
  after: number;
  percent: boolean;
}

export function ProductImprovementsBoard() {
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingProductId, setSavingProductId] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<"select-all" | null>(null);
  const [loadingComparisonProductId, setLoadingComparisonProductId] = useState<string | null>(null);
  const [comparisonByProduct, setComparisonByProduct] = useState<Record<string, { summary: ComparisonItem[]; promptDiffs: number }>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProducts();
  }, []);

  const trackedProducts = useMemo(() => products.filter((product) => product.runCount > 0), [products]);

  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return trackedProducts;
    }

    return trackedProducts.filter((product) =>
      [product.productName, product.brandName, product.storeName, product.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [trackedProducts, search]);

  const metrics = useMemo(
    () => [
      { label: "Con primera corrida", value: trackedProducts.length },
      { label: "Mejorados por GEOModi", value: trackedProducts.filter((product) => product.descriptionImproved).length },
      { label: "Con segunda corrida", value: trackedProducts.filter((product) => Boolean(product.secondRunAt)).length },
    ],
    [trackedProducts],
  );
  const pendingVisibleProducts = useMemo(
    () => visibleProducts.filter((product) => !product.descriptionImproved),
    [visibleProducts],
  );

  async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });

    const raw = await response.text();
    const data = raw ? (JSON.parse(raw) as T & { error?: string }) : ({} as T & { error?: string });
    if (!response.ok) {
      throw new Error(data.error ?? "Request failed");
    }
    return data;
  }

  async function loadProducts() {
    setLoading(true);
    try {
      const data = await requestJson<ProductListItem[]>("/api/products", { method: "GET" });
      setProducts(data);
      setError(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo cargar la lista de productos");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(product: ProductListItem, nextValue: boolean) {
    setSavingProductId(product.productId);
    setError(null);
    try {
      await requestJson(`/api/products/${product.productId}`, {
        method: "PATCH",
        body: JSON.stringify({ descriptionImproved: nextValue }),
      });
      await loadProducts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo guardar la mejora del producto");
    } finally {
      setSavingProductId(null);
    }
  }

  async function handleSelectAllVisible() {
    if (!pendingVisibleProducts.length) {
      return;
    }

    setBulkAction("select-all");
    setError(null);
    try {
      for (const product of pendingVisibleProducts) {
        await requestJson(`/api/products/${product.productId}`, {
          method: "PATCH",
          body: JSON.stringify({ descriptionImproved: true }),
        });
      }
      await loadProducts();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo marcar la seleccion completa");
    } finally {
      setBulkAction(null);
    }
  }

  async function ensureComparisonLoaded(product: ProductListItem) {
    if (comparisonByProduct[product.productId] || !product.firstRunId || !product.secondRunId) {
      return;
    }

    setLoadingComparisonProductId(product.productId);
    setError(null);
    try {
      const [beforeRun, afterRun] = await Promise.all([
        requestJson<AuditRunResponse>(`/api/runs/${product.firstRunId}`, { method: "GET" }),
        requestJson<AuditRunResponse>(`/api/runs/${product.secondRunId}`, { method: "GET" }),
      ]);
      const summary = buildComparisonSummary(beforeRun, afterRun);
      const promptDiffs = countPromptDiffs(beforeRun, afterRun);
      setComparisonByProduct((current) => ({
        ...current,
        [product.productId]: { summary, promptDiffs },
      }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "No se pudo cargar la comparacion de score");
    } finally {
      setLoadingComparisonProductId(null);
    }
  }

  useEffect(() => {
    const candidates = visibleProducts.filter(
      (product) => product.firstRunId && product.secondRunId && !comparisonByProduct[product.productId],
    );

    if (!candidates.length || loadingComparisonProductId) {
      return;
    }

    void ensureComparisonLoaded(candidates[0]);
  }, [visibleProducts, comparisonByProduct, loadingComparisonProductId]);

  return (
    <section className="run-section">
      <div className="summary-strip">
        {metrics.map((item) => (
          <div key={item.label} className="summary-pill">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      <section className="card improvements-card">
        <div className="card-head">
          <span>Seguimiento de productos mejorados</span>
          <span>{visibleProducts.length} visibles</span>
        </div>

        <p className="stage-copy">
          Aca solo aparecen productos que ya tuvieron al menos una corrida. El primer y tercer checkbox se completan con la
          fecha real de la primera y segunda corrida; el del medio lo marcas manualmente cuando la descripcion fue mejorada por GEOModi.
        </p>

        <div className="field full">
          <label htmlFor="improvementSearch">Buscar producto</label>
          <input
            id="improvementSearch"
            type="search"
            placeholder="Filtrar por producto, marca, tienda o categoria"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="actions">
          <button onClick={() => void handleSelectAllVisible()} disabled={loading || savingProductId !== null || bulkAction !== null || !pendingVisibleProducts.length}>
            {bulkAction === "select-all" ? "Marcando visibles..." : `Seleccionar todo visible (${pendingVisibleProducts.length})`}
          </button>
          <a className="download" href="/api/improvements/excel">
            Descargar Excel antes/despues
          </a>
        </div>

        <p className="stage-copy">
          El Excel descarga un resumen unificado con todos los productos visibles en el sector de mejoras, incluyendo
          producto, puntaje total antes, puntaje total despues y diferencia.
        </p>

        {error ? <p className="error-box">{error}</p> : null}

        {loading ? (
          <p className="empty-state">Cargando productos...</p>
        ) : visibleProducts.length ? (
          <div className="improvement-list">
            {visibleProducts.map((product) => {
              const meta = [product.brandName, product.storeName, product.category].filter(Boolean).join(" · ");
              const saving = savingProductId === product.productId || bulkAction !== null;
              return (
                <article key={product.productId} className={`improvement-row${product.descriptionImproved ? " is-improved" : ""}`}>
                  <div className="improvement-content">
                    <div className="improvement-head">
                      <strong>{product.productName}</strong>
                      <span className={`status-chip${product.descriptionImproved ? " is-on" : ""}`}>
                        {product.descriptionImproved ? "GEOModi aplicado" : "esperando mejora"}
                      </span>
                    </div>
                    <p>{meta || "Sin marca, tienda ni categoria cargadas"}</p>
                    <div className="product-meta-grid">
                      <span>{product.runCount} corridas</span>
                      <span>{product.promptCount} prompts</span>
                      <span>{product.latestRunId ? `Ultima corrida vinculada` : "Sin ultima corrida"}</span>
                    </div>
                  </div>

                  <div className="checkpoint-grid">
                    <CheckpointCard
                      title="Primera corrida"
                      checked={Boolean(product.firstRunAt)}
                      timestamp={product.firstRunAt}
                      helper="Se completa automaticamente con la primera corrida registrada."
                      disabled
                    />
                    <CheckpointCard
                      title="Descripcion mejorada por GEOModi"
                      checked={product.descriptionImproved}
                      timestamp={product.descriptionImprovedAt}
                      helper={saving ? "Guardando cambio..." : "Marca manual para identificar productos optimizados."}
                      disabled={saving}
                      onChange={(nextValue) => void handleToggle(product, nextValue)}
                    />
                    <CheckpointCard
                      title="Segunda corrida"
                      checked={Boolean(product.secondRunAt)}
                      timestamp={product.secondRunAt}
                      helper="Se completa automaticamente cuando existe una corrida completed con 50 prompts respondidos."
                      disabled
                    />
                  </div>

                  <div className="comparison-panel">
                    <div className="comparison-panel-head">
                      <div>
                        <strong>Impacto de score</strong>
                        <p>
                          {product.secondRunAt
                            ? "Compara la primera corrida guardada contra la segunda corrida valida."
                            : "Todavia no hay segunda corrida valida para comparar."}
                        </p>
                      </div>
                    </div>

                    {loadingComparisonProductId === product.productId ? (
                      <p className="empty-state">Cargando comparacion de score...</p>
                    ) : comparisonByProduct[product.productId] ? (
                      <>
                        <p className="checkpoint-helper">
                          {`Primera corrida: ${product.firstRunAt ? formatDateTime(product.firstRunAt) : "sin fecha"} · Segunda corrida: ${product.secondRunAt ? formatDateTime(product.secondRunAt) : "sin fecha"}`}
                        </p>
                        <div className="summary-strip comparison-strip">
                          {comparisonByProduct[product.productId].summary.map((item) => {
                            const delta = item.after - item.before;
                            const beforeLabel = item.percent ? `${Math.round(item.before * 100)}%` : item.before.toFixed(2);
                            const afterLabel = item.percent ? `${Math.round(item.after * 100)}%` : item.after.toFixed(2);
                            const deltaLabel = item.percent ? `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%` : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
                            return (
                              <div key={`${product.productId}-${item.label}`} className="summary-pill comparison-pill compact-pill">
                                <span>{item.label}</span>
                                <strong>{`${beforeLabel} -> ${afterLabel}`}</strong>
                                <small className={comparisonDeltaClass(delta)}>{deltaLabel}</small>
                              </div>
                            );
                          })}
                        </div>
                        <p className="checkpoint-helper">
                          Prompts con cambios relevantes: {comparisonByProduct[product.productId].promptDiffs}
                        </p>
                      </>
                    ) : product.firstRunId && product.secondRunId ? (
                      <p className="empty-state">Preparando comparacion de score...</p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="empty-state">No hay productos con corridas para mostrar en este sector.</p>
        )}
      </section>
    </section>
  );
}

function buildComparisonSummary(beforeRun: AuditRunResponse, afterRun: AuditRunResponse): ComparisonItem[] {
  if (!beforeRun.summary || !afterRun.summary) {
    return [];
  }

  const before = beforeRun.summary;
  const after = afterRun.summary;
  return [
    { label: "Overall Score", before: before.overallScore, after: after.overallScore, percent: false },
    { label: "Product Hit", before: before.productHitRate, after: after.productHitRate, percent: true },
    { label: "Vendor Hit", before: before.vendorHitRate, after: after.vendorHitRate, percent: true },
    { label: "Exact URL", before: before.exactUrlAccuracyRate, after: after.exactUrlAccuracyRate, percent: true },
    { label: "Internal Bonus Base", before: before.averageInternalAlternatives, after: after.averageInternalAlternatives, percent: false },
    { label: "External Penalty Base", before: before.averageExternalCompetitors, after: after.averageExternalCompetitors, percent: false },
    { label: "Avg Rank", before: before.averageRankWhenPresent, after: after.averageRankWhenPresent, percent: false },
  ];
}

function countPromptDiffs(beforeRun: AuditRunResponse, afterRun: AuditRunResponse): number {
  const beforeByPrompt = new Map(beforeRun.results.map((result) => [result.promptId, result]));
  const afterByPrompt = new Map(afterRun.results.map((result) => [result.promptId, result]));
  let total = 0;

  for (const [promptId, before] of beforeByPrompt.entries()) {
    const after = afterByPrompt.get(promptId);
    if (!after) {
      continue;
    }
    if (
      before.productHit !== after.productHit ||
      before.rank !== after.rank ||
      before.internalAlternatives !== after.internalAlternatives ||
      before.externalCompetitors !== after.externalCompetitors
    ) {
      total += 1;
    }
  }

  return total;
}

function comparisonDeltaClass(delta: number): string {
  if (delta > 0) {
    return "comparison-delta is-positive";
  }
  if (delta < 0) {
    return "comparison-delta is-negative";
  }
  return "comparison-delta is-neutral";
}

function CheckpointCard({
  title,
  checked,
  timestamp,
  helper,
  disabled = false,
  onChange,
}: {
  title: string;
  checked: boolean;
  timestamp?: string | null;
  helper: string;
  disabled?: boolean;
  onChange?: (nextValue: boolean) => void;
}) {
  return (
    <div className={`checkpoint-card${checked ? " is-checked" : ""}${disabled ? " is-disabled" : ""}`}>
      <label className="improvement-toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        />
        <span>{title}</span>
      </label>
      <p className="checkpoint-meta">{timestamp ? formatDateTime(timestamp) : "Sin marcar todavia"}</p>
      <p className="checkpoint-helper">{helper}</p>
    </div>
  );
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
