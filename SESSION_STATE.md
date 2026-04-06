# SESSION_STATE.md

## 1. Proyecto

**Nombre:** CRYPTEX Dashboard  
**Descripción corta del sistema:** Dashboard profesional de análisis técnico de criptomonedas (BTC, ETH, SOL) con 14 indicadores técnicos, sentimiento en vivo, datos de derivados y análisis IA. Backend Node.js/Express + SQLite, frontend PixiJS v7.4.x.

---

## 2. Objetivo actual

**Validar y corregir calidad del JSON payload** enviado al LLM para análisis de mercado. El payload debe ser consistente, sin valores redundantes/contradictorios, e informar adecuadamente históricos temporales (7-30 días).

---

## 3. Estado confirmado

✅ **Backend operativo:**
- 7 servicios externos (CoinGecko, alternative.me, Coinalyze, Anthropic) integrados
- 14 indicadores técnicos calculados correctamente en 4 timeframes
- SQLite con WAL mode funcionando
- Endpoints `/api/data` y `/api/analyze/payload` devuelven JSON válido

✅ **Frontend operativo:**
- PixiJS canvas con velas, grid, interactividad (drag/zoom/crosshair)
- Selector coin/TF + persistencia en localStorage
- Sidebar con indicadores, sentimiento, derivados

✅ **Tests:**
- 69 tests unitarios en `indicators.test.js`, todos pasando

---

## 4. Problema activo

🔴 **5 bugs identificados en el payload JSON:**

### Bug #1: CVD y OBV idénticos en 1h (CRÍTICO)
- **Síntoma:** Ambos valores = `-19203263226.6316` en 1h; en 4h/1D/1W son diferentes
- **Causa probable:** Copy-paste error o variable compartida en `computeIndicators()`
- **Impacto:** LLM recibe información duplicada, pierde contexto de presión de volumen vs momentum

### Bug #2: volume_history sin datos históricos (ARQUITECTÓNICO)
- **Síntoma:** `change_pct_7d: null`, `period_min === period_max`, solo 1 entry
- **Causa:** Indicadores CVD/OBV se calculan pero no se guardan en `historyService`
- **Impacto:** LLM no puede analizar momentum temporal (7-30 días)

### Bug #3: Bollinger Bands position > 1.0 (CÁLCULO)
- **Síntoma:** En 4h: `position: 1.0758` con rango que debería ser [0.0, 1.0]
- **Causa:** Fórmula incorrecta en `calculateBollingerBands()`
- **Impacto:** Interpretación errónea de overbought/oversold

### Bug #4: Funding Rate trend vs predicted_rate inconsistente (SEMÁNTICA)
- **Síntoma:** `trend: "rising"` pero `predicted_rate_pct: -0.1768` (negativo)
- **Causa:** Definición poco clara de `predicted_rate_pct`
- **Impacto:** Confusión en interpretación

### Bug #5: Conflicto de timeframes (ESTRATEGIA)
- **Síntoma:** 1h/4h bullish, pero 1D/1W bearish; resistencia a 0.11% en 1h
- **Causa:** Información contradictoria sin jerarquía clara
- **Impacto:** LLM recibe señales opuestas sin contexto de ponderación

---

## 5. Hipótesis abiertas

* **H1:** CVD=OBV es bug en cálculo de 1h, no en 4h/1D/1W → verificar `candles['1h']` en analysisController
* **H2:** El histórico no persiste porque `dataController` no llama `historyService.addCVDEntry()` → necesita integración
* **H3:** Bollinger Bands formula toma valor absoluto de rango en lugar de relativo → revisar `position` calculation
* **H4:** `predicted_rate_pct` es simplemente low_48h de FR, no predicción → renombrar campo para claridad
* **H5:** LLM necesita campo `timeframe_hierarchy` explícito con pesos para resolver conflicto TF → agregar a payload

---

## 6. Archivos implicados

