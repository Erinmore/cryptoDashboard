# SESSION_STATE.md (archivado 2026-06-30 — snapshot post Sprint Schema, pre sesión de históricos)

> Archivado tras la sesión de 2026-06-30 (fix de históricos por-coin + backfill de Coinalyze).
> Ver `SESSION_STATE.md` en la raíz para el estado vigente.

## 1. Proyecto

Nombre: CRYPTEX Dashboard
Descripción corta: Dashboard profesional de análisis técnico de criptomonedas (BTC/ETH/SOL). Backend Node.js 18/Express/SQLite, frontend PixiJS v7.4.x, tests Jest 29. Deploy target: Raspberry Pi 5 con Docker + Nginx Proxy Manager.

---

## 2. Estado actual

**169/169 tests pasan** (121 unitarios `indicators.test.js` + 48 integración `integration.test.js`)

| Bloque | Estado |
|--------|--------|
| Schema nuevo 4 tablas (analyses, analysis_tf_snapshot, analysis_outcome, analysis_liquidation_snapshot) | ✅ Implementado |
| `dbService.js` — transacción 4 tablas, pruning en cascada, `getAnalysisHistory()` actualizado | ✅ Implementado |
| `anthropicService.js` — OUTPUT FORMAT JSON puro, `analyzeMarket()` con SDK real | ✅ Implementado |
| `analysisController.js` — mapeo completo payload → 4 tablas, TF snapshots, clusters | ✅ Implementado |
| Tests integración actualizados al nuevo formato `{structured, narrative, ai_metadata}` | ✅ Implementado |
| `analysis_outcome` — tabla creada, sin job de relleno (por diseño) | ✅ Tabla lista |
| Sprint Briefing — dataset D1-D22 + prompt P1-P7 (corrección histórica: completado antes de Sprint Schema, no reflejado en la versión previa de este documento) | ✅ Implementado |
| Dev launcher `scripts/runSystem.sh` — menú interactivo backend/frontend | ✅ Implementado |
| Docker — Dockerfiles backend/frontend + `docker-compose.yml` | ✅ Implementado |
| Panel frontend historial IA (Fase 12) | ⏳ Pendiente |
| Deploy Pi: infra NPM, red `proxy`, configuración proxy host | ⏳ Pendiente |

---

## 3. Schema implementado

### Tabla 1: `analyses` (cabecera — una fila por análisis)

Campos añadidos vs SESSION_STATE original:
- `funding_severity TEXT` — severidad positiva (sobre-compra); se añadió porque el schema original solo tenía `funding_severity_negative`
- `ob_imbalance_top5_ratio REAL` — ratio top 5 niveles (más señal, menos ruido que el top 20); se añadió junto a `ob_imbalance_ratio`

```sql
id TEXT PRIMARY KEY
coin TEXT NOT NULL
primary_tf TEXT
timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
prompt_version TEXT

-- Precio y mercado
price_current REAL
price_change_24h_pct REAL
btc_dominance_pct REAL
market_cap_change_24h_pct REAL

-- Sentimiento
fear_greed_value INTEGER
fear_greed_class TEXT
fear_greed_trend_30d TEXT          -- desde sentiment.fear_greed_history.trend_30d
fear_greed_30d_avg REAL            -- desde sentiment.fear_greed_history.period_avg

-- Macro
macro_regime TEXT
dxy_value REAL
dxy_trend_5d TEXT
spx_trend_5d TEXT
gold_trend_5d TEXT

-- Volatilidad implícita
btc_dvol_value REAL
btc_dvol_regime TEXT
eth_dvol_value REAL

-- On-chain
mvrv REAL
mvrv_zscore REAL
mvrv_signal TEXT
nupl REAL
nupl_signal TEXT
sopr REAL
sopr_signal TEXT

-- Derivados
funding_rate_pct REAL
funding_severity TEXT              -- ← AÑADIDO (positivo: normal/elevated/high/extreme)
funding_severity_negative TEXT
funding_trend TEXT
predicted_rate_pct REAL
oi_value_usd REAL
oi_change_24h_pct REAL
oi_trend_7d TEXT                   -- desde derivatives.open_interest.history.trend_7d
long_pct REAL
short_pct REAL
liq_longs_24h_usd REAL
liq_shorts_24h_usd REAL

-- ETF Flows
etf_trend_7d TEXT
etf_net_inflow_7d_usd REAL
etf_data_freshness TEXT

-- Order book
ob_imbalance_ratio REAL
ob_imbalance_top5_ratio REAL       -- ← AÑADIDO
ob_imbalance_signal TEXT

-- Timeframe conflict
tf_conflict TEXT

-- DECISIÓN LLM
action TEXT
confidence TEXT
risk_score INTEGER
conviction REAL
primary_driver TEXT
has_executable_setup INTEGER
gating_active INTEGER
gating_reason TEXT
contradictions_found INTEGER

-- Scores internos del LLM
score_derivatives INTEGER
score_structure INTEGER
score_volume INTEGER
score_onchain INTEGER
score_total REAL

-- Setup táctico (nullable)
setup_entry_price REAL
setup_stop_price REAL
setup_tp1_price REAL
setup_tp2_price REAL
setup_validity_candles INTEGER
setup_tf_execution TEXT

-- Texto del LLM
executive_summary TEXT
ai_response_full TEXT              -- JSON completo {structured, narrative}

-- Metadatos técnicos
processing_time_ms INTEGER
input_tokens INTEGER
output_tokens INTEGER
model_used TEXT
```

