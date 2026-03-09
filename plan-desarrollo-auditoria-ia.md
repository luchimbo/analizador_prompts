# Plan de Desarrollo - Auditoria de Presencia de Producto/Marca en IA

## 1. Objetivo

Construir un sistema que permita:

1. Ingresar una `URL de producto`
2. Extraer automaticamente los datos clave del producto
3. Generar `50 prompts` relevantes
4. Ejecutar esos `50 prompts` contra una IA objetivo
5. Analizar las `50 respuestas` con otra IA independiente
6. Exportar un `Excel` con metricas de posicionamiento y precision comercial

El objetivo es medir si una IA:

- recomienda el producto evaluado
- menciona la tienda o marca correcta para comprarlo
- entrega la URL exacta del producto
- recomienda competidores
- posiciona al producto en una determinada posicion dentro de su lista

## 2. Alcance del MVP

### Incluye
- modo `producto` unicamente
- entrada por `1 URL` por corrida
- generacion automatica de `50 prompts`
- ejecucion sobre `1 modelo auditado` por vez
- analisis automatico de respuestas
- exportacion a `Excel`

### No incluye en la version 1
- analisis masivo de multiples URLs en paralelo
- modo `marca` separado
- dashboard avanzado
- comparacion simultanea entre multiples modelos
- scoring historico por fecha

## 3. Enfoque metodologico

Para evitar contaminacion entre etapas, el flujo se separa en tres roles:

### Modelo A - Generador
Se usa para generar los `50 prompts`.

### Modelo B - Auditado
Se usa para responder los `50 prompts`.
Este es el modelo que se quiere medir.

### Modelo C - Juez
Se usa para analizar las respuestas del Modelo B y devolver metricas estructuradas.

### Configuracion obligatoria del Modelo B
- `1 prompt = 1 request nuevo`
- sin historial
- sin memoria compartida
- `temperature=0`
- `top_p=1`
- mismo idioma
- misma geografia
- misma configuracion de busqueda/web en toda la corrida

## 4. Configuracion inicial recomendada

### Fase inicial
- `Modelo A`: `Gemini 2.5 Flash` via `OpenRouter`
- `Modelo B`: `OpenAI` via `OpenRouter`
- `Modelo C`: `Kimi` via `OpenRouter`

### Fase siguiente
- mantener igual el paso 1 y 3
- cambiar solo el `Modelo B` por `Gemini` via `OpenRouter`

Esto permite comparar resultados sin cambiar prompts ni criterio de analisis.

## 5. Flujo funcional

### Paso 1 - Ingreso
El usuario pega una `URL de producto`.

### Paso 2 - Extraccion de datos
El sistema lee la ficha del producto y extrae:

- `product_name`
- `brand_name`
- `store_name`
- `canonical_url`
- `category`
- `aliases` si aplica

Tambien debe permitir correcciones manuales opcionales por si la ficha viene mal.

### Paso 3 - Generacion de prompts
El sistema genera `50 prompts` variados y no duplicados.

Distribucion sugerida:
- `20` prompts de problema/necesidad
- `10` prompts de descubrimiento de categoria
- `10` prompts comparativos
- `5` prompts transaccionales
- `5` prompts branded

### Paso 4 - Ejecucion
Cada prompt se envia al `Modelo B` en una sesion nueva.

Se guarda por cada ejecucion:
- prompt
- respuesta cruda
- links detectados
- timestamp
- modelo
- version
- estado
- latencia

### Paso 5 - Analisis
El `Modelo C` analiza cada respuesta y devuelve metricas estructuradas.

### Paso 6 - Exportacion
Se genera un `Excel` con una fila por prompt y una hoja de resumen.

## 6. Metricas a extraer

### `Product_Hit`
- `1` si la IA recomendo el producto exacto evaluado
- `0` si no lo recomendo

### `Vendor_Hit`
- `1` si, al recomendar el producto, menciona explicitamente la tienda o marca objetivo como lugar de compra
- `0` si no la menciona

### `Exact_URL_Accuracy`
- `1` si entrega la URL exacta y funcional del producto
- `0` si entrega home, categoria, busqueda interna, URL generica o enlace roto

### `Product_Competitors`
- numero entero con la cantidad de productos competidores recomendados en la misma respuesta

### `Rank`
- posicion en la lista en la que aparece el producto evaluado
- `0` si no aparece

## 7. Reglas de analisis

### Reglas para evitar falsos positivos
- `Product_Hit` no se activa si el producto solo es mencionado de pasada
- `Vendor_Hit` no implica automaticamente `Exact_URL_Accuracy`
- `Rank` solo cuenta si hay recomendacion positiva
- `Exact_URL_Accuracy` debe validarse contra una URL exacta esperada
- redirects validos al mismo producto pueden contarse como correctos
- links a home o categoria cuentan como incorrectos