**Core:**
* `backend/src/utils/indicators.js` — Cálculos de CVD, OBV, Bollinger Bands
* `backend/src/controllers/analysisController.js` — `buildAnalyzeContext()`, linea 274
* `backend/src/controllers/dataController.js` — Falta historización de CVD/OBV
* `backend/src/services/historyService.js` — Gestión de históricos (incompleto para CVD/OBV)
* `backend/src/services/coinalyzeService.js` — Lógica de `predicted_rate_pct`

**Referencias:**
* `BLUEPRINT.md` — Arquitectura general
* `CLAUDE.md` — Instrucciones del proyecto
* `PAYLOAD_QUALITY.md` — Estándares de calidad del payload (ya documentados)

---

## 7. Últimos cambios realizados

* **2026-04-06:** Análisis exhaustivo del payload JSON generado para SOL
* **2026-04-06:** Identificación de 5 bugs críticos y secundarios
* **2026-04-06:** Creación de `ANALYSIS_ISSUES.md` con detalles técnicos y pseudo-código
* **2026-04-06:** Documentación en memory: `payload_bugs_april2026.md`
* **2026-04-06:** Actualización de `SESSION_STATE.md` para continuidad

---

## 8. Resultado observado tras cambios

N/A — análisis sin cambios de código aún. Documentación realizada, bugs identificados, recomendaciones priorizadas.

**Payload actual (SOL, 1h primary_tf):**
- Valores técnicos calculados correctamente en 4h, 1D, 1W
- CVD=OBV en 1h → fallo de datos
- Históricos vacíos (1 entry) → sin cambios porcentuales
- Timeframes conflictivos (bullish corto plazo, bearish largo plazo) → falta estrategia

---

## 9. Riesgos / cosas a no romper

🚨 **CRÍTICO:**
- **Tests de indicadores:** No cambiar `indicators.test.js` sin actualizar tests — 69 tests deben pasar
- **Firmas de funciones:** `calculateCVD()`, `calculateOBV()`, `calculateBollingerBands()` son importadas por analysisController
- **API contract:** `/api/data` y `/api/analyze/payload` son consumidos por frontend + LLM → cambios requieren actualización frontend

⚠️ **IMPORTANTE:**
- **historyService en memoria:** Antes de agregar historización, evaluar si necesita persistencia (SQLite vs en-memory)
- **Coinalyze API fields:** No cambiar parsing de `funding_rate.predicted_rate_pct` sin validar con API real

---

## 10. Próximo paso recomendado

**Inmediato (30-45 min):**
1. Debug CVD=OBV en 1h:
   - Reproducir: `curl http://localhost:3000/api/data?coin=SOL&primary_tf=1h | jq '.technical."1h" | {cvd, obv}'`
   - Verificar que `candles['1h']` estructura es válida en analysisController
   - Trazar ejecución de `computeIndicators(candles['1h'], '1h')`

2. Si es bug real, corregir en `indicators.js` y revalidar payload

**Después (orden sugerido):**
- Agregar historización CVD/OBV en dataController (20 min)
- Corregir Bollinger Bands position formula (15 min)
- Tests: validar rango [0.0, 1.0] para position en todos los TF
- Documentar/validar `predicted_rate_pct` en coinalyzeService (10 min)

---

## 11. Prompt de continuidad recomendado

```
El proyecto CRYPTEX Dashboard tiene 5 bugs identificados en el payload JSON 
(2026-04-06). El más crítico es CVD=OBV idénticos en 1h.

Objetivos:
1. Debug y corregir CVD=OBV bug en 1h timeframe
2. Agregar historización de CVD/OBV en dataController para temporal momentum
3. Corregir fórmula Bollinger Bands position (debe estar en rango [0.0, 1.0])
4. Validar predicted_rate_pct logic en coinalyzeService

Ver archivo ANALYSIS_ISSUES.md para detalles completos.
Ver memory/payload_bugs_april2026.md para resumen técnico.

Estado actual: análisis completado, documentación lista, sin cambios de código aún.
```

---

**Última actualización:** 2026-04-06 · **Estado:** Bugs identificados, recomendaciones priorizadas, listo para debugging
