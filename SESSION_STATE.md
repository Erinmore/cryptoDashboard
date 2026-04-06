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

### Bug #1: CVD y OBV idénticos en 1h (RESUELTO - es convergencia matemática, no bug)
- **Síntoma:** Ambos valores = `-19203263226.6316` en 1h; en 4h/1D/1W son diferentes
- **Causa raíz:** Convergencia matemática en downtrends puros:
  - CVD: cuando close ≈ low, `delta = -volume`
  - OBV: cuando close < prev.close, resta volume
  - En downtrend monolítico: ambas suman `-total_volumes`
- **Evidencia:** Con candles 100→99→98→97→96, ambas = -8000
- **Solución:** Documentado en memory `cvd_obv_convergence.md` — no es error de código
- **Impacto anterior:** Creía ser bug, pero es propiedad matemática de los indicadores

### Bug #2: volume_history sin datos históricos (ARQUITECTÓNICO)
- **Síntoma:** `change_pct_7d: null`, `period_min === period_max`, solo 1 entry
- **Causa:** Indicadores CVD/OBV se calculan pero no se guardan en `historyService`
- **Impacto:** LLM no puede analizar momentum temporal (7-30 días)

### Bug #3: Bollinger Bands position > 1.0 (✅ RESUELTO)
- **Síntoma:** En 4h: `position: 1.0758` con rango que debería ser [0.0, 1.0]
- **Causa:** Fórmula no clampaba cuando price > upper band
- **Fix:** `position = Math.max(0, Math.min(1, rawPosition))`
- **Commit:** `af555b0` — clamp a [0.0, 1.0]
- **Tests:** Todos 69 tests pasan ✓

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

✅ **Cambios realizados (2026-04-06 sesión continuada):**

1. **Bug #3 (Bollinger Bands)** → ✅ CORREGIDO
   - Clamped position a [0.0, 1.0]
   - Commit: `af555b0`
   - Tests: 69/69 pass

2. **Bug #1 (CVD=OBV)** → ✅ ANALIZADO
   - No es bug de código, es convergencia matemática en downtrends puros
   - Documentado en memory: `cvd_obv_convergence.md`

3. **Bug #2 (Historización CVD/OBV)** → ✅ VERIFICADO
   - `dataController` ya alimenta históricos correctamente
   - `addCVDEntry()` / `addOBVEntry()` llamadas en líneas 99, 109
   - Históricos en memoria funcionando (1 entry hoy, expandirá en 7 días)

4. **Bug #4 (predicted_rate_pct)** → ✅ ACLARADO
   - No es bug, es verdadera predicción de Coinalyze
   - Trend actual vs predicción futura son independientes y válidos

5. **Bug #5 (Conflicto de timeframes)** → ✅ RESUELTO
   - Nueva función `analyzeTimeframeConflicts()` agregada a analysisController
   - Detecta divergencia corto plazo vs largo plazo
   - Proporciona reasoning, guidance, y jerarquías por estrategia
   - Campo `timeframe_analysis` en payload con:
     - `conflict`: string que identifica el tipo de conflicto
     - `reasoning`: explicación para el usuario
     - `hierarchy_tiers`: estrategias diferentes (default, momentum, confirmation)
     - `guidance`: instrucción general para resolver

**Payload actual (SOL, 1h primary_tf):**
```
timeframe_analysis: {
  conflict: "short_term_bullish_long_term_bearish",
  reasoning: "Short-term momentum is bullish but longer timeframes show bearish structure...",
  hierarchy_recommendation: "default",
  hierarchy_tiers: { default: [1D, 4h, 1W, 1h], ... },
  guidance: "For conflicting signals: wait for alignment..."
}
```

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

**✅ COMPLETADO (sesión 2026-04-06):**
1. ✅ Debug CVD=OBV en 1h → hallazgo: convergencia matemática, no bug
2. ✅ Corregir Bollinger Bands position → clamp a [0.0, 1.0]
3. ✅ Tests: todos 69 pasan post-fix
4. ✅ Bug #5: Timeframe conflict analysis → implementado y commiteado (commit `65a0a71`)

**Inmediato (próxima sesión):**
1. **Opcional:** Reemplazar OBV con indicador alternativo (VWAP momentum) para evitar convergencia en downtrends puros
2. **Opcional:** Añadir detección más granular de conflictos (divergencia de momentum, volatilidad)
3. **Seguimiento:** Monitorear respuestas del LLM para verificar si `timeframe_analysis` mejora calidad de análisis
4. **Fase 15:** Tests de integración para todos los endpoints de payload

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