### Enfoque recomendado
Usar analisis hibrido:

- `LLM` para:
  - `Product_Hit`
  - `Product_Competitors`
  - `Rank`

- reglas duras para:
  - `Vendor_Hit`
  - `Exact_URL_Accuracy`

## 8. Estructura del Excel

### Hoja 1 - Detalle por prompt
Columnas minimas:

- `Prompt_ID`
- `Prompt`
- `Raw_Response`
- `Product_Hit`
- `Vendor_Hit`
- `Exact_URL_Accuracy`
- `Product_Competitors`
- `Rank`

Columnas recomendadas:
- `Detected_URL`
- `Evidence_Snippet`
- `Model_Audited`
- `Timestamp`

### Hoja 2 - Resumen
Indicadores:

- `% Product_Hit`
- `% Vendor_Hit`
- `% Exact_URL_Accuracy`
- promedio de `Product_Competitors`
- promedio de `Rank` cuando hay hit
- total de prompts evaluados

## 9. Modulos del sistema

### Modulo 1 - Perfilador de producto
Responsable de leer la URL y construir la identidad del producto.

### Modulo 2 - Generador de prompts
Responsable de crear los `50 prompts` balanceados.

### Modulo 3 - Runner de ejecucion
Responsable de consultar al modelo auditado `50 veces` en sesiones aisladas.

### Modulo 4 - Juez
Responsable de clasificar cada respuesta y devolver metricas estructuradas.

### Modulo 5 - Exportador
Responsable de generar el archivo `Excel`.

## 10. Stack tecnico sugerido

- `Next.js` App Router
- `TypeScript`
- `OpenRouter` para generador, auditor y juez
- `JSON` file storage para MVP
- `xlsx` para Excel
- `cheerio` + parsing de `JSON-LD` para extraer datos de la URL

## 11. Backlog de desarrollo

### Fase 1 - Extraccion y perfilado
- recibir una URL
- parsear HTML
- extraer nombre, marca, canonical y categoria
- detectar aliases basicos
- permitir overrides manuales

### Fase 2 - Generacion de prompts
- disenar prompt maestro del generador
- producir 50 prompts
- validar duplicados
- controlar balance entre branded y unbranded

### Fase 3 - Ejecucion contra IA auditada
- enviar 50 prompts al modelo objetivo
- crear sesiones totalmente nuevas por prompt
- guardar respuestas crudas
- registrar errores, latencia y timestamps

### Fase 4 - Analisis de respuestas
- disenar prompt maestro del juez
- implementar parsing estructurado
- aplicar reglas duras para links y vendor
- reintentar si el JSON sale invalido

### Fase 5 - Reporte final
- armar DataFrame final
- exportar a Excel
- generar hoja de detalle
- generar hoja de resumen

### Fase 6 - Comparacion entre modelos
- mantener mismos prompts
- mantener mismo juez
- reemplazar solo el modelo auditado
- comparar `OpenAI` vs `Gemini`

## 12. Criterios de aceptacion

El MVP se considera listo cuando:

- una URL valida produce un perfil de producto usable
- el sistema genera exactamente `50 prompts`
- no hay prompts duplicados
- se ejecutan `50 respuestas` en sesiones aisladas
- cada respuesta se analiza y produce los `5 campos`
- se genera un `Excel` descargable
- se puede repetir el proceso con otro modelo manteniendo la misma base

## 13. Riesgos y mitigaciones

### Riesgo 1 - Ficha de producto pobre o ambigua
**Mitigacion:** permitir correccion manual de nombre, marca, tienda y URL objetivo.

### Riesgo 2 - Exceso de prompts branded
**Mitigacion:** imponer proporcion fija y priorizar prompts unbranded.

### Riesgo 3 - Comparacion injusta entre modelos
**Mitigacion:** mantener misma configuracion, mismo lote de prompts y mismo juez.

### Riesgo 4 - Validacion erronea de URLs
**Mitigacion:** normalizar trailing slash, parametros y redirects validos.

### Riesgo 5 - Sesgo del juez
**Mitigacion:** usar un modelo distinto del auditado y combinarlo con reglas deterministicas.

## 14. Cronograma sugerido

### Semana 1
- extraccion desde URL
- perfilado del producto
- overrides manuales

### Semana 2
- generacion de 50 prompts
- validacion y limpieza del prompt set

### Semana 3
- ejecucion con `OpenAI`
- almacenamiento de respuestas crudas

### Semana 4
- analisis automatico
- exportacion a Excel
- QA del flujo completo

### Semana 5
- integracion de `Gemini`
- comparacion usando el mismo prompt bank

## 15. Proximo paso recomendado

El siguiente paso de desarrollo deberia ser:

1. definir el formato exacto del `input` a partir de la URL
2. redactar el `Prompt Maestro` del generador de 50 prompts
3. redactar el `Prompt Maestro` del juez con salida JSON estricta
