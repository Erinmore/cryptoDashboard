# SESSION_STATE.md

## 1. Proyecto

**Nombre:** CRYPTEX Dashboard  
**Descripción corta:** Dashboard profesional de análisis técnico de criptomonedas (BTC, ETH, SOL) con 14 indicadores técnicos, análisis IA, datos de derivados y visualización con PixiJS. Backend Node.js/Express, SQLite, frontend Vite.

## 2. Objetivo actual

Extender el sistema de históricos para incluir **CVD (Cumulative Volume Delta)**, **OBV (On-Balance Volume)**, y **severity en Funding Rate** con series temporales (7-30 días) que aporten contexto temporal al análisis del LLM, mejorando la capacidad de detección de tendencias y divergencias de momentum a largo plazo.

## 3. Estado confirmado

✅ **Sistema de históricos operativo en `historyService.js`:**
- Fear & Greed: 30 días (1 entrada/día)
- Funding Rate: 8 candles (48h @ 6h interval)
- Open Interest: 42 candles (7 días @ 4h interval)
- Long/Short Ratio: 168 candles (7 días @ 1h interval)
- Liquidations: 7 días (1 entrada/día)
- **CVD: 30 días (1 entrada/día)** ✨ NUEVO
- **OBV: 30 días (1 entrada/día)** ✨ NUEVO

✅ **CVD y OBV calculados localmente y guardados en históricos:**
- Funciones puras en `indicators.js`: `calculateCVD()`, `calculateOBV()` (sin modificación)
- Devuelven: `value`, `trend` (vs 5 velas), `divergence` con precio
- Se recalculan en cada request a partir de candles del timeframe activo (1D)

✅ **Históricos de CVD/OBV poblados en `dataController.js`:**
- Después de calcular indicadores 1D, se guarda entrada CVD/OBV con:
  - `date` (YYYY-MM-DD)
  - `value` (número)
  - `trend` ('rising' | 'falling' | 'flat')
  - `divergence` ('none' | 'bullish' | 'bearish')
  - `change_pct_7d` (null si histórico < 7 entradas)
- Dedup activo: máximo 1 entrada por día

✅ **Payload para LLM enriquecido:**
- Nueva sección `volume_history` con resúmenes CVD y OBV (30d)
- Cada resumen incluye: current_value, trend, divergence, change_pct_7d, change_pct_30d, period_min/max, trend_30d (regresión lineal)
- `funding_rate.history` ahora incluye `severity_current` (normal/elevated/high/extreme)
- Overhead: ~200 tokens adicionales

## 4. Cambios realizados en esta sesión (2026-04-06)

**Implementación completada:**

1. **`historyService.js`** (22 líneas añadidas):
   - LIMITS: cvd: 30, obv: 30
   - histories: cvd: [], obv: []
   - addCVDEntry(date, value, trend, divergence, change_pct_7d)
   - addOBVEntry(date, value, trend, divergence, change_pct_7d)
   - getHistories() actualizado para retornar cvd y obv
   - logHistoriesSummary() actualizado

2. **`dataController.js`** (40 líneas añadidas):
   - Import: addCVDEntry, addOBVEntry
   - Lectura de prevHistories antes de guardar (para calcular change_pct_7d)
   - Guarda CVD/OBV si existen indicadores en TF 1D
   - Una sola llamada a getHistories() post-inserción

3. **`analysisController.js`** (130 líneas añadidas):
   - computeLinearTrend(values): función helper para regresión lineal simple
   - severity_current en fundingRateSummary
   - cvdSummary: resumen 30d con trend_30d, change_pct_7d/30d
   - obvSummary: resumen 30d (estructura idéntica a CVD)
   - volume_history: nueva sección en el payload LLM

4. **Tests:** 69 tests existentes pasan sin cambios ✅

5. **Commit:** `fb0e46b` — "Feat: Add CVD/OBV historical data (30 days) and funding rate severity to LLM payload"

## 5. Arquitectura de datos

```json
{
  "volume_history": {
    "cvd": {
      "current_value": 125.4521,
      "current_trend": "rising",
      "current_divergence": "none",
      "change_pct_7d": 12.3,
      "change_pct_30d": 45.2,
      "period_min": -230.1,
      "period_max": 380.4,
      "trend_30d": "rising"
    },
    "obv": { "/* idem */" }
  },
  "derivatives": {
    "funding_rate": {
      "history": {
        "severity_current": "normal",
        "...": "campos existentes"
      }
    }
  }
}
```

## 6. Decisiones de diseño

| Decisión | Motivo |
|----------|--------|
| Granularidad diaria para CVD/OBV | Alineado con Fear & Greed (30d), evita exceso de datos |
| Almacenamiento en historyService (no SQLite) | Datos efímeros por diseño (se recalculan a diario) |
| change_pct_7d calculado en dataController | Acceso al histórico previo; separación de responsabilidades |
| trend_30d via regresión lineal | Más robusto que comparación simple inicio vs fin; suaviza ruido |
| severity en FR history | Contexto temporal para LLM (no solo valor numérico) |

## 7. Riesgos / cosas a no romper

🔴 **CRÍTICO:** El patrón de LIMITS y dedup debe mantenerse idéntico (fecha/timestamp como clave)  
🔴 **CRÍTICO:** No guardar CVD/OBV en SQLite — contradice "indicadores técnicos son efímeros"  
🟡 **IMPORTANTE:** Tests siguen pasando (69/69 ✅)  
🟡 **IMPORTANTE:** change_pct_7d es `null` si histórico insuficiente (protección contra division por cero)  

## 8. Próximo paso recomendado

**Opcional, futuro:**
- Documentar volume_history en CLAUDE.md
- Panel frontend para visualizar CVD/OBV históricos
- Backfilling históricos iniciales (si es necesario)

**Inmediato:**
- Validar que `/api/data?coin=BTC&tf=1D` incluye cvd/obv en history
- Validar que `/api/analyze/payload` incluye volume_history y severity_current
- Esperar a que histórico acumule 7+ entradas para verificar change_pct_7d

## 9. Prompt de continuidad para próxima sesión

```
En la sesión actual (2026-04-06) implementamos la extensión de históricos:

COMPLETADO:
✅ Históricos CVD/OBV (30 días, diario) operativos
✅ change_pct_7d calculado en dataController
✅ trend_30d via regresión lineal en analysisController
✅ severity_current en funding_rate history
✅ Nueva sección volume_history en payload LLM
✅ Todos los 69 tests siguen pasando

ESTADO ACTUAL:
- Backend: operativo, ready para testing
- Payload LLM: enriquecido con contexto temporal de volumen
- Overhead: ~200 tokens (negligible)

PRÓXIMO PASO:
- Validar endpoints en testing manual
- [Opcional] Documentar en CLAUDE.md
- [Opcional] Visualizar históricos en frontend
```