### Tabla 2: `analysis_tf_snapshot` (4 filas por análisis — una por TF)

Campo añadido vs SESSION_STATE original:
- `wave_trend_signal TEXT` — señal del WaveTrend oscillator; coste cero, útil como confirmación de momentum

```sql
analysis_id TEXT
tf TEXT

trend TEXT
momentum_alignment INTEGER
regime TEXT

rsi_value REAL
rsi_signal TEXT
rsi_divergence TEXT
stochrsi_k REAL
stochrsi_d REAL
stochrsi_signal TEXT
macd_histogram REAL
macd_momentum_state TEXT
adx_value REAL
adx_trend_direction TEXT
adx_regime TEXT
supertrend_direction TEXT
wave_trend_signal TEXT             -- ← AÑADIDO
bb_position REAL
bb_width_pct REAL

volume_delta_buy_pct REAL
cvd_trend TEXT
cvd_divergence TEXT
vwap_trend TEXT
vwap_divergence TEXT

bos_direction TEXT
bos_valid INTEGER
choch_direction TEXT
fvg_bullish_count INTEGER
fvg_bearish_count INTEGER

nearest_support_pct REAL
nearest_resistance_pct REAL

vp_poc_distance_pct REAL
vp_valid INTEGER

PRIMARY KEY (analysis_id, tf)
```

### Tabla 3: `analysis_outcome` (resultado real — rellena después)

Sin cambios respecto al diseño original. Tabla creada vacía — el job de relleno es trabajo futuro.

```sql
analysis_id TEXT PRIMARY KEY
price_at_analysis REAL
price_1h_later REAL
price_4h_later REAL
price_24h_later REAL
price_7d_later REAL
outcome_1h TEXT
outcome_24h TEXT
outcome_7d TEXT
setup_hit_tp1 INTEGER
setup_hit_tp2 INTEGER
setup_hit_stop INTEGER
setup_outcome TEXT
pnl_pct_24h REAL
```

### Tabla 4: `analysis_liquidation_snapshot`

Sin cambios respecto al diseño original.

```sql
analysis_id TEXT
cluster_type TEXT                  -- "long"|"short"
cluster_rank INTEGER               -- 0-4
price REAL
total_usd REAL
distance_pct REAL
PRIMARY KEY (analysis_id, cluster_type, cluster_rank)
```

---

## 4. Formato de respuesta del LLM (implementado)

`analyzeMarket()` en `anthropicService.js` devuelve `{ structured, narrative, ai_metadata }`.

El SYSTEM_PROMPT pide JSON puro (sin markdown, sin bloques de código):

