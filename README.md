# IA Product Audit MVP

Version `Next.js` full-stack para auditar la presencia de un producto dentro de respuestas de IA a partir de una sola URL, fijando el experimento solo al mercado argentino.

## Que hace

- Guarda productos a partir de una `URL`.
- Muestra una biblioteca de productos disponibles para elegir.
- Genera un banco de `50 prompts` por producto.
- Permite editar cada prompt individualmente despues de generado.
- Ejecuta esos prompts contra un modelo auditado elegido via `OpenRouter` (`OpenAI`, `Gemini` u otro slug compatible en modo `custom`).
- Muestra el progreso de la corrida mientras la IA va respondiendo los 50 prompts.
- Genera y guarda un `request_id` unico por prompt para auditar que cada llamada salga aislada.
- Juzga cada respuesta con otro modelo independiente.
- Permite revisar corridas historicas y exportar un `Excel` por run.
- El mercado queda bloqueado a `Argentina` y el idioma de trabajo a `es` para no mezclar paises en la medicion.
- El producto queda bloqueado a la primera IA usada para mantener comparables los antes/despues.
- Las alternativas se desdoblan en `Internal_Alternatives` y `External_Competitors`.

## Stack

- `Next.js` App Router
- `React`
- `TypeScript`
- `Turso / libSQL` para persistencia
- `OpenRouter` para generador, auditor y juez
- `cheerio` para extraer datos de la URL
- `xlsx` para exportacion

## Instalacion

```bash
npm install
copy .env.example .env
```

Completa la credencial de `OPENROUTER_API_KEY` en `.env`.

Si ya tenes Turso, agrega:

```bash
TURSO_DATABASE_URL=libsql://tu-db.turso.io
TURSO_AUTH_TOKEN=tu-token
```

Si no los definis, el proyecto usa `file:./data/ia-product-audit.db` como base local compatible con `libSQL`.

## Ejecutar

```bash
npm run dev
```

La app queda disponible en `http://127.0.0.1:3002`.

## Flujo recomendado

1. Abrir la home y pegar una `URL` de producto.
2. Usar `Guardar producto` para sumarlo a la biblioteca argentina.
3. Elegir uno de los productos disponibles en la columna izquierda.
4. Generar o revisar sus `50 prompts`.
5. Elegir que IA responde los prompts y correr la auditoria.
6. Revisar la corrida y descargar el Excel desde la UI o desde `/api/runs/{run_id}/excel`.

## Endpoints

- `GET /api/health`
- `GET /api/products`
- `POST /api/products`
- `GET /api/products/{product_id}`
- `POST /api/products/{product_id}/prompts`
- `GET /api/products/{product_id}/runs`
- `POST /api/products/{product_id}/runs`
- `POST /api/products/{product_id}/runs/stream`
- `POST /api/profile`
- `POST /api/prompts`
- `GET /api/runs`
- `POST /api/runs`
- `GET /api/runs/{run_id}`
- `GET /api/runs/{run_id}/excel`

## Variables importantes

- `OPENROUTER_API_KEY`: necesaria para generar prompts, ejecutar la auditoria y usar el juez LLM.
- `OPENROUTER_OPENAI_AUDIT_MODEL`: slug por defecto para auditar OpenAI via OpenRouter.
- `OPENROUTER_GEMINI_AUDIT_MODEL`: slug por defecto para auditar Gemini via OpenRouter.
- `OPENROUTER_WEB_PLUGIN_ID`: plugin de web search que se adjunta cuando `enableWebSearch=true`.
- `TURSO_DATABASE_URL`: URL de Turso/libSQL. Para local, el default es `file:./data/ia-product-audit.db`.
- `TURSO_AUTH_TOKEN`: token de Turso. No hace falta para el modo local `file:`.
- `VERIFY_DETECTED_URLS`: si esta en `true`, intenta resolver redirects al validar URLs.
- `REQUEST_TIMEOUT_SECONDS`: timeout maximo para cada request a OpenRouter.
- `URL_RESOLVE_TIMEOUT_SECONDS`: timeout maximo por URL cuando se valida `Exact_URL_Accuracy`.
- `MAX_VERIFIED_URLS_PER_PROMPT`: limite de URLs a verificar por prompt cuando `VERIFY_DETECTED_URLS=true`.
- `RUN_CONCURRENCY`: concurrencia general del run.

## Importar catalogo PC MIDI

Para clasificar alternativas internas vs externas, importa el Excel de catalogo a la tabla `catalog_products`:

```bash
npm run import:catalog -- "_tmp_Productos_1788_20260305 (1).xlsx"
```
- `DEFAULT_MARKET`: dejarlo en `Argentina` para mantener el experimento fijo al mismo pais.

## Notas del MVP

- El pipeline corre de forma sincronica desde un route handler de Next.
- Cada prompt se envia en una sesion nueva.
- Los resultados se persisten en `Turso/libSQL` y se pueden reconstruir desde la base.
- La UI muestra progreso y resultados a medida que termina cada prompt.
- El juez usa un enfoque hibrido: reglas duras para `Vendor_Hit` y `Exact_URL_Accuracy`, y LLM para `Product_Hit`, `Product_Competitors` y `Rank`.
- El Excel se genera on demand al descargarlo.
- La app ignora cualquier mercado enviado por request y fuerza todas las corridas a `Argentina`.

## Estructura

```text
src/
  app/
    api/
  components/
  lib/
plan-desarrollo-auditoria-ia.md
```

## Verificacion rapida

```bash
npm run typecheck
npm run build
```

## Nota sobre el backend anterior

El backend Python anterior sigue presente en `app/` como referencia, pero la version activa del proyecto ahora es la implementacion en `Next.js` dentro de `src/`.