```json
{
  "structured": {
    "action": "Esperar",
    "confidence": "Media",
    "risk_score": 7,
    "conviction": 0.5,
    "primary_driver": "derivatives",
    "has_executable_setup": false,
    "gating_active": true,
    "gating_reason": "ADX < 20 en 4h — sin fuerza de tendencia suficiente",
    "contradictions_found": true,
    "scores": {
      "derivatives": 1,
      "structure": -1,
      "volume": 0,
      "onchain": 1,
      "total": 0.5
    },
    "setup": null,
    "executive_summary": "Conflicto estructural severo entre timeframes con shorts sobrecargados."
  },
  "narrative": {
    "smart_money_read": "...",
    "divergences_anomalies": "...",
    "tactical_setup": "...",
    "risk_analysis": "...",
    "recommendation_detail": "...",
    "invalidation": "..."
  }
}
```

`prompt_version`: `v5_0_structured_output`

---

## 5. Mappings importantes (controller → DB)

Campos que requieren mapeo no trivial (no son 1:1):

| Campo DB | Origen en el payload |
|----------|----------------------|
| `fear_greed_trend_30d` | `context.sentiment.fear_greed_history.trend_30d` |
| `fear_greed_30d_avg` | `context.sentiment.fear_greed_history.period_avg` |
| `oi_trend_7d` | `context.derivatives.open_interest.history.trend_7d` |
| `fvg_bullish_count` | `smc.unmitigated_fvgs.bullish.length` (objeto, no array plano) |
| `fvg_bearish_count` | `smc.unmitigated_fvgs.bearish.length` |
| `has_executable_setup` | bool → 0/1 |
| `gating_active` | bool → 0/1 |
| `contradictions_found` | bool → 0/1 |
| `bos_valid` | bool → 0/1 |
| `momentum_alignment` | bool → 0/1 |
| `vp_valid` | bool → 0/1 |

---

## 6. Deuda técnica identificada (en esta fecha)

### Alta prioridad (backtesting afectado)

- **`analysis_outcome` job**: Las filas de `analysis_outcome` se crean vacías. Hace falta un job/cron que, pasadas N horas de cada análisis, busque el precio en Binance y calcule `price_Nh_later`, `outcome_Nh`, `pnl_pct_24h`. Sin esto el backtesting no es posible.
- **S/R strength en snapshot**: `analysis_tf_snapshot` guarda solo `nearest_support_pct` y `nearest_resistance_pct` (distancia). El JSON tiene `strength` (1-3) y `touches` para el nivel más cercano. Considerar añadir `nearest_support_strength INTEGER` y `nearest_resistance_strength INTEGER`.

### Media prioridad (análisis enriquecido)

- **FVGs detallados**: solo se guardan `fvg_bullish_count`/`fvg_bearish_count`. Para backtesting SMC real haría falta una tabla `analysis_fvg_snapshot`.
- **SuperTrend level**: falta `supertrend_level REAL` (nivel de precio exacto, no solo dirección).
- **`volume_history.vwap` top-level**: VWAP de largo plazo (30d) no se persiste en ninguna tabla.

### Baja prioridad

- **`volume_delta.anomaly`**: sin masa crítica para backtesting. Ignorar por ahora.
- **`etf_flows.by_issuer`**: se descarta correctamente, solo se guarda el agregado.

---

## 7. Próximos pasos recomendados (en esta fecha)

**Inmediato — Fase 12: Panel frontend historial IA**

El backend devuelve en `GET /api/history/:coin` los campos suficientes para una lista rica sin abrir el detalle de cada análisis (ver campos en la versión vigente de SESSION_STATE.md).

**Siguiente sesión — `analysis_outcome` job**

Cron o endpoint manual que rellena los precios posteriores.

**Deploy Pi**

Setup infra: instalar Docker en Pi, crear red `proxy`, levantar NPM, configurar proxy host en UI NPM para `cryptex.lan`. (Los Dockerfiles y docker-compose.yml del repo ya están listos — falta el setup del lado de la Pi.)

---

## 8. Nota de archivado

Este documento describe el estado del proyecto inmediatamente antes de la sesión de históricos del 2026-06-30 (partición por coin de `historyService`, backfill completo desde Coinalyze, fixes de `analysisController` para resúmenes con histórico insuficiente). Ver `SESSION_STATE.md` en la raíz del repo para el estado vigente y la deuda técnica actualizada.
