# SESSION_STATE.md

## 1. Proyecto

Nombre: CRYPTEX Dashboard
Descripción corta: Dashboard profesional de análisis técnico de criptomonedas (BTC/ETH/SOL). Backend Node.js 18/Express/SQLite, frontend PixiJS v7.4.x, tests Jest 29. **Desplegado en Raspberry Pi 5 — nativo + systemd** (un proceso Express en `:8080` sirviendo API + SPA; NO Docker). Ver §18 y CLAUDE.md §Deploy.

Versión anterior de este documento archivada en [`doc/SESSION_STATE_2026-04-27_sprint-schema.md`](doc/SESSION_STATE_2026-04-27_sprint-schema.md) (snapshot post Sprint Schema, antes de la sesión de históricos).

---

## 2. Estado actual

**399/399 tests pasan** (17 suites). El desglose por fichero está en CLAUDE.md §Tests; las sesiones 21–25 añadieron `gating.test.js`, `decisionGates.test.js`, `expectedScores.test.js`, `stats.test.js`, `levelStrength.test.js` y `outcomeService.test.js` sobre la base anterior.

> **MODELO: seleccionable desde el frontend** (desplegable en el header) — Opus 4.8 / Sonnet 5 / Haiku 4.5, con coste
> orientativo. Whitelist `ANALYSIS_MODELS` en `constants.js`; `resolveModel` valida y cae al **default Opus 4.8** si el id
> no es válido. La selección se persiste en localStorage y se envía en `POST /api/analyze`; el modelo usado queda en
> `analyses.model_used` y se muestra en cada tarjeta del historial. Esto **cierra el pendiente "revertir a Opus 4.8"**:
> el default ya es Opus 4.8 y se elige por análisis desde la UI. `thinking:{type:'disabled'}` sólo se envía en Sonnet 5.
> Ver §17.

> Auditoría crítica 2026-07-02 (§16): 7 hallazgos (A1–A7). **A1–A5 y A7 resueltos**; A6 (bump a Opus 4.8) **hecho**.
> Segunda revisión 2026-07-03 (§16): 3 hallazgos nuevos (A8–A10) **resueltos** — deriva de base del CVD persistido + 2 fugas del job outcome.
> Tercera revisión 2026-07-03 (§16): 4 hallazgos nuevos (A11–A14) **resueltos** — datos erróneos al LLM (conflicto TF falso por neutral, severity negativa, F&G trend, guard LSR). Detalle en §16.
> Sesión 2026-07-03 (§17): bump modelo + parse robusto (`extractJson`) + tanda de fixes de UI + **selector de modelo IA**. Detalle en §17.
> Sesión 2026-07-03 (§18): **DEPLOY en la Pi — nativo + systemd** (no Docker), Express sirve el SPA, BD dev migrada, `scripts/deploy.sh`, fix `last_analysis`. Detalle en §18.
> Sesión 2026-07-03/04 (§19): **integración en el kiosko de piAssistant (iframe)** — 2 fixes de cabeceras en `security.js` (`frameguard: false` + CORS `cb(null, false)`). Detalle en §19.
> Sesión 2026-07-07 (§24): **hotfix producción — `temperature` deprecado** por los modelos actuales (Claude 5 / Opus 4.8). La C1 (§23) que lo fijaba a 0 provocaba **400 en cada análisis** ("Internal server error" en el panel). `temperature` pasa a **opt-in** (default `null` → no se envía). Desplegado a la Pi y verificado con análisis real. Detalle en §24.
> Sesión 2026-07-10/12 (§26, `v6_5` → `v6_8_atr_levels`): **2ª AUDITORÍA RED-TEAM + sprint de remediación en 5 fases (0-4)** — 3 críticos nuevos cerrados (leak de `expected_scores` al LLM, PnL sin signo en el backtest, semántica CVD/absorción incoherente con el veto) + unidad real del OI (monedas base, no USD), puerta de `Preparar`, umbral de niveles normalizado por ATR, inventario hechos→consumidores en BLUEPRINT.md. 372 → 399 tests. **⚠ v6_7+v6_8 PENDIENTES DE DEPLOY (Pi apagada)**. Detalle en §26.
> Sesión 2026-07-10 (§25, `v6_4` → `v6_5_block_dedup`): **revisión crítica en profundidad previa a la 2ª auditoría** — 3 hallazgos + test. **Desplegado a la Pi y verificado en vivo** (§25.1). (1) C1 corregido **en la doc** (el fix de temperatura se había revertido pero CLAUDE.md seguía afirmando "fijada a 0"; reproducibilidad NO garantizada a nivel de API). (2) Guardia de volumen C2 reenganchada al **CVD del TF primario** con carve-out de absorción (antes usaba `buy_pressure_pct` acumulado → pegado a ~50 → guardia inerte). (3) Contradicciones deterministas **de-correlacionadas por bloque** (volume/derivados/estructura, máx 3). Churn del backtest acotado (setup con `entry_price` nulo → `invalid` inmediato) **con test nuevo** (`outcomeService.test.js`). 364 → 372 tests. Detalle en §25.

> Sesión 2026-07-02 (cont.): botón "Download data" (payload + prompt), fix escala funding Coinalyze (venía en %, no ×100), unificación TF prompt (v5_3), fix persistencia BBDD (dejar de dropear tablas en cada arranque), validador determinista §6.4 completo (§14) y hardening del dev launcher (guard de puerto + kill por PGID + `restart`).

| Bloque | Estado |
|--------|--------|
| Schema 4 tablas (analyses, analysis_tf_snapshot, analysis_outcome, analysis_liquidation_snapshot) | ✅ Implementado |
| `dbService.js`, `anthropicService.js` (`analyzeMarket()` con SDK real), `analysisController.js` | ✅ Implementado |
| Sprint Briefing (dataset D1-D22 + prompt P1-P7) | ✅ Implementado |
| Dev launcher `scripts/runSystem.sh` | ✅ Implementado |
| Docker — Dockerfiles + `docker-compose.yml` | ✅ Existen (alternativa, NO en uso — se desplegó nativo) |
| **Sesión 2026-06-30 — históricos por coin + backfill Coinalyze** (detalle en §9) | ✅ Implementado |
| **Sesión 2026-06-30 (cont.) — auditoría de calidad del payload SOL + fixes** (detalle en §10) | ✅ Implementado |
| **Sesión 2026-06-30 (cont. 2) — revisión cruzada IA externa: fix CVD % + null-con-razón** (detalle en §11) | ✅ Implementado |
| **Sesión 2026-07-02 — persistencia SQLite de TODOS los históricos + summaries gap-aware** (detalle en §12) | ✅ Implementado |
| Panel frontend historial IA (Fase 12) | ✅ Implementado |
| Panel recomendación IA en vivo (fix schema {structured,narrative}) | ✅ Implementado |
| Poller de fondo históricos (todas las monedas) | ✅ Implementado |
| `analysis_outcome` job (backtesting) + endpoints /api/outcome | ✅ Implementado |
| **Deploy Pi — nativo + systemd** (`cryptex.service` :8080, `scripts/deploy.sh`, BD migrada) (detalle en §18) | ✅ Implementado (2026-07-03) |

---

## 3. Schema implementado

Sin cambios respecto a la sesión anterior. Ver el detalle completo (las 4 tablas con todos los campos) en [`doc/SESSION_STATE_2026-04-27_sprint-schema.md`](doc/SESSION_STATE_2026-04-27_sprint-schema.md) §3.

---

## 4. Formato de respuesta del LLM

Sin cambios. `analyzeMarket()` devuelve `{ structured, narrative, ai_metadata }`, `prompt_version: v5_0_structured_output`. Detalle completo en el documento archivado §4.

---

## 5. Mappings importantes (controller → DB)

Sin cambios. Ver documento archivado §5.

---

## 6. Deuda técnica identificada (actualizada 2026-06-30)

> **Auditoría crítica 2026-07-02 (§16):** 7 hallazgos nuevos priorizados (A1–A7) tras revisión a dos pasadas del trabajo de las sesiones §9–§15. Ver detalle, ubicación y plan de fix en **§16**. Se acometen uno a uno.

### Alta prioridad

1. ✅ **Persistencia de históricos — RESUELTO (sesión 2026-07-02, ver §12).**
   Tabla `history_series` genérica persiste las 7 series (write-through). CVD/VWAP se hidratan en memoria al arrancar (única serie sin backfill externo); summaries gap-aware con `null` en huecos grandes. Detalle completo en §12.

2. ✅ **`analysis_outcome` job — COMPLETADO.** `services/outcomeService.js` (`runOutcomeJob` + scheduler) rellena `analysis_outcome` progresivamente: precios a 1h/4h/24h/7d (Binance klines históricas vía `fetchHistoricalClose`/`fetchHistoricalKlines`), clasificación direccional (`classifyOutcome`) y barrier de setup TP1/TP2/stop (`evaluateSetupBarrier`, funciones puras en `utils/outcome.js`). Corre cada `OUTCOME_JOB_INTERVAL_SEC` (900s) desde index.js + endpoints `POST /api/outcome/run` (manual) y `GET /api/outcome/stats` (win-rate, PnL medio, TP/stop). Bug de aislamiento de tests corregido de paso (integration.test.js usaba la BBDD real). 19 tests puros nuevos.

3. ✅ **S/R strength en `analysis_tf_snapshot` — RESUELTO (2026-07-03).** Se persisten `nearest_support_strength`/`nearest_resistance_strength INTEGER` (escala 0-5 = `min(floor(touches/2),5)`, ya calculada por `calculateSupportResistance`). `computeLevelDistances` (ahora exportada) coge el `strength` de `supports[0]`/`resistances[0]`; migración idempotente vía `ensureColumn` en `db.js`; INSERT ampliado en `dbService`. 4 tests (`levelStrength.test.js`). Desplegado y migración verificada en la Pi.

4. ✅ **Validador determinista del output del LLM — COMPLETADO (§14, ambas fases).**
   Módulo `services/analysisValidator.js` (funciones puras) con `validateAnalysis()` (Fase 1: detecta+clasifica violaciones) y `applyFailSafe()` (Fase 2: degrada a Esperar ante violación severa). Cableado en `analysisController` tras el LLM y antes de `saveAnalysis`; persistencia en `analyses.validation_warnings`; flag `ANALYSIS_FAILSAFE_ENABLED` (default true). 24 tests. Detalle en §14. Texto original de referencia abajo:

   Módulo `services/analysisValidator.js` (funciones puras, cero dependencias) que verifica que el `structured` devuelto por `analyzeMarket()` respeta las reglas duras del SYSTEM_PROMPT. Corre en `analysisController` **después** del LLM y **antes** de `saveAnalysis` (no confundir con un validador de payload pre-LLM). Complementa la validación de estructura/JSON que ya hace `anthropicService` (parse + `AppError 502`), añadiendo coherencia de reglas de negocio. Invariantes a comprobar (no exhaustivo):
   - `action="Comprar"` ⟹ `scores.derivatives >= +1` Y `scores.volume >= +1`
   - `action="Vender"` ⟹ `scores.derivatives <= -1` Y `scores.volume <= -1`
   - `gating_active=true` ⟹ `action="Esperar"`
   - `has_executable_setup=false` ⟹ `setup === null`
   - setup coherente con dirección (long: `stop_price < entry_price`; short: inverso)
   - `conviction` en [0,1]; `scores.*` enteros en [-2,+2]; `risk_score` en [1,10]
   - `scores.total` coherente con los componentes (no suma mecánica, pero sin contradicción de signo flagrante)

   **Implementar en dos fases (acordado con el usuario):**
   - **Fase 1 — log + flag (primero):** registrar cada violación con el logger y persistir `validation_warnings` junto al análisis; dejar pasar la respuesta sin alterarla. Objetivo: telemetría real de con qué frecuencia y qué reglas viola el LLM antes de decidir si hace falta más. Si resulta que casi nunca viola (probable con Opus), no se necesita la fase 2.
   - **Fase 2 — fail-safe:** ante violación *severa* (Comprar/Vender que no cumple su gate, o gating ignorado), forzar `action="Esperar"` con nota explicativa (coherente con el DEFAULT STATE "por defecto ESPERAR"); las violaciones menores quedan en log-only. **No** implementar reintento al LLM aquí (eso ya es medio segundo pase — ver nota de diseño abajo).
   - Tests siguiendo el patrón de `indicators.test.js` (cada regla: caso válido + caso violación).

   Nota de diseño (contexto de la conversación 2026-06-30): se descartó arrancar por un "data validation layer" tipo Pydantic/ML-ready/streaming — error de categoría para un sistema single-user, on-demand, consumido por un LLM (no un modelo numérico). El segundo pase LLM adversarial (solo-degradar conviction) queda como opción posterior, idealmente tras el job `analysis_outcome` para poder A/B-testear si mejora decisiones. Punto medio antes de duplicar llamadas: activar extended thinking en la llamada única.

### Media prioridad

- **FVGs detallados**: tabla `analysis_fvg_snapshot` (solo se guardan counts hoy).
- ✅ **SuperTrend level — RESUELTO (2026-07-03).** `supertrend_level REAL` persiste el nivel numérico (soporte en UP / resistencia en DOWN) vía helper puro `supertrendLevel(st)` (exportado). Mismo patrón `ensureColumn` + map + INSERT. 3 tests. Desplegado + migración verificada en la Pi. (Persistencia para historial/backtesting; el LLM ya recibía el nivel en `super_trend` del payload.)
- ✅ **`volume_history.vwap` top-level — YA RESUELTO por §12 (nota obsoleta).** La nota es del 2026-06-30, cuando CVD/VWAP eran solo en memoria. §12 (2026-07-02) añadió `history_series` write-through para las 7 métricas, `vwap` incluida: la serie 30d se persiste (sobrevive reinicios), se hidrata al arrancar y llega al LLM como `volume_history.vwap` (vwapSummary). Verificado en la Pi (filas `vwap` en `history_series`, 1/coin, acumula 1/día). Sin código.

### Baja prioridad

- `volume_delta.anomaly`: sin masa crítica para backtesting aún.
- `etf_flows.by_issuer`: descartado correctamente, solo se guarda agregado.

---

## 7. Próximos pasos recomendados

Fase 12 (panel IA), poller multi-coin, validador §6.4 y job `analysis_outcome` → **completados** (ver §14/§15).

**Deploy Pi → COMPLETADO (§18)** — nativo + systemd (`cryptex.service` :8080), no Docker. Operativo en `http://192.168.1.250:8080`. Actualizaciones vía `scripts/deploy.sh`.

**Pendiente menor de deploy:**
- Entrada DNS `cryptex.lan → 192.168.1.250` en el router Zyxel (URL bonita `cryptex.lan:8080`, opcional).
- Integración de CRYPTEX en el kiosko del asistente (Chromium `--kiosk` en `:8000`) — falta identificar qué sirve ese puerto para decidir cómo mostrarlo (link/iframe/pestaña).

**▶ PRÓXIMO PASO INMEDIATO (2026-07-12): deploy de v6_7+v6_8 a la Pi.** La Pi estaba apagada al cerrar la sesión; las fases 3 y 4 del sprint de la 2ª auditoría (§26) están commiteadas y verificadas en local pero NO desplegadas (la Pi sirve v6_6). Al encenderla: `./scripts/deploy.sh` + verificar contra `/api/analyze/payload` que `prompt_version=v6_8_atr_levels`, que `technical[*].atr` y `gating.near_level_pct_used`/`borderline` aparecen, y que `open_interest.value_coins`/`value_usd` (derivado) son coherentes.

**Fase 5 del sprint auditoría #2 (cuando haya muestra de análisis):** coste de oportunidad de `Esperar`, win-rate path-aware (max adverse excursion con las klines 1h del barrier), de-duplicación por episodio antes del IC de Wilson, bucket de `conviction` en `getOutcomeStats`. Y con datos de `auditStats.mjs`: revisar los ajustes ±0.5 del prompt (order book B2) y la 6ª contradicción.

**Telemetría en marcha (sin acción inmediata)**
- Validador: revisar `analyses.validation_warnings` periódicamente para calibrar el fail-safe.
- Backtesting: cuando se acumulen análisis con >1h, `GET /api/outcome/stats` dará win-rate/PnL reales para juzgar el sistema (prompt+modelo).

**Deuda menor (§6)**: FVGs detallados, SuperTrend level numérico, S/R strength, `volume_history.vwap` top-level.

---

## 8. Prompt de continuidad

```
Continúa el desarrollo de CRYPTEX Dashboard (crypto dashboard Node.js/PixiJS).

Estado: 399/399 tests pasan. PROMPT_VERSION v6_8_atr_levels. Acabamos de completar el sprint de
remediación de la 2ª auditoría red-team (fases 0-4, detalle en SESSION_STATE.md §26): leak de
expected_scores al LLM cerrado, PnL firmado en el backtest, semántica CVD/absorción unificada,
unidad real del OI (monedas base + USD derivado), puerta de Preparar, umbral de niveles
normalizado por ATR, inventario hechos→consumidores en BLUEPRINT.md.

▶ PRIMER PASO: si la Pi está encendida, desplegar v6_7+v6_8 (./scripts/deploy.sh) y verificar
contra /api/analyze/payload: prompt_version=v6_8_atr_levels, technical[*].atr presente,
gating.near_level_pct_used/borderline, open_interest.value_coins + value_usd derivado.
(La Pi sirve v6_6 desde el 2026-07-10; estaba apagada al cerrar.)

Después: Fase 5 del sprint (backtest falsable) espera muestra de análisis acumulada — correr
backend/scripts/auditStats.mjs en la Pi para decidir si ya hay datos.

Jobs de fondo en index.js: historyPoller (300s) + outcomeService (900s). Dev launcher:
./scripts/runSystem.sh restart backend. Lee SESSION_STATE.md (§2, §26) y CLAUDE.md antes de empezar.
```

---

## 10. Sesión 2026-06-30 (cont.) — auditoría de calidad del payload SOL

### Contexto de partida

El usuario pasó un payload real de `/api/analyze/payload?coin=SOL` por una IA externa, en tres rondas sucesivas, pidiendo una revisión de consistencia interna de los datos (no de lectura de mercado). Cada hallazgo se verificó contra el código actual antes de tocar nada — varios resultaron ser malentendidos de una IA que evaluaba el payload como si fuera un feature store plano para ML, sin ver que el consumidor real es un LLM (Claude) con un SYSTEM_PROMPT que ya hace gran parte de la síntesis que la IA externa creía ausente.

### Ronda 1 — bugs de datos reales

- **`volume_profile.valid` con threshold fijo 5% para las 4 TFs** (`indicatorService.js`): el POC se calcula sobre un rango de precio que crece con la TF (1h ≈ 7 días, 1W ≈ 1 año), así que un único 5% invalidaba casi siempre 4h/1D/1W. Fix: nueva constante `VOLUME_PROFILE_VALID_THRESHOLD_PCT` en `constants.js` calibrada por TF (`1h: 5%, 4h: 8%, 1D: 12%, 1W: 20%`).
- **`vwapSummary.period_min`/`period_max` sin guard de histórico mínimo** (`analysisController.js`, `computeHistorySummaries`): con 1 solo punto en memoria (servidor recién arrancado), `Math.min`/`Math.max` sobre un array de 1 elemento coincidían trivialmente con `current_value`, simulando "sin evolución". Fix: gated por `hasTrend` (`length >= 2`), igual que ya hacían `change_pct_7d`/`change_pct_30d`.
- **Descartados como no-bug** (verificado contra código): `fear_greed.trend` vs `trend_7d_change` (ventanas temporales distintas, 1d vs 7d, ambas correctas); `funding_rate.severity` vs `history.severity_current` (live vs último candle de 6h, divergencia legítima por lag de cache).

### Ronda 2 — naming ambiguo (mejora menor, sin cambio de lógica)

Aunque no eran bugs, los dos nombres confusos de la ronda 1 invitaban a leerse como contradicción. Renombrados sin tocar la lógica:
- `fearGreedService.js`: `trend` → **`trend_1d`** (objeto "current", no las entradas de histórico). Propagado en `analysisController.js` (sentiment.fear_greed), `frontend/assets/js/ui/sidebar.js` (3 usos) y comentario en `frontend/assets/js/state/store.js`.
- `analysisController.js` (`fundingRateSummary`): `severity_current` → **`severity_last_candle`**, con comentario explicando que puede diferir del `severity` top-level (live) por hasta 6h de lag.

### Ronda 3 — feedback de arquitectura (mayormente descartado) + 1 mejora aceptada

La IA externa propuso un bloque `signal_confidence` con pesos fijos cross-TF (Weekly 30% / Daily 25% / 4h 20% / 1h 10% / Derivados 10% / Order book 5%), alegando "trend voting sin weighting". Verificado contra `anthropicService.js`: el SYSTEM_PROMPT ya tiene jerarquía explícita (`Contexto → Derivados → Volumen → Estructura → Confirmación`, dominancia `1D > 1h salvo squeeze confirmado`) y un **FUNDING PERSISTENCE FILTER** que ya degrada convicción ante funding extremo sin expansión de OI — el patrón "crowded long" que la IA creía no cubierto. Añadir pesos fijos server-side habría duplicado y potencialmente desincronizado esa lógica. Descartado.

Único punto aceptado: no existía un **flag explícito y consultable fuera del LLM** para ese patrón. Añadido `derivatives.crowded_trade_flag` (`analysisController.js`): `{ active, side, reason }`, `true` cuando `funding_rate.severity` (o `severity_negative`) está en `high`/`extreme` y `open_interest.history.trend_7d` no es `increasing`.

### Ronda 4 — segunda auditoría de calidad de datos (mayormente falsos positivos)

5 claims verificadas contra código:
- ❌ "volume_profile inválido no se propaga downstream" → falso, el SYSTEM_PROMPT ya tiene la regla P3 (Sprint Briefing) que instruye al LLM a ignorarlo explícitamente.
- ❌ "liquidation_clusters mezcla price-space y pct-space" → falso, campos ya separados sin ambigüedad (`price` vs `nearest_long_cluster_pct`).
- ❌ "`smc.last_bos` null es ambiguo" → falso, ya es un encoding de 3 estados limpio (`null` = no detectado / `{valid:true}` / `{valid:false, invalid_reason}`).
- ✅ **Gap real — falta timestamp por sub-bloque de derivados.** Coinalyze devuelve `entry.update` (epoch ms) y el código lo descartaba, quedándose solo con `.value`. Con TTLs de 30min (funding) y 5min (OI) frente a un precio casi en vivo, había riesgo de desync no detectable. Fix: nuevo campo `data_timestamp_utc` en `coinalyzeService.js` (las 4 funciones: `fetchFundingRate`, `fetchOpenInterest`, `fetchLongShortRatio`, `fetchLiquidations`), propagado en `analysisController.js` (pass-through automático ya en `dataController.js`).
- ✅ **Gap real (menor) — `divergence_window_candles` del CVD no es comparable entre TFs.** 20 velas de 1h ≈ 20h, 20 velas de 1W ≈ 140 días. Fix: nueva constante `TIMEFRAME_MINUTES` en `constants.js` + campo `divergence_window_minutes` añadido en `indicatorService.js` junto al de velas.

### Archivos tocados

- `backend/src/config/constants.js` — `VOLUME_PROFILE_VALID_THRESHOLD_PCT`, `TIMEFRAME_MINUTES`
- `backend/src/services/indicatorService.js` — threshold VP por TF, `divergence_window_minutes` en CVD
- `backend/src/services/fearGreedService.js` — `trend` → `trend_1d`
- `backend/src/services/coinalyzeService.js` — `data_timestamp_utc` en 4 funciones de fetch
- `backend/src/controllers/analysisController.js` — guard VWAP period_min/max, rename `trend_1d`/`severity_last_candle`, `crowded_trade_flag`, `data_timestamp_utc` en derivatives
- `frontend/assets/js/ui/sidebar.js` — `fearGreed.trend` → `fearGreed.trend_1d`
- `frontend/assets/js/state/store.js` — comentario actualizado

169/169 tests siguen pasando en todo momento. Sin cambios de schema SQLite.

---

## 11. Sesión 2026-06-30 (cont. 2) — revisión cruzada con IA externa: 2 fixes + 1 falso positivo descartado

### Contexto de partida

El usuario pasó otro payload de SOL por una IA externa que devolvió 9 "incoherencias críticas" + 3 puntos de diseño. Cada uno se verificó contra el código antes de tocar nada. **7 de las 9 eran falsos positivos** por falta de contexto del sistema:

- **#1 fechas en 2026** → hoy *es* 2026-06-30, producción real (la IA asumió que 2026 era futuro).
- **#2 funding 791% anualizado** → matemáticamente correcto (`rate * 3 * 365`, 3 pagos/día = intervalos 8h estándar Binance, [coinalyzeService.js:77](backend/src/services/coinalyzeService.js#L77)). Que sea "improbable" es juicio de mercado, no bug.
- **#3 longs crowded + OI bajando + funding alto** → patrón real de deleveraging con longs atrapados; es exactamente lo que `crowded_trade_flag` (§10) detecta. Señal, no incoherencia.
- **#5 volume_profile valid:false** → by design (D3/P3), el prompt ya tiene fallback.
- **#6 SuperTrend vs trend** → `trend` es compuesto ponderado, SuperTrend es un solo indicador; divergen por diseño (`momentum_alignment` lo captura).
- **#7 regímenes distintos por TF** → normal.
- **#8 order book "demasiado limpio"** → spread $0.01 en SOL spot Binance con depth=20 es realista.

### Fix 1 — CVD `cvd_change_pct_window` explotaba (#4, bug real)

[indicators.js](backend/src/utils/indicators.js) `calculateCVD`: calculaba `(current - prev) / Math.abs(prev) * 100` sobre una **serie acumulativa con signo**. Cuando `prev` (CVD de hace 20 velas) pasaba cerca de cero, el % explotaba a valores sin sentido (+198% con precio -3%) — artefacto de base pequeña, no señal. La IA externa lo detectó por la razón equivocada ("fuente desincronizada") pero el síntoma era válido.

Fix (decisión del usuario: normalizar por volumen): eliminado `cvd_change_pct_window`, añadidos:
- `cvd_delta_window` — delta absoluto de la ventana (`current - prev`).
- `cvd_delta_vs_volume_pct` — `cvdDelta / volumen_total_ventana * 100`, interpretable y comparable entre activos.

Test actualizado en `indicators.test.js`.

### Fix 2 — `onchain`/`etf_flows` null sin razón (#9)

[analysisController.js](backend/src/controllers/analysisController.js): para activos no soportados (on-chain solo BTC; spot ETF solo BTC/ETH) ambos devolvían `null` pelado, indistinguible de un fallo de fetch. Ahora devuelven `{ available: false, unavailable_reason: 'not_supported_for_asset' | 'fetch_failed' }`. El header builder (`buildAnalysisHeader`) ya usa accesos `?.` → inocuo. Tests de integración actualizados (eran `toBeNull`).

### Punto de diseño descartado tras barrido completo — naming snake/camelCase (#3 diseño)

La IA externa alegó mezcla snake_case/camelCase en el payload. Barrido de **todo `backend/src`**: las únicas claves camelCase son config interna (`env.js`), cache (`cacheService.js`) y el *storage interno* de `historyService.js` (`fundingRate`…) — **ninguna llega al payload**. `getHistories()` ([historyService.js:240-250](backend/src/services/historyService.js#L240)) remapea a snake_case en la frontera pública, y el ETF de SoSoValue (`byIssuer` local → `by_issuer` salida) también. El ejemplo que dio la IA (`trend_7d_change`) es snake_case puro y ni siquiera existe literal. Falso positivo, sin cambios.

### Archivos tocados (fixes de datos)

- `backend/src/utils/indicators.js` — `cvd_change_pct_window` → `cvd_delta_window` + `cvd_delta_vs_volume_pct`
- `backend/src/controllers/analysisController.js` — `onchain`/`etf_flows` null-con-razón (`available`/`unavailable_reason`)
- `backend/tests/indicators.test.js` — aserción CVD actualizada
- `backend/tests/integration.test.js` — 2 aserciones onchain/etf actualizadas

169/169 tests siguen pasando. Sin cambios de schema SQLite.

### Revisión del SYSTEM_PROMPT (mismo día) — `v5_0` → `v5_1_data_quality_signals`

Tras los fixes se auditó si el SYSTEM_PROMPT (consumidor real = Claude) cubría los 7 falsos positivos de la IA externa. Conclusión: la mayoría ya estaban cubiertos (FUNDING SEVERITY RULE, FUNDING PERSISTENCE FILTER cubre el patrón crowded-longs+OI-bajando, regla P3 de volume_profile inválido, jerarquía Contexto→Derivados→Volumen→Estructura para SuperTrend vs trend compuesto). La IA externa hacía *auditoría de integridad de datos*; el prompt pide *análisis de mercado* asumiendo dato válido — por eso esos "errores" no se plantean en producción.

Hueco real detectado: el prompt **no consumía** varios campos de calidad añadidos en sesiones recientes. Añadido en `anthropicService.js`:
- **CVD magnitud**: regla nueva que interpreta `cvd_delta_vs_volume_pct` (<2% ruido / 2-8% normal / >8% fuerte), con aviso explícito de no leerlo como %-cambio de precio/volumen.
- **Frescura de derivados**: regla nueva usando `data_timestamp_utc` por sub-bloque vs `price_timestamp_utc` (>30min = contexto no timing; >2h = no trigger; el lag explica contradicciones aparentes funding-precio, no es incoherencia de mercado).
- **Disponibilidad onchain/etf**: actualizado de "ETH/SOL = null, ignorar" al nuevo shape `{available:false, unavailable_reason}`, distinguiendo `not_supported_for_asset` (omitir sin penalizar) de `fetch_failed` (omitir + nota en Risk Score).

`crowded_trade_flag` (§10) se dejó deliberadamente sin referenciar en el prompt: es redundante con el FUNDING PERSISTENCE FILTER (Claude lo deduce igual); se mantiene como campo consultable fuera del LLM.

Archivos: `backend/src/services/anthropicService.js` (prompt + versión), `backend/tests/integration.test.js` (mock prompt_version sincronizado a v5_1). 169/169 tests pasan.

### Validación en vivo + fix de convención del order book — `v5_1` → `v5_2_orderbook_ratio_fix`

El usuario pasó prompt+payload SOL por la IA y el output validó v5.1: la regla de magnitud CVD disparó correctamente (`cvd_delta_vs_volume_pct` 0.45% → "ruido de fondo que NO aporta convicción pese a trend rising"), el FUNDING PERSISTENCE FILTER leyó crowded-longs+OI-cayendo como desapalancamiento (no incoherencia), y onchain/etf/DVOL null de SOL se omitieron sin penalizar. Output disciplinado: ESPERAR, conviction 0.2, derivatives -2.

**Bug real detectado por el LLM de pasada**: *"imbalance_ratio 0.41, sesgo vendedor pese a etiqueta 'balanced'"*. Mismatch de convención prompt↔código:
- Código ([binanceOrderBookService.js:71-84](backend/src/services/binanceOrderBookService.js#L71)): `imbalance_ratio = bids/(bids+asks)` = fracción 0-1, **0.5 neutral**, umbrales 0.60/0.40.
- Prompt B2 (antes): documentaba `ratio > 1.2 / < 0.8` = convención bid/ask con **1.0 neutral**. Bajo esa lógica 0.41 = sell fuerte, chocando con la etiqueta real "balanced".

Fix: prompt B2 alineado al código (convención de fracción explicada, umbrales 0.60/0.40, instrucción de fiarse de `imbalance_signal` categórico y no del ratio crudo). El frontend no usa el campo. PROMPT_VERSION → v5_2. 169/169 tests pasan.

---

## 9. Sesión 2026-06-30 — históricos por coin + backfill desde Coinalyze

### Contexto de partida

Revisión manual de un payload real de `/api/analyze/payload` para SOL detectó varias inconsistencias. Las de mercado (funding extremo + longs dominantes vs estructura 4h/1D bullish, F&G extreme fear vs funding extremo positivo, timeframe_analysis mal caracterizando el conflicto 1h/4h/1D/1W) se documentaron como lectura de mercado, no como bugs. Las de datos sí eran bugs reales:

- `funding_rate.history` con `open_48h == close_current == high_48h == low_48h` (un único punto repetido) pero `trend_48h: "rising"`.
- `open_interest.history.change_7d_pct == change_24h_pct` exacto — mismo síntoma.
- `volume_history.vwap` con `period_min == period_max == current_value`, deltas en 0.

Causa raíz: el servidor llevaba poco tiempo arrancado y `historyService.js` (en memoria, sin persistencia) no había acumulado suficientes puntos — pero el código no nulificaba esos campos con histórico insuficiente, igual que ya hacía `liquidationsSummary` y `cvdSummary`.

### Fix 1 — null-guards en `computeHistorySummaries` (analysisController.js)

`fundingRateSummary`, `openInterestSummary` y `vwapSummary` ahora exigen un mínimo de puntos antes de calcular deltas/tendencias (igual que ya hacían `liquidationsSummary`/`cvdSummary`):
- Funding: `open_48h`/`high_48h`/`low_48h`/`trend_48h` → `null` si hay <2 candles.
- Open Interest: `change_7d_pct`/`trend_7d`/`high_7d_usd`/`low_7d_usd` → `null` si <2 candles; `change_24h_pct` → `null` si <6 candles (24h reales a 4h/candle).
- VWAP: `change_pct_7d`/`change_pct_30d`/`trend_30d` → `null` si <2 puntos.

### Fix 2 — bug de contaminación cross-coin en `historyService.js`

`historyService` guardaba **un único objeto global** para Funding Rate, Open Interest, L/S Ratio, Liquidations, CVD y VWAP — sin partición por coin. Si el usuario miraba BTC y cambiaba a ETH, las series se mezclaban entre monedas. Fear & Greed se dejó como serie global (es un índice de mercado, no por coin — correcto).

Cambio: `historyService.js` reescrito con `coinHistories[coin]` independiente por moneda. Todas las funciones `add*Entry` (excepto `addFearGreedEntry`) y `getHistories()` ahora reciben `coin` como primer parámetro. Actualizados los callers: `coinalyzeService.js`, `dataController.js`, `analysisController.js`.

### Fix 3 — backfill completo en vez de "solo el último candle"

Los endpoints `-history` de Coinalyze (`funding-rate-history`, `open-interest-history`, `liquidation-history`) ya devuelven el rango histórico completo en cada llamada, pero el código solo conservaba el último candle y reconstruía el histórico incrementalmente con cada poll — por eso tras un reinicio el histórico tardaba 48h (funding) / 7d (OI) en rellenarse, aunque Coinalyze ya tenía esos datos.

Cambios en `coinalyzeService.js`:
- **Funding Rate**: vuelca los 8 candles de 48h completos (antes solo el último). `add*Entry` ya hacía upsert por timestamp, así que reenviar candles conocidos es inofensivo.
- **Open Interest**: rango de fetch extendido de 26h → 7d; vuelca los 42 candles de 4h completos. `change_24h_pct` se calcula ahora sobre los últimos 6 candles (24h), no sobre todo el rango.
- **Liquidations**: rango de fetch extendido de 24h → 7d; los candles horarios se agrupan por día calendario UTC para backfillear hasta 7 días de golpe. El día de hoy se sobreescribe con la ventana rolling de 24h (no el día calendario parcial) para mantener coherencia con el valor `current` devuelto por la función.
- **Long/Short Ratio**: ya volcaba el array completo — no requirió cambios, sirvió de referencia del patrón a aplicar al resto.

Verificado en vivo contra la API real de Coinalyze (clave en `.env`) tras un reinicio limpio del backend: Funding Rate 8/8 candles, Open Interest 42/42, Liquidations 7 días con valores reales distintos por día — sin esperar ningún tiempo de acumulación.

### Qué queda fuera de este fix

CVD y VWAP no tienen endpoint externo de histórico (se calculan localmente desde velas de Binance), así que el backfill-desde-API no aplica. Siguen sin persistencia — es el punto 1 de §6, pendiente para la próxima sesión.

### Archivos tocados

- `backend/src/services/historyService.js` — reescrito (partición por coin)
- `backend/src/services/coinalyzeService.js` — backfill completo en las 3 funciones de fetch + rangos extendidos
- `backend/src/controllers/dataController.js` — pasa `coin` a `addCVDEntry`/`addVWAPEntry`/`getHistories`; eliminada variable muerta `prevHistories`
- `backend/src/controllers/analysisController.js` — pasa `coin` a `getHistories`; null-guards en `computeHistorySummaries`

169/169 tests siguen pasando. Sin cambios de schema SQLite en esta sesión.

**Commit:** `abfab36` — "fix: particionar históricos por coin y backfillear desde Coinalyze" — pusheado a `origin/master`.

---

## 12. Sesión 2026-07-02 — persistencia SQLite de TODOS los históricos + summaries gap-aware

### Contexto y decisiones

Continuación directa del punto 1 de §6. El usuario pidió persistir **todos** los históricos, no solo CVD/VWAP. Tras analizarlo se separaron dos motivos distintos y se decidió:

- **CVD / VWAP**: se calculan localmente desde velas de Binance, **sin endpoint externo de histórico** → si el servidor se apaga, ese snapshot se pierde para siempre. Persistir es **obligatorio** y son las únicas que se **hidratan en memoria** al arrancar.
- **Funding / OI / L/S / Liquidations / Fear & Greed**: ya se backfillean frescas desde su API (Coinalyze/alternative.me) en cada poll dentro de la ventana del LLM. Se persisten igual (write-through) para **acumular más allá de esa ventana** (backtesting futuro / job `analysis_outcome`), pero **no se hidratan** en memoria: hacerlo rompería el dedup append-only del backfill (que solo compara el último elemento del array) y es redundante con el re-fetch.

Decisiones acordadas con el usuario vía preguntas:
- **Ventana visible al LLM: sin cambios.** El payload sigue con 48h/7d/30d como hoy; la DB acumula por debajo. Razón: más datos crudos no mejoran el análisis del LLM (lo despistan y suben tokens); los *summaries* ya condensan la señal.
- **Esquema: tabla única genérica** `history_series(coin, metric, ts_key, payload)` en vez de una tabla por métrica. El consumidor es un LLM (JSON) + un futuro job por `analysis_id`, nadie hace SQL analítico tipado sobre estas series → una tabla, un solo mecanismo de upsert/hidratación, menos boilerplate.

### Implementación

- **`config/db.js`**: nueva tabla `history_series` (`coin`, `metric`, `ts_key INTEGER`, `payload TEXT`, PK compuesta) + índice. **No** está en el `DROP TABLE` de migraciones — sobrevive reinicios y redeploys. `ts_key` = epoch seg; métricas por fecha usan medianoche UTC.
- **`services/historyService.js`**: persistencia write-through en las 7 `add*Entry` (upsert idempotente `ON CONFLICT ... DO UPDATE`). `getCoinHistory()` hidrata `cvd`/`vwap` desde DB al crear el coin. Fear & Greed se persiste bajo coin sentinel `'GLOBAL'`. Cache de prepared statements invalidado si cambia la conexión (tests/reinicio). Retención DB 400 días (poda en cada hidratación). Todo el acceso a DB envuelto en try/catch → degrada a memoria-only si la DB no está lista (robusto en tests aislados).
- **`utils/timeSeries.js`** (nuevo, funciones puras): `daysBetweenDates`, `findEntryByDaysAgo` (lookup por fecha real, no por posición), `seriesHasGap`.
- **`controllers/analysisController.js`** — summaries **gap-aware** de CVD y VWAP: referencias 7d/30d por fecha (`findEntryByDaysAgo`) en vez de índice posicional (que con huecos miente), y `change_pct_30d`/`trend_30d` → `null` si `seriesHasGap(history, 3)` detecta un salto >3 días (servidor apagado). Cumple el principio del §6: no fabricar tendencias sobre series con agujeros silenciosos.

### Tests

- **`tests/timeSeries.test.js`** (12): helpers puros — daysBetween, findEntryByDaysAgo (exacto/tolerancia/null), seriesHasGap (contiguo/hueco grande/hueco pequeño/serie corta).
- **`tests/historyPersistence.test.js`** (5): write-through a DB, upsert same-day (no duplica), funding persiste sin hidratar, fear_greed bajo `GLOBAL`, y round-trip de reinicio (resetModules + re-init sobre DB temporal) verificando que CVD/VWAP se hidratan y funding NO.
- **186/186 tests pasan** (169 previos + 17 nuevos).

### Qué queda fuera / notas

- Backfill LSR persiste 168 upserts por poll sin transacción envolvente — trivial para SQLite single-user (WAL), no optimizado. Posible mejora: `synchronous=NORMAL` o batch en transacción si el poll se nota lento.
- La ventana visible al LLM no cambió; si en el futuro se quiere exponer históricos más largos, `history_series` ya los tiene (basta subir los `LIMITS` de hidratación o añadir summaries de ventana larga).
- Sin cambios en el SYSTEM_PROMPT (los campos del payload conservan su shape).

---

## 14. Sesión 2026-07-02 (cont.) — validador determinista §6.4 + fixes varios

Cierre del punto 4 de §6 (validador del output del LLM) más varios fixes encadenados.

### Validador determinista del output (§6.4, ambas fases)

- **`services/analysisValidator.js`** (funciones puras, cero deps):
  - `validateAnalysis(structured)` → `{ warnings: [{rule, severity, message}], hasSevere }`. Comprueba enums (action/confidence), rangos (conviction[0,1], risk_score[1,10], scores[-2,+2] enteros, total numérico), gating⟹Esperar (severe), puertas Comprar/Vender (severe), coherencia has_executable_setup↔setup, dirección setup↔acción (severe si Comprar con setup short o viceversa), TP en el lado correcto, y signo de scores.total sin contradicción flagrante.
  - `applyFailSafe(structured, validation)` → **Fase 2**: si `hasSevere`, devuelve copia con `action="Esperar"`, `has_executable_setup=false`, `setup=null`, `fail_safe_applied=true`, `fail_safe_original_action`, `fail_safe_rules[]` y nota `[FAIL-SAFE] ...` prepend en `executive_summary`. Puro (no muta la entrada). Violaciones **menores** no disparan fail-safe.
- **`controllers/analysisController.js`**: valida SIEMPRE el output crudo (log + persistencia), luego aplica fail-safe si `env.analysisFailsafeEnabled`. El `structured` final (ya degradado si aplicó) es el que se persiste y se devuelve.
- **`config/env.js`**: flag `analysisFailsafeEnabled` (`ANALYSIS_FAILSAFE_ENABLED`, default true). Documentado en `.env.example`.
- **Persistencia**: nueva columna `analyses.validation_warnings` (TEXT, JSON o null), expuesta en `getAnalysisHistory`. Añadida vía migración aditiva idempotente (ver fix de BBDD abajo).
- **Tests**: `analysisValidator.test.js` (24: 19 reglas válido+violación + 5 fail-safe) + 1 integración (Comprar sin puerta → endpoint devuelve Esperar con `fail_safe_applied`).

### Fix de persistencia BBDD — dejar de dropear en cada arranque

`config/db.js` `runMigrations` dropeaba las 4 tablas de análisis en CADA startup (migración pensada como "de una sola vez" pero sin guardar) → borraba todos los análisis IA en cada reinicio, rompiendo la telemetría del validador, el futuro panel de historial y el job `analysis_outcome`. Ahora: schema idempotente (`CREATE TABLE IF NOT EXISTS`) + helper `ensureColumn` (ALTER TABLE ADD COLUMN si falta) para migraciones aditivas sin destruir datos. Sin guard de schema legado (nada desplegado). `history_series` ya estaba excluido del DROP.

### Otros fixes de la sesión

- **Botón "Download data"** (frontend): descarga el JSON completo `{ payload, llm_request }` con el system prompt + user message exactos. `buildLlmRequest()` en `anthropicService` como fuente única (la usa `analyzeMarket()` y el endpoint). "Analizar" ya no auto-descarga.
- **Fix escala funding Coinalyze**: el `value` de `/funding-rate` y `/predicted-funding-rate` YA viene en % (verificado en vivo: 0.01 ⇔ 0.01% de Binance). El código hacía `×100` → inflaba 100× rate_pct/annualized/predicted y disparaba severity/signal/crowded_trade_flag FALSOS. Corregido en `coinalyzeService` (sin ×100; umbrales de signal/trend recalibrados a %); revertido el "fix" anterior del summary que iba en la dirección equivocada.
- **Prompt v5_3_tf_naming_unified**: unificada la nomenclatura de TFs intradía a minúscula (`1h`/`4h`; `1D`/`1W` sin cambios) para casar con las claves reales del dataset.
- **Dev launcher hardening** (`scripts/runSystem.sh`): `start` comprueba puerto ocupado antes de arrancar (rechaza en vez de EADDRINUSE); `stop`/`restart` matan por process-group real (`kill_tree` por PGID, sin dejar huérfanos `node --watch`) + limpieza de huérfanos por puerto; nuevo comando `restart` (CLI) y `r`/`rb`/`rv` (menú).

**216/216 tests pasan.** Commits en `origin/master` (botón download, fix funding, prompt v5_3, fix db persistencia, validador §6.4, launcher).

---

## 15. Sesión 2026-07-02 (cont. 2) — Fase 12 + poller multi-coin + job outcome + panel de resultados

Cierre del bloque frontend/backtesting: el panel de Análisis IA pasa a ser el centro de resultados.

### Fase 12 — panel de historial IA (+ fix del panel en vivo)

- **Panel en vivo roto** (descubierto): tras el Sprint Schema, `runAnalysis` leía `data.recommendation` (inexistente) y `updateRecommendation` usaba el shape viejo → no renderizaba nada. Reescrito al schema `{structured, narrative}`: acción coloreada (español), confianza Alta/Media/Baja, executive_summary, setup (oculto si null), y alertas con fail-safe/gating/scores/driver/riesgo/convicción. CSS `.rec-action.{Comprar,Vender,Esperar,Preparar}`.
- **Modal de historial** (`ui/history.js`): botón "🕘 Historial" en el header. Tarjetas por análisis (acción, confianza, scores, driver/riesgo/precio/F&G/macro, setup, badges gating/conflicto-TF/validation_warnings, resumen). Cierra con Escape/backdrop/botón; se cierra al cambiar de moneda.

### Poller de fondo multi-coin (`services/historyPoller.js`)

La persistencia era request-driven → solo la moneda visualizada acumulaba `history_series`. Crítico para CVD/VWAP (sin backfill externo). Nuevo poller en index.js: cada `HISTORY_POLLER_INTERVAL_SEC` (300s) recorre las 3 monedas y persiste su serie completa + F&G global. Verificado: de 6 → 714 registros. Flags `HISTORY_POLLER_ENABLED`.

### Job `analysis_outcome` (backtesting)

- `utils/outcome.js` (puro): `classifyOutcome` (win/loss/flat/moved) + `evaluateSetupBarrier` (TP1/TP2/stop por barrier method, long/short).
- `services/outcomeService.js`: `runOutcomeJob()` rellena progresivamente precios a 1h/4h/24h/7d (klines históricas de Binance vía `fetchHistoricalClose`/`fetchHistoricalKlines`), outcome direccional, PnL 24h y barrier del setup. Scheduler cada `OUTCOME_JOB_INTERVAL_SEC` (900s) + `POST /api/outcome/run` (manual) + `GET /api/outcome/stats` (win-rate, PnL medio, TP/stop). Flags `OUTCOME_JOB_ENABLED`.
- **Fix aislamiento tests**: `integration.test.js` escribía en la BBDD real (no fijaba `DB_PATH`). Ahora usa fichero temporal + cleanup.

### Panel IA = centro de resultados

- `getAnalysisHistory` hace LEFT JOIN con `analysis_outcome` → cada análisis lleva su resultado (outcome_1h/24h/7d, pnl_pct_24h, setup_outcome, setup_hit_*).
- El modal muestra: **cabecera de backtesting** (evaluados, win-rate 24h, PnL medio, W/L, setups TP/Stop) + por tarjeta, **badges de resultado** por horizonte (win/loss + PnL) y del setup (tp1/tp2/stop), o "Resultado pendiente (≥1h)".
- Verificado end-to-end con outcome inyectado (Comprar → 24h win +5.33%, setup TP1 → win-rate 100%).

### Distinción clave (documentada para no confundir)

- **Validador (§6.4)**: coherencia interna del output con las reglas del prompt (al instante).
- **Job outcome**: acierto real en el mercado a posteriori (backtesting). Ortogonales.

**239/239 tests pasan** (121 indicators + 54 integration + 12 timeSeries + 5 historyPersistence + 4 fundingSummary + 24 analysisValidator + 19 outcome). Todo en `origin/master`.

### Pendiente

Único pendiente mayor: **deploy en la Pi** (Docker listo, falta infra NPM + red proxy). Deuda menor §6: FVGs detallados, SuperTrend level, S/R strength, `volume_history.vwap` top-level.

---

## 16. Auditoría crítica 2026-07-02 — hallazgos a acometer uno a uno

Revisión a dos pasadas del trabajo de las sesiones §9–§15 (código real, no solo docs).
Contexto sano de partida: 239/239 tests pasan, árbol limpio, arquitectura sólida. Los hallazgos
son casos que los tests NO cubren: correctitud metodológica del backtesting, casos límite de
runtime y datos mal etiquetados que llegan al LLM. Ordenados por impacto. Marcar ✅ al cerrar cada uno.

### 🔴 Alta

- [x] **A1 — El backtest del setup no comprueba si la entrada se llenó (bug metodológico). ✅ RESUELTO 2026-07-02.**
  `evaluateSetupBarrier` ahora espera a que el precio TOQUE `entry_price` (fill gating) antes de evaluar TP/stop;
  nuevo outcome `not_triggered` cuando la entrada nunca se llena. +3 tests. Cerrado junto con A4.

  <details><summary>descripción original</summary>
  `evaluateSetupBarrier` ([utils/outcome.js:49](backend/src/utils/outcome.js#L49)) asume el setup lleno
  en el instante del análisis (`tMs`) y desde la 1ª vela solo vigila TP/stop. Pero el SYSTEM_PROMPT define
  la entrada como orden **condicional** (limit/stop-limit, no market — [anthropicService.js:509](backend/src/services/anthropicService.js#L509)).
  Efecto: un long con `entry_price` por debajo del precio que nunca vuelve a ese nivel pero rebota a TP1 se
  cuenta como `tp1` (win) aunque la entrada jamás se llenó; y al revés puede marcar `stop` sobre una posición
  no abierta. **Las stats de setup del panel (`setup_tp`/`setup_stop`, win-rate del setup) están sesgadas** —
  y es justo la vara con la que se pretende juzgar el sistema (§7).
  **Fix:** el barrier debe recorrer velas hasta que `entry_price` se toca y solo entonces empezar a evaluar
  TP/stop; si no se toca dentro del horizonte → nuevo outcome `not_triggered` (distinto de `open`). Tests puros
  nuevos para el gating de entrada (long/short, entrada tocada vs no tocada). Ojo a A4 (finalizar los que expiran).
  </details>

### 🟠 Media

- [x] **A2 — `high_7d`/`low_7d` del CVD se calculan sobre 30 días. ✅ RESUELTO 2026-07-02.**
  `high_7d`/`low_7d` se computan ahora sobre los entries de los últimos 7 días **por fecha** (`daysBetweenDates`),
  robusto ante huecos; `period_min`/`period_max` conservan la ventana completa (30d), que es su semántica honesta.
  El prompt no referencia esos nombres literalmente → sin cambio de versión.

- [x] **A3 — `MAX_TOKENS=4096` sin manejo de truncado → se pierde la llamada pagada. ✅ RESUELTO 2026-07-02.**
  `MAX_TOKENS` subido a 8192 (margen holgado al narrative) y guard `stop_reason === 'max_tokens'` en
  `analyzeMarket` que lanza `AppError 502 UPSTREAM_TRUNCATED` con mensaje claro antes de intentar el parse
  (en vez del engañoso "non-JSON").

- [x] **A4 — Setups `open` se reprocesan indefinidamente. ✅ RESUELTO 2026-07-02.**
  `outcomeService` finaliza al vencer el horizonte 7d: `open`→`expired`, `not_triggered` terminal, geometría
  inválida→`invalid`. Además preserva los valores previos ante un fallo transitorio de fetch (antes los pisaba
  con null). Estados terminales dejan de ser seleccionados por [dbService.js:203](backend/src/services/dbService.js#L203)
  (`setup_outcome IS NULL OR = 'open'`). Frontend: etiquetas legibles para los nuevos estados.

### 🟡 Baja / latente

- [x] **A5 — `response.content[0].text` se rompe si se activa extended thinking. ✅ RESUELTO 2026-07-02.**
  `analyzeMarket` busca ahora el bloque `type === 'text'` con `.find()` (en vez de indexar `content[0]`) y lanza
  `AppError 502 UPSTREAM_PARSE_ERROR` si no hay ninguno o `content` no es array. A prueba de extended thinking.

- [x] **A6 — Bump a Opus 4.8. ✅ RESUELTO 2026-07-03.**
  `MODEL = 'claude-opus-4-8'` en [anthropicService.js:6](backend/src/services/anthropicService.js#L6). Mismo precio
  que 4.7 ($5/$25 por 1M) y más capaz; el output es el producto y el volumen es bajo (single-user, botón manual), así
  que la calidad domina. Swap de model-ID puro — misma superficie de request, sin `thinking`/`temperature` en el código,
  cero breaking changes. Referencias actualizadas en CLAUDE.md, mock de integración y prompt de continuidad.
  **Verificar en vivo:** una llamada real y confirmar que el JSON `{structured, narrative}` sigue parseando limpio
  (con thinking omitido 4.8 a veces escribe más razonamiento en la respuesta; si fallara, el guard 502 lo caza).
  Descartado Sonnet 5: más barato pero es near-Opus en coding/agentic, no en razonamiento de mercado multi-TF.

- [x] **A7 — El backfill in-memory funciona por coincidencia frágil. ✅ RESUELTO 2026-07-02.**
  Nuevo helper `upsertByKey(history, entry, key, limit)` en `historyService.js`: deduplica por clave (`t` o `date`)
  sobre TODO el array, reordena ascendente y recorta a `limit`. Las 7 `add*Entry` lo usan (antes cada una repetía
  el dedup "solo último elemento"). Robusto ante backfills de cualquier tamaño/orden. +1 test que fija el invariante
  (backfill desordenado + duplicado → ordenado y deduplicado).

### 🟠 Segunda revisión crítica 2026-07-03 — 3 hallazgos nuevos (A8–A10), resueltos

Segunda pasada sobre §9–§16 (código, no docs). A1–A5/A7 confirmados genuinamente resueltos en código;
el validador coincide 1:1 con las puertas Comprar/Vender del prompt (sin riesgo de veto falso). Nuevos:

- [x] **A8 — El snapshot diario de CVD tenía la base a la deriva (contamina change/high/low/trend del summary). ✅ RESUELTO 2026-07-03.**
  `historyPoller`/`dataController` persistían `cvd.value` = acumulado sobre una ventana 1D **rodante** (90 velas):
  su origen se desplaza un día por barra, así que comparar `value`s de días distintos mezclaba el forward-delta
  real con los días que caían por detrás de la ventana → `change_pct_7d/30d`, `high_7d/low_7d`, `trend_30d` sesgados
  (creciente con el horizonte). El gap-aware de §12/A2 no lo detectaba: la serie es contigua, no tiene huecos.
  **Fix:** `calculateCVD` expone `last_candle_delta` (delta neto de la última vela, estacionario); `addCVDEntry`
  lo persiste como `delta`; `cvdSummary` reconstruye una serie acumulada con **base única** (`Σ delta`) y calcula
  todo sobre ella (`baseline: 'consistent'`). Fallback al `value` rodante si algún entry es pre-fix (`baseline:
  'rolling_window'`, se autocura en ≤30d). Añadidos `net_delta_7d/30d` (presión neta absoluta, sin el problema de
  %-sobre-base-cercana-a-cero, coherente con la decisión §11). VWAP no sufría esto (rolling 20-period, base fija).
  +2 tests de `last_candle_delta`.

- [x] **A9 — Fuga de reprocesado: `has_executable_setup=1` con `entry_price=null` nunca terminaba. ✅ RESUELTO 2026-07-03.**
  El guard del barrier (`&& setup_entry_price != null`) mandaba ese sub-caso a `preserveSetup` → `setup_outcome`
  quedaba NULL para siempre y `getAnalysesNeedingOutcome` lo re-seleccionaba en cada ciclo indefinidamente (misma
  clase que A4, se escurría). **Fix:** si `has_executable_setup && entry_price==null && horizonElapsed` → marcar
  `'invalid'` terminal.

- [x] **A10 — `evaluateSetupBarrier` confundía fetch vacío con geometría inválida. ✅ RESUELTO 2026-07-03.**
  `bar===null` cubría tanto geometría mala como velas vacías; tras vencer el horizonte marcaba `'invalid'` terminal
  incluso ante un fallo transitorio de fetch. **Fix:** `!candles.length` → `preserveSetup` (reintentar); sólo
  `bar===null` **con velas presentes** cuenta como geometría inválida.

### 🟠 Tercera revisión crítica 2026-07-03 — foco en datos erróneos al LLM (A11–A13), resueltos

Pasada centrada en correctitud de los datos que se envían al LLM (coste innecesario si van sesgados).

- [x] **A11 — `timeframe_analysis` trataba `neutral` como bajista → conflictos FALSOS al LLM. ✅ RESUELTO 2026-07-03.**
  `analyzeTimeframeConflicts` infería la dirección con `!includes('bullish')`, colapsando `neutral`→bajista. Con
  corto `neutral` + largo `bullish` reportaba `conflict='short_term_bearish_long_term_bullish'` y su `reasoning`
  engañoso ("could be a pullback in an uptrend…") — y eso viaja al LLM (`timeframe_analysis`). **Fix:** dirección
  tri-estado (`dirOf`); sólo hay conflicto si AMBOS TFs son direccionales y OPUESTOS. Función exportada + 7 tests
  (`timeframeConflicts.test.js`).

- [x] **A12 — `funding_rate.history.severity_last_candle` ignoraba el lado negativo. ✅ RESUELTO 2026-07-03.**
  Sólo clasificaba umbrales positivos → un candle muy negativo (−0.6%, shorts sobrecargados) se reportaba como
  `'normal'`, contexto engañoso. **Fix:** simétrico con el servicio (`*_short_overload` para negativos).

- [x] **A13 — `fear_greed.trend_30d` espurio con datos finos. ✅ RESUELTO 2026-07-03.**
  Comparaba `at(-1)` vs ancla 30d sin guard: con 1 punto (ancla === actual) reportaba `'deteriorating'` falso, y
  sin banda `'stable'` un F&G plano también salía `'deteriorating'`. **Fix:** `null` si no hay ancla 30d distinta;
  banda `'stable'` ante igualdad.

- [x] **A14 — LSR summary sin guard de longitud (asimétrico con funding/OI). ✅ RESUELTO 2026-07-03.**
  Los campos `*_7d` (`open`/`change`/`avg`/`max`/`min`/`trend`) se calculaban sin `has7d`, a diferencia de funding
  (`has48h`) y OI (`has7d`). Con 1 solo punto (arranque en frío / respuesta parcial de la API) se etiquetaban como
  "7d" un `change=0`/`avg`/`max`/`min` derivados de un único valor → dato espurio al LLM. **Fix:** `has7d = length>=2`
  gatea los `*_7d` a null; `current_*` siempre presente (snapshot "ahora"). +3 tests (`lsrSummary.test.js`).

### Observaciones (no necesariamente accionar)

- Los análisis degradados por fail-safe (Comprar→Esperar) salen del win-rate (`classifyOutcome` da `moved`/`flat`
  para no-direccionales), así que **no se puede medir si el fail-safe acertó al vetar**. Para calibrar la Fase 2
  habría que guardar el outcome contra la acción original.
- `win_rate_24h` excluye `flat` del denominador ([dbService.js:271](backend/src/services/dbService.js#L271)) —
  decisión de diseño razonable, solo conviene tenerlo documentado al leer la métrica.

---

## 17. Sesión 2026-07-03 — bump de modelo + parse robusto + tanda de fixes de UI

Cierre de A6 (modelo) y una cadena de bugs de frontend que salieron al probar en vivo por primera vez.

### Modelo: Opus 4.7 → Opus 4.8 (A6) → Sonnet 5 (temporal) → **selector en el frontend (default Opus 4.8)**

- **Bump a Opus 4.8** (A6): mismo precio que 4.7 ($5/$25 por 1M), más capaz, swap de model-ID puro. Verificado en vivo
  (~$0.20, 51s, JSON limpio).
- **Baja temporal a Sonnet 5** para probar la UI barato (~$0.09/análisis) — ya superado por el selector (abajo).
- **Selector de modelo IA (feature final, cierra el pendiente de A6/revertir):**
  - Whitelist `ANALYSIS_MODELS` en `constants.js`: `[{id,label,cost,disableThinking}]` — Opus 4.8 (~$0.20) / Sonnet 5
    (~$0.09) / Haiku 4.5 (~$0.04). `DEFAULT_ANALYSIS_MODEL = 'claude-opus-4-8'`.
  - `anthropicService.js`: `resolveModel(id)` valida contra la whitelist y cae al default (nunca deja pasar un id
    arbitrario a la API de pago). `buildLlmRequest(context, modelId)` y `analyzeMarket(context, modelId)`. `thinking:
    {type:'disabled'}` **sólo** en modelos con `disableThinking` (Sonnet 5); Opus/Haiku van sin `thinking` (off por
    omisión → evita incompatibilidad con Haiku).
  - `analysisController.analyze`: lee `model` del body y lo pasa a `analyzeMarket`.
  - Frontend: `<select id="model-select">` en el header (estilo `.model-select`), selección **persistida en localStorage**
    (`cryptex_model`), enviada en `postAnalyze(coin, tf, model)`. Cada tarjeta del historial muestra el modelo (badge
    `.hist-model`, vía `analyses.model_used` — añadido `a.model_used` al SELECT de `getAnalysisHistory`).
  - +4 tests (`modelSelection.test.js`, fallback de whitelist). Coste medido: Opus 4.8 ~$0.20 (26.6k in / 2.6-3.6k out),
    Sonnet 5 ~$0.09, Haiku 4.5 ~$0.04.

### Parse robusto — `extractJson()` (permanente, red de seguridad entre modelos)

Sonnet 5 no respeta "JSON puro" pese al prompt: añade preámbulo ("Analizando el dataset...") y envuelve el objeto en
un bloque markdown ```` ```json ````. `JSON.parse` fallaba en pos 0 → `AppError 502`, que el `errorHandler` **devuelve
al cliente sin loguear** (por eso el análisis fallido no dejaba rastro ni en historial ni en log — trampa a recordar).
**Fix:** helper `extractJson()` en `anthropicService.js` (prioridad: bloque fenced con `{` → substring primer `{` a
último `}` → cadena tal cual). Inofensivo con JSON puro (Opus). Exportado + 5 tests (`extractJson.test.js`).
Verificado con replay real a Sonnet 5.

### Frontend — cadena de bugs (salieron al probar el pipeline IA en vivo por primera vez)

Eran bugs **preexistentes** (no del modelo), apilados, cada uno tapaba al siguiente:

1. **Panel en vivo nunca renderizaba** (`sidebar.js`): los divs `#recommendation-content/-loading` se ocultan con
   `style="display:none"` INLINE en `index.html`, pero `showRecommendationLoading`/`updateRecommendation` sólo
   toggleaban la clase `.hidden` (que además lleva `!important`). Quitar una clase no anula un estilo inline → panel
   en blanco, 200 OK, sin error. **Fix:** helpers `showEl/hideEl` que fijan `style.display` explícito además de limpiar
   la clase. (El Historial funcionaba porque usa otro render, `history.js`.)
2. **Resultado fuera de vista**: el panel estaba al fondo de la barra lateral (~2000px). **Fix:** modal + reorden (abajo).
3. **Modal de resultado**: al terminar un análisis se **abre automáticamente el modal de Historial** (`openHistory(coin)`
   en `runAnalysis`) — muestra el análisis recién guardado arriba + los previos, cerrable. El dato sigue también en la
   barra lateral. Feedback en el botón durante la espera: `⏳ Analizando…`.
4. **"Análisis Previo" siempre "—"**: `dataController` leía `lastAnalysis.recommendation_action`/`recommendation_confidence`
   (columnas viejas); el Sprint Schema las renombró a `action`/`confidence`. **Fix** en `dataController.js`.
5. **Reorden de la barra lateral** (`index.html`): "Análisis IA" (actual) + "Análisis Previo" movidos a ser las dos
   primeras secciones, encima de los indicadores (orden presente → pasado).

### Aclaración de métrica (no es bug)

`EVALUADOS` del backtesting cuenta filas de `analysis_outcome`, que sólo existen para análisis con ≥1h de antigüedad
(el job necesita que pase el primer horizonte de 1h). Un análisis recién hecho sale "Resultado pendiente" hasta que
cumple 1h y corre el job (cada 15min). Por eso puede haber 3 análisis y "EVALUADOS 2". `win_rate_24h` sólo cuenta
direccionales (Comprar/Vender) con ≥24h; los `Esperar` salen `flat`/`moved`, no entran en win-rate.

### Estado

264/264 tests. Todo en `origin/master`. El pendiente de A6 ("revertir a Opus 4.8") queda **cerrado** por el selector:
el default ya es Opus 4.8 y el modelo se elige por análisis desde la UI. **Deploy Pi resuelto en §18** (nativo + systemd).

---

## 18. Sesión 2026-07-03 (cont.) — DEPLOY en la Raspberry Pi (nativo + systemd)

### Decisión de arquitectura

Se **descartó Docker + Nginx Proxy Manager** (el plan original) a favor de **nativo + systemd**. Motivos: una sola app, single-user, LAN de confianza, y la Pi **ya corre un asistente en modo kiosko** (Chromium `--kiosk` → `http://localhost:8000`) con el que CRYPTEX convive. Docker+NPM añadía un daemon, rebuilds lentos de `better-sqlite3` arm64 y una pieza extra (nginx) para el `/api`, sin beneficio real. Nativo → migrable a Docker luego sin retrabajo (los `Dockerfile`/`compose` se conservan). Diálogo de decisión: Camino B (puerto alto sin NPM) → nativo.

### Cambio de código habilitante (commit `31f748d`)

- **`app.js`**: en `NODE_ENV=production` y si existe `frontend/dist/index.html`, Express sirve el SPA — `express.static(distPath)` + fallback `app.get(/^(?!\/api|\/health).*/, → index.html)`. Ruta configurable con `FRONTEND_DIST` (default `../../frontend/dist`). **Un solo origen** ⇒ `/api` same-origin, sin CORS ni reverse-proxy. Gated a producción: dev sigue con Vite (:5173), tests sin `dist/` intactos.
- **`security.js`**: `helmet({ contentSecurityPolicy: false })` — el SPA usa atributos `style=` inline que la CSP por defecto bloquearía. App single-user en LAN sin contenido externo ⇒ aceptable.
- **`scripts/deploy.sh`** (nuevo): `build frontend → rsync backend/src + frontend/dist → restart cryptex.service`. Flag `--deps` para `npm ci` (solo si cambió package-lock). Overrides `PI_HOST/PI_DIR/SERVICE/PORT`. **No** sincroniza `.env`.

### Fix de bug preexistente (commit `c1b5de2`)

- **`dataController.js` — `last_analysis: {}`**: `getLastAnalysis()` va dentro del `Promise.allSettled` pero se usaba **sin `resolve()`** (a diferencia del resto de fuentes), devolviendo el objeto settled crudo → `timestamp/action/confidence` `undefined` → `{}`. Rompía el panel "Análisis Previo" del sidebar **desde el rename del Sprint Schema**. Fix: `const lastAnalysisRow = resolve(lastAnalysis)`. Detectado al notar el panel vacío tras el deploy.

### Infra en la Pi (192.168.1.250, user `pi`, aarch64, Bookworm)

- **Node 18.20.8** vía nvm → `/home/pi/.nvm/versions/node/v18.20.8/bin/node`.
- Proyecto en **`/home/pi/cryptex`** (al mismo nivel que el asistente, por `rsync` desde dev — no git clone). Puertos `:80/:3000/:8080` estaban libres (el asistente usa `:8000`).
- `cd backend && npm ci --omit=dev` → `better-sqlite3` compila/corre en arm64 (build tools ya presentes).
- **`/etc/systemd/system/cryptex.service`**: User=pi, `NODE_ENV=production`, `PORT=8080`, `DB_PATH=/home/pi/cryptex/backend/data/cryptex.db`, `Restart=on-failure`, arranque al boot. Las `Environment=` del unit pisan al `.env` (dotenv no sobrescribe `process.env`).

### Migración de datos dev → Pi

Snapshot consistente con **`VACUUM INTO`** (consolida el WAL en un fichero, vía better-sqlite3, sin tocar el original) → transfer → stop servicio → reemplazar `cryptex.db` (borrando `-wal`/`-shm`) → start. Migrado: 7 análisis (3 BTC + 4 SOL), 28 tf_snapshots, 7 outcomes, **747 filas `history_series`** (CVD/VWAP no reconstruibles → por eso se migra en vez de empezar limpio).

### Estado

- **Operativo** en `http://192.168.1.250:8080` desde cualquier equipo LAN. `/health` OK, `/api/data` con datos reales, historial migrado visible. 264/264 tests. Commits en `origin/master`.
- **Pendiente menor**: entrada DNS `cryptex.lan → 192.168.1.250` en el router Zyxel (opcional); deuda §6 (solo queda FVGs detallados). Integración en el kiosko → **resuelta en §19** (iframe).

---

## 19. Sesión 2026-07-03/04 — integración en el kiosko de piAssistant (iframe): 2 fixes de cabeceras

### Contexto

CRYPTEX se embebe ahora en un `<iframe>` dentro del kiosko del asistente (Chromium `--kiosk` → `http://localhost:8000`). Esto cierra el pendiente "integración en el kiosko" de §18. El kiosko (piAssistant) y CRYPTEX son **orígenes distintos** (`localhost:8000` vs `192.168.1.250:8080`), lo que destapó dos cabeceras de seguridad que impedían el embebido. Ambos fixes se hicieron primero **a mano en la Pi** (donde CRYPTEX es solo un directorio por `rsync`, no un repo git) y ahora se llevan al código fuente para que `scripts/deploy.sh` los propague en cada actualización sin repetir la integración a mano.

### Fix 1 — framing (2026-07-03): `frameguard: false`

Helmet emite por defecto `X-Frame-Options: SAMEORIGIN` → el navegador bloqueaba el iframe cross-origin entero (ni se veía). `X-Frame-Options` solo admite `DENY`/`SAMEORIGIN` (no un origen concreto), y la alternativa moderna CSP `frame-ancestors` no sirve aquí porque **la CSP de CRYPTEX está apagada** (el SPA usa `style=` inline, ver §18). Fix: `helmet({ contentSecurityPolicy: false, frameguard: false })` en `security.js`. Aceptable en app single-user en LAN de confianza.

### Fix 2 — CORS (2026-07-04): assets del build no cargaban (página plana)

Con el iframe ya cargando, CRYPTEX salía sin estilos (HTML sí, fondo blanco). El `index.html` del build de Vite referencia sus assets con `crossorigin`:
```html
<script type="module" crossorigin src="/assets/index-….js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-….css">
```
Ese `crossorigin` obliga al navegador a pedir CSS/JS en **modo CORS** con cabecera `Origin: http://192.168.1.250:8080`. El callback de CORS en `security.js` **lanzaba** ante cualquier origen fuera de la allow-list (vacía en producción) → el `throw` se traducía en **HTTP 500** para esos assets → nunca cargaban. (`curl` no lo destapaba porque no manda `Origin`, por eso a mano daban 200.)

Fix: un origen no permitido **no debe lanzar**, solo no añadir cabeceras CORS → `cb(null, false)` en vez de `cb(new Error(...))`. Razonamiento: las peticiones **same-origin** no necesitan cabeceras CORS (el navegador no las exige cuando el recurso es del mismo origen que el documento), y una cross-origin **real** sigue bloqueada por el navegador al faltar `Access-Control-Allow-Origin` → no abre ningún agujero.

| # | Sesión | Bloque | Cambio | Efecto |
|---|--------|--------|--------|--------|
| 1 | 2026-07-03 | `helmet(...)` | `frameguard: false` | El iframe puede embeber CRYPTEX (antes: bloqueado, no se veía nada) |
| 2 | 2026-07-04 | `cors({origin})` | `cb(null, false)` en vez de `cb(new Error())` | Cargan CSS/JS (antes: 500 → página plana sin estilos) |

### Notas

- Ambos cambios en `backend/src/middleware/security.js` (único fichero tocado). 271/271 tests siguen pasando (no dependen de las cabeceras).
- **Si algún día se expone CRYPTEX fuera de la LAN, reconsiderar ambos**: volver a acotar el framing (idealmente CSP `frame-ancestors <origen>` reactivando la CSP con las excepciones para inline styles) y restringir el CORS a orígenes concretos.

---

## 20. Sesión 2026-07-04 — compactar el header para que quepa en la pantalla de la Pi

### Contexto

En la pantalla de la Pi (kiosko), el header no cabía a lo ancho: se cortaba (primero a la mitad de "Download data", luego "Historial", luego "Analizar"). Se compactó el header en 4 pasos incrementales, verificando en la pantalla real tras cada uno.

### Cambios (4 palancas, aplicadas en orden)

1. **Timeframe → desplegable.** Los 4 `<button class="tf-btn">` (`1h`/`4h`/`1D`/`1W`) → un único `<select id="tf-select" class="coin-select">` (reutiliza el estilo del selector de moneda, `4h` `selected`). `syncTfButtons(tf)` fija `sel.value` en vez de togglear `.active`; listener pasa de `click` sobre `.tf-btn` a `change` sobre `#tf-select` (misma lógica: `setState` + `saveCoinState` + `loadData` + `timer.reset`). Eliminadas reglas CSS huérfanas `.tf-buttons` / `.tf-btn`.
2. **Botones secundarios → solo icono.** `Actualizar` (↻), `Download data` (⬇), `Historial` (🕑) pierden el texto; conservan `title` (tooltip) + `aria-label` (accesibilidad). Nueva clase `.btn-icon` (cuadrado, `font-size: var(--fs-2xl)`, `line-height: 1`).
3. **Modelo IA → precio solo al desplegar.** `<option>` con `data-name` + `data-price`. Helper `showPrice(on)`: cerrado muestra solo el nombre (`Opus 4.8`), abierto muestra `Nombre · ~$X`. Se activa en `mousedown`/`focus` (a punto de abrir) y se revierte en `blur`/`change`.
4. **Analizar → solo icono.** `⚡ Analizar` → `⚡` (con `.btn-icon` + `title`/`aria-label`). Estado de carga pasa de `⏳ Analizando…` a solo `⏳` (mantiene el feedback sin texto).

### Ficheros

- `frontend/index.html` — header-left (tf-select) + header-right (4 botones icono + options del model-select).
- `frontend/assets/js/app.js` — `syncTfButtons`, listener TF, bloque `showPrice` del model-select, `runAnalysis` (spinner icono).
- `frontend/assets/css/styles.css` — `.btn-icon` nueva; `.tf-buttons`/`.tf-btn` eliminadas.

### Notas

- Solo frontend; ningún cambio de backend, tests intactos.
- Trade-offs menores aceptados: TF es un clic más (select nativo); el cuadro del model-select se ensancha un instante al abrir (comportamiento nativo del `<select>`, no descuadra).
- Header final: `CRYPTEX · [coin] · [TF] | precio | ↻ ⬇ 🕑 [modelo] ⚡`.

---

## 21. Sesión 2026-07-06 — Sprint Backend Gating: mover cálculo determinista del prompt al backend (`v6_0_backend_gating`)

### Contexto de partida

Una revisión externa (Gemini) del SYSTEM_PROMPT + un JSON de ejemplo puntuó alto la calidad analítica (9.8) y la robustez (9.5), pero bajo en mantenibilidad (6.5): el prompt había acumulado demasiadas reglas de umbral que el LLM tenía que recalcular a mano, con redundancia. Diagnóstico tras cruzar el prompt contra el backend: **la mitad de las críticas ya estaban resueltas** (Sprint Briefing: `severity`, `imbalance_signal`, `volume_profile.valid`, señales on-chain), pero quedaban cálculos deterministas en el prompt que sí convenía mover. Principio del sprint: **el backend precalcula flags, el LLM interpreta**. Neto: ~60 líneas de prompt borradas + 4 cálculos al backend, sin tocar la calidad analítica.

### Fases (todas con tests, suite 271 → 298)

1. **Poda de riesgo cero (solo prompt)** — quitados umbrales numéricos redundantes de funding (`severity`/`severity_negative`) e imbalance (`imbalance_signal`); F1 Macro pasa a consumir `macro.macro_regime` (ya sintetizado en `macroService`, el prompt lo ignoraba). On-chain **intacto**: sus buckets de score no mapean 1:1 con las etiquetas categóricas (`extreme` caería en −1 y −2) → forzarlo crearía colisiones.
2. **Vetos al backend** — nuevo `utils/gating.js` (funciones puras). `computeVetos()` traslada el HARD GATING: AND de 3 condiciones de VETO LONG/SHORT sobre la S/R del **TF primario** (decisión de diseño confirmada con el usuario), exigiendo dato presente (no veta sobre datos ausentes). Bloque top-level `gating` en el payload; el prompt obedece `gating.veto_long/veto_short`. El veto del backend es **autoritativo** al persistir (`buildAnalysisHeader` hace OR con el flag).
3. **Contradicciones al backend** — `computeContradictions()` precalcula 5 de las 6 del CONVICTION DECAY (`gating.contradictions[]` + `contradiction_count`); la 6ª (Volume<0 con Structure>0) la suma el LLM (depende de sus scores). Nuevo campo de salida `structured.missing_confirmations[]` (idea del auditor: explicación legible de por qué NO se opera), **persistido** como columna JSON `missing_confirmations` en `analyses` (`ensureColumn`, decisión del usuario) y devuelto por `getAnalysisHistory`.
4. **SMC `signal_status`** — `calculateSMC` anota `active/context/expired` por BOS/CHoCH y FVG (sub-umbral `ACTIVE_CANDLES_AGO_BY_TF` + mitigación). Borró el bloque de decay más grande del prompt (~35 líneas, 4 tablas por-TF).
5. **Flags baratos** — `cvd.cvd_strength`, `vwap.price_vs_vwap`, `volume_profile.price_vs_poc`+`excursion` en `indicatorService`; `liquidation_clusters.magnetic_long/short_zone_active` en `liquidationClustersService`. El prompt lee los flags.
6. **Cierre** — `PROMPT_VERSION` → `v6_0_backend_gating`; verify end-to-end contra `/api/analyze/payload` con datos reales (gating, contradictions y todos los flags poblados); docs (CLAUDE.md + este §21).

### Ficheros tocados

- `src/utils/gating.js` (**nuevo**) — `computeVetos`, `computeContradictions`, `nearStrongLevel`.
- `src/controllers/analysisController.js` — cablea `gating` (vetos + contradicciones) al payload; veto autoritativo + `missing_confirmations` en `buildAnalysisHeader`.
- `src/services/anthropicService.js` — poda del prompt (Cubo A, decay SMC, umbrales de flags) + secciones reescritas para leer flags + `missing_confirmations` en OUTPUT FORMAT; `PROMPT_VERSION`.
- `src/services/indicatorService.js` — `cvdStrength`/`priceSide` helpers + flags en cvd/vwap/volume_profile.
- `src/utils/smc.js` — `signal_status` en `calculateSMC`.
- `src/services/liquidationClustersService.js` — flags `magnetic_*_zone_active`.
- `src/config/db.js` + `src/services/dbService.js` — columna `missing_confirmations` (CREATE + `ensureColumn` + INSERT + SELECT).
- Tests: `gating.test.js` (nuevo, 20) + SMC/flags en `indicators.test.js` + `gating`/`missing_confirmations` en `integration.test.js`.

### Notas

- **Migración `missing_confirmations`**: `ensureColumn` idempotente; filas viejas → NULL. No requiere acción en la Pi más allá del deploy normal.
- El LLM ya recibía en vivo todo lo que ahora se precalcula; el cambio reduce su carga de cálculo (interpreta flags) y **elimina la divergencia** umbral-en-prompt vs umbral-en-código. La decisión final del análisis no cambia de naturaleza.
- **Pendiente de decidir** (no bloqueante): si se quiere, `analysisValidator` podría cruzar el `action` del LLM contra `gating.veto_*` como regla dura adicional (hoy el veto es autoritativo solo en la persistencia de `gating_active`, no fuerza el `action`). El prompt sí instruye ESPERAR ante veto. → **RESUELTO en §21.1.**

### 21.1 Revisión crítica post-sprint (2026-07-06) — 3 hallazgos resueltos

Revisión exhaustiva del sprint (diff vs código vs prompt, doble pasada). El sprint estaba sólido y coherente (flags del prompt existen en el payload, estructuras que asume `gating.js` presentes, `gating` se serializa al LLM, persistencia completa), pero salieron 3 puntos:

- **🔴 El veto del backend no forzaba la *acción*, solo la columna persistida.** El fail-safe (`applyFailSafe`) se guiaba por el `gating_active` **auto-reportado del LLM**, no por `context.gating.veto_*`. Escenario de fallo: backend `veto_long=true` + LLM desobedece (`Comprar`, `gating_active=false`, scores que pasan `buy_gate`) → ningún warning severo → se persistía y devolvía `Comprar` con `gating_active=1` (registro contradictorio) + setup long vivo que el job de outcome backtestearía. El "HARD GATING" quedaba a medias: dependía del cumplimiento del LLM, que era justo lo que el sprint pretendía eliminar. **Fix:** en el handler `analyze()`, si `veto_long||veto_short`, se impone `gating_active=true` (+ `gating_reason` del backend) sobre el `structured` **antes** de `validateAnalysis` → el validador dispara `gating_forces_wait` (severo) → fail-safe degrada a `Esperar` y neutraliza el setup. OR redundante de `buildAnalysisHeader` eliminado (ya no hace falta). Verificado end-to-end con el caso concreto. *(Nota §22: esta lógica se extrajo luego a `services/decisionGates.js::applyDecisionGates` y se desacopló del flag `ANALYSIS_FAILSAFE_ENABLED`.)*
- **🟡 Contradicción `no_active_smc_structure` más laxa que el prompt.** El comment/detail decían "fuera del umbral **táctico**" pero la condición (`!last_bos && !last_choch`) medía la ventana de **contexto** (ancha), porque `detectLastBOS/CHoCH` descartan con `MAX_CANDLES_AGO_BY_TF`, no con `ACTIVE_`. Una señal `signal_status="context"` suprimía la contradicción que el prompt sí contaría. **Fix:** ahora exige `signal_status="active"` en `last_bos` o `last_choch`; null (ausente) o `context` cuentan como contradicción. +2 tests (context cuenta / active suprime).
- **🟢 `contradiction_count` determinista no se persistía** (el LLM persistía su `contradictions_found` booleano). **Fix:** columnas `contradiction_count INTEGER` + `contradiction_codes TEXT` (JSON de códigos) en `analyses` (CREATE + `ensureColumn` idempotente + INSERT + SELECT), mapeadas desde `context.gating` en `buildAnalysisHeader`, devueltas por `getAnalysisHistory`. Telemetría backend vs LLM. +1 assertion de integración.

**Ficheros:** `analysisController.js` (inyección veto + mapeo contradicciones), `utils/gating.js` (condición #6), `config/db.js` + `dbService.js` (2 columnas), `CLAUDE.md`. Tests: `gating.test.js` (20→22), `integration.test.js` (+1 assertion). Suite **298 → 300**.

**Migración en la Pi:** `ensureColumn` idempotente para `contradiction_count`/`contradiction_codes`; filas viejas → NULL. Sin acción manual, se aplica en el deploy normal al arrancar.

---

## 22. Sesión 2026-07-06 (cont.) — Segunda revisión crítica del Sprint Backend Gating: 6 hallazgos resueltos

Revisión exhaustiva a petición del usuario ("no se nos haya escapado algún error o incoherencia"), tras §21.1. El sprint estaba sólido (300 tests, condiciones del código fieles al prompt original verificadas contra `dc2f887^`), pero salieron 6 cosas. Todas resueltas. Suite **300 → 314**.

- **🟠 1. La autoridad del "hard veto" estaba acoplada a `ANALYSIS_FAILSAFE_ENABLED`.** El fix de §21.1 hacía el veto autoritativo *a través del fail-safe*, pero `applyFailSafe` solo corre si el flag está activo — y ese flag existe para *observar el output crudo del LLM*. Apagarlo para depurar desactivaba en silencio la autoridad del veto, reintroduciendo el escenario de §21.1. **Fix:** extraída la lógica a `services/decisionGates.js::applyDecisionGates` (función pura, testeable sin DB/red), con **dos niveles**: (a) hard gates backend-autoritativos (veto + conviction decay) fuerzan Esperar SIEMPRE; (b) violaciones de reglas del prompt (buy/sell gate, etc.) degradan solo bajo el flag. El controller la invoca; imports `validateAnalysis`/`applyFailSafe` movidos allí.
- **🟠 2. El fix headline de §21.1 no tenía test end-to-end.** `gating.test.js` era puro unit de `gating.js`; el test de fail-safe en integración disparaba por `buy_gate`, otra regla. **Fix:** nuevo `decisionGates.test.js` (8 tests) que cubre el cableado veto→acción y decay→acción, incluido **con el fail-safe apagado** (la regresión que nadie testeaba). Construir el contexto veto-positivo a través del controller real exigiría fabricar candles con CVD/S-R específicos; testear la función pura da cobertura determinista del mismo cableado.
- **🟡 3. `contradiction_codes` se persistía pero nunca se leía.** El `SELECT` de `getAnalysisHistory` devolvía `contradiction_count` pero no `contradiction_codes` (write-only), pese a que §21.1 decía "devueltas por getAnalysisHistory". **Fix:** añadida `a.contradiction_codes` al SELECT.
- **🟡 4. Comentario/docs referenciaban un `runAnalysis` inexistente en el backend.** El handler se llama `analyze()`; `runAnalysis` solo existe en el frontend (`app.js`) → grep confuso. **Fix:** comentario en `analysisController.js` + referencias en `CLAUDE.md`/`SESSION_STATE §21.1` corregidas a `applyDecisionGates`/`analyze()`.
- **🟢 5. `computeContradictions` #6: el guard `if (smc)` invertía la intención.** Si `smc===null` (ni BOS ni CHoCH ni FVG — el caso *más* fuerte de "sin estructura activa"), la contradicción se **omitía**. Inalcanzable en la práctica (con ≥10 velas `unmitigated_fvgs` es truthy), pero la lógica iba al revés. **Fix:** guard por `pTf`; `smc===null` cuenta como contradicción con detail propio. +1 test en `gating.test.js`.
- **🟢 6. La 6ª contradicción (conviction decay ≥3) era advisory, no enforced** — asimétrica con el veto ya endurecido. El prompt exige ESPERAR con ≥3 contradicciones. **Fix:** `validateAnalysis(structured, { backendContradictionCount })` cierra el conteo determinista (5 del backend + la 6ª, `volume<0 & structure>0`, que depende de los scores del LLM que aquí sí tenemos) y emite `conviction_decay_forces_wait` (severo) → hard gate en `applyDecisionGates`. +5 tests en `analysisValidator.test.js`.

- **🟢 Nit cosmético.** Tras degradar a Esperar, `missing_confirmations` podía quedar `[]` (el LLM dijo "setup ejecutable") contradiciendo la acción. **Fix:** `applyFailSafe` rellena `missing_confirmations` con el motivo del bloqueo (`fail_safe_rules`) cuando el LLM lo dejó vacío; si ya traía confirmaciones pendientes, se respetan. +2 tests.

**Ficheros:** `services/decisionGates.js` (**nuevo**), `services/analysisValidator.js` (regla decay + `opts` + coherencia `missing_confirmations`), `controllers/analysisController.js` (usa `applyDecisionGates`), `services/dbService.js` (SELECT), `utils/gating.js` (guard #6), `CLAUDE.md`. Tests nuevos: `decisionGates.test.js` (8) + decay/missing_confirmations en `analysisValidator.test.js` (7) + smc-null en `gating.test.js` (1). Suite **300 → 316**.

**Sin cambios de esquema DB** → nada nuevo que migrar en la Pi respecto a §21.1. Solo deploy normal.

---

## 23. Sesión 2026-07-07 — Sprint Remediación Auditoría Red-Team: 17 hallazgos en 5 fases (`v6_0` → `v6_4`)

### Contexto de partida

A petición del usuario, auditoría independiente en modo "red team" (postura escéptica: intentar demostrar que el sistema está equivocado/es inconsistente/sesgado), apoyada en el código real, no solo en la doc. Salieron **17 hallazgos** agrupados en tres fallos estructurales: **(1) circularidad de validación** — las puertas Comprar/Vender se validan contra los scores que el propio LLM se auto-asigna, a `temperature` por defecto (1.0); **(2) confluencia inflada** por variables correlacionadas y doble conteo (CVD/VolumeDelta/OBV; Structure↔Execution; veto↔contradicciones); **(3) backtesting no concluyente** (muestra minúscula sin IC, sesgo de selección, evaluación asimétrica). Más un bug de guardrail: el BTC Dominance Override se alimentaba del trend del alt, no de BTC.

**Decisiones de alcance (confirmadas con el usuario vía `AskUserQuestion`):** scores → *guardia de divergencia* (el LLM sigue primario pero deja de ser incontrovertible; NO se reescriben los 4 scores como autoritativos); backtesting → *integridad estadística* (n mínimo + Wilson + fill-rate + fuente de precio unificada; NO R-múltiplos/fees en este alcance); entrega → *por fases priorizadas*, cada una con tests y commit propio. Plan en `~/.claude/plans/dise-a-un-plan-de-sharded-feigenbaum.md`. Suite **316 → 364**.

### Fase 0 — Evidencia (sin tocar comportamiento)

`backend/scripts/auditStats.mjs` (**nuevo**, read-only, patrón `dbStats.mjs`): distribución de `action`, frecuencia de `contradiction_codes`/vetos, muestra real del backtest, fill-rate de setups, cruce B3 ETF×funding. La BD local confirmó el sesgo empíricamente: **100% Esperar, 0 direccionales**. Golden de `/api/analyze/payload` (BTC/ETH/SOL) guardado como referencia de regresión.

### Fase 1 — Quick wins (C1, C3, M3)

- **C1 · Temperatura no fijada (Crítica).** `analyzeMarket` llamaba a la API sin `temperature` → default 1.0 → decisiones no reproducibles. Fijada `env.analysisTemperature` (default 0, `ANALYSIS_TEMPERATURE`), propagada por `buildLlmRequest`. Ningún modelo de `ANALYSIS_MODELS` envía `thinking:enabled` (Sonnet 5 lo *desactiva* explícitamente; Opus/Haiku no lo usan) → la Messages API acepta `temperature≠1` en los 3. Verificado en vivo (`llm_request.temperature: 0`).
- **C3 · BTC Dominance Override con el activo equivocado (Crítica).** El prompt inferia la estructura de BTC de `technical["1D"].trend`, que en ETH/SOL es el trend del **alt**. Nuevo `buildBtcContext(coin, technical)` → bloque `btc_context {trend_1d, trend_1w, source}` (`source:'self'` para BTC sin fetch extra; `'btc_klines'` para alts vía `fetchOHLC('BTC',...)`+`computeIndicators`, degraded-safe). Prompt corregido para leer `btc_context.trend_1d`. Verificado: BTC `bearish` 1D/1W en vivo → el override ahora se alimenta del dato correcto.
- **M3 · Parse/schema (Media).** `extractJson` usa `firstBalancedObject` (escaneo balanceado de llaves que ignora `}` en strings JSON y prosa posterior) en vez del `slice(first,last)` greedy. `assertStructuredShape` lanza `AppError 502 UPSTREAM_SCHEMA_ERROR` si faltan campos requeridos (antes se persistían `undefined`).

### Fase 2 — Consistencia del gating (`utils/gating.js`) (H1–H4, M4)

- **H3 · Vetos LONG/SHORT SIMÉTRICOS.** Ambos sobre los mismos ejes: CVD 1D (divergencia contraria) + OI sin expandir + S/R fuerte (3+ toques) del TF primario. Se **retiró** la condición de funding asimétrica del veto short (marcaba "no favorable" con funding *normal* y lo desactivaba con crowding bajista — al revés). `computeVetos` ya no recibe `funding`.
- **H2 · FAIL-CLOSED ante datos ausentes.** `computeVetos` reporta `data_insufficient` + `missing_inputs[]` si falta CVD 1D u OI (ejes compartidos). `applyDecisionGates` bloquea trades **direccionales** (degrada a Esperar) cuando `data_insufficient` — antes la ausencia dejaba vía libre justo cuando el contexto es más incierto. Flag `GATING_FAIL_CLOSED_ON_MISSING` (default true).
- **H1 · Ausencia de estructura ≠ contradicción.** `no_active_smc_structure` (near-always-on → sesgo estructural a Esperar) se elimina; la falta de estructura activa va a `missing_structural_confirmation` (alimenta `missing_confirmations`, no el conteo). Solo un **conflicto** activo (`smc_structural_conflict`: BOS y CHoCH ambos `active` y opuestos) cuenta. Además `price_near_key_level` exige nivel con **2+ toques**. Verificado en vivo: **SOL `contradiction_count` 4→3** (desaparece la contradicción espuria, quedan 3 conflictos genuinos).
- **H4 · Dedupe veto↔contradicciones.** Nuevo orquestador `computeGating`: si un veto está activo, no recuenta como contradicciones independientes los hechos que lo construyeron (`cvd_1d_divergence`, `price_near_key_level`). Expone `contradictions_raw_count` + `deduped_by_veto`. El controller pasa de spread `computeVetos`+`computeContradictions` a llamar `computeGating`.
- **M4 · 6ª contradicción simétrica** en el validador: cuenta el conflicto Volume↔Structure en **cualquier** dirección (antes solo `volume<0 ∧ structure>0`).

### Fase 3 — Integridad del scoring (C2, C4, H5, B2)

- **C2 · Guardia de divergencia de scores.** `utils/expectedScores.js` (**nuevo**): `expectedDerivativesScore` (funding severity/negative + LSR signal) y `expectedVolumeScore` (buy_pressure_pct taker + imbalance_signal) → score coarse `-2..+2` con `basis[]`. `computeExpectedScores` se inyecta en `context.expected_scores`. El validador emite `score_divergence_<block>` (severe → fail-safe degrada) cuando el LLM abre la puerta (Comprar con block≥1 / Vender con block≤−1) pero el dato lee **claramente lo opuesto** (esperado con signo contrario, |·|≥1). La puerta deja de validarse solo contra el auto-reporte del LLM (cierra la circularidad). Conservador por diseño (solo signos opuestos claros); se persiste el esperado para calibración. Verificado: BTC `expected derivatives −1` (LSR contrarian-bear) → un Comprar bullish lo dispararía.
- **C4 · Reducción de doble conteo (prompt).** Volume Flow: CVD (taker_real) es señal **primaria**; VolumeDelta/OBV pasan a confirmación/desempate (correlacionados por construcción, no 3 votos). Structure Score se ancla en estructura de precio/niveles (SMC, S/R, Volume Profile) y **NO** re-puntúa los osciladores que ya cuenta Execution (`technical[tf].trend` es momentum, no estructura).
- **H5 · Dead-bands en `computeTrend`.** `signWithDeadband(diff, band)` neutraliza cruces marginales (MACD con banda relativa al 2% de su escala; WT ±2; StochRSI ±3) → mata el flicker sub-tick que volcaba ±1. No es histéresis temporal (requeriría estado por-TF que el render-bajo-demanda no arrastra) pero elimina el flicker de borde dominante.
- **B2 · `score_total` reproducible.** `backendScoreTotal` pondera los componentes del LLM con la jerarquía declarada (Deriv 0.35 > Vol 0.30 > Struct 0.25 > OnChain 0.10, renormalizada si falta on-chain) → cifra auditable persistida en paralelo al total libre del LLM.
- **Columnas nuevas** (`ensureColumn`): `score_total_backend`, `score_derivatives_expected`, `score_volume_expected`.

### Fase 4 — Integridad del backtesting (C5, M1, M2, H6)

- **C5 · Estadística honesta.** `utils/stats.js` (**nuevo**): `wilsonInterval(wins, n)`. `getOutcomeStats` reporta win-rate **solo con muestra direccional ≥ 20** (`MIN_DIRECTIONAL_SAMPLE`); por debajo → `win_rate_24h=null` + `sample_insufficient=true` (antes: 50% sobre n=2 como si fuera medida). Añade `win_rate_ci_low/high` (Wilson), `directional_n`, y **segmentación** por `primary_tf` y `model_used` (no mezclar poblaciones). Frontend (`history.js`): muestra el IC 95% y "muestra insuficiente (n/min)" en vez de un % engañoso.
- **H6 · Fill-rate + sanidad de setups.** `setup_fill_rate = filled/(filled+not_triggered)` → los setups alucinados que nunca se llenan **cuentan** en vez de evaporarse. El validador marca `setup_entry_far` (entry >8% del precio) y `setup_low_rr` (R:R tp1/stop <1) como warnings *minor* (telemetría, no degradan).
- **M2 · Baseline anclado a klines.** El outcome usaba `price_current` (ticker CoinGecko) como baseline mientras los horizontes vienen de klines Binance → sesgo de fuente. `processAnalysis` ancla `price_at_analysis` al close de la vela de 1m del instante del análisis (misma fuente, una vez; reutilizado en ciclos siguientes; fallback `price_current`). `getAnalysesNeedingOutcome` SELECT ampliado con `o.price_at_analysis`. Verificado: el job procesó las 7 filas sin error.
- **M1 · Magnitud/deadband.** El deadband `0.3%` de `classifyOutcome` se mantiene (alcance "integridad estadística"). **Deuda anotada:** PnL en R-múltiplos, fees/slippage y baseline de coste de oportunidad para `Esperar` (alcance "completo", sprint futuro).

### Fase 5 — Menores + docs (B1, B3)

- **B1 · ANTI-DOUBLE-COUNT RULE (prompt).** Funding/LSR/F&G/ETF son facetas correlacionadas del mismo crowding; el LLM no debe sumarlas como confirmaciones independientes — la confluencia real exige bloques distintos (estructura+volumen+derivados).
- **B3 · Término de interacción ETF×Funding.** Pasa de un `±0.5` numérico **sin respaldo cuantitativo** a una señal **cualitativa** (nota explícita de que la magnitud no está validada; `auditStats.mjs` es la herramienta para validarlo/retirarlo con la BD real de la Pi).
- **Docs.** `CLAUDE.md`: entrada del sprint; **corregida la afirmación engañosa** de que la convergencia de los 3 modelos en Esperar prueba robustez (es artefacto del gate, H1); recuento de tests.

### Ficheros tocados

- **Nuevos:** `backend/scripts/auditStats.mjs`, `src/utils/expectedScores.js`, `src/utils/stats.js`, `tests/expectedScores.test.js`, `tests/stats.test.js`.
- **Backend:** `services/anthropicService.js` (temperatura, extractJson/assertStructuredShape, prompt v6_1→v6_4), `controllers/analysisController.js` (btc_context, computeGating, expected_scores, mapeo de columnas), `utils/gating.js` (reescrito: vetos simétricos, fail-closed, H1, computeGating), `services/decisionGates.js` (data_insufficient + divergencia + currentPrice), `services/analysisValidator.js` (divergencia, sanidad de setup, 6ª simétrica), `services/indicatorService.js` (signWithDeadband + dead-bands), `services/dbService.js` (Wilson/segmentación/fill-rate + INSERT columnas + baseline SELECT), `services/outcomeService.js` (baseline klines), `config/env.js` (2 flags), `config/db.js` (3 columnas).
- **Frontend:** `assets/js/ui/history.js` (IC/muestra insuficiente/fill-rate).
- **Tests actualizados:** `gating.test.js` (reescrito), `decisionGates.test.js`, `analysisValidator.test.js`, `indicators.test.js`, `integration.test.js`, `modelSelection.test.js`, `extractJson.test.js`.

### Notas de despliegue

- **Migraciones** (`ensureColumn` idempotente, filas viejas → NULL): `score_total_backend`, `score_derivatives_expected`, `score_volume_expected`. Ya aplicadas y verificadas en la BD local; se aplican en el deploy normal.
- **Flags nuevos en `.env`** (defaults ya preservan/mejoran comportamiento, así que funcionan sin tocar el `.env` de la Pi): `ANALYSIS_TEMPERATURE=0`, `GATING_FAIL_CLOSED_ON_MISSING=true`. Recordatorio: el `.env` de la Pi se gestiona a mano (no lo sincroniza `deploy.sh`).
- **`PROMPT_VERSION`** `v6_0_backend_gating` → `v6_4_correlation_notes`.
- **Git:** los 6 commits (Fases 0-5) se unificaron en `master` por fast-forward (historial lineal, sin merge commit) y se subieron a `origin/master`; la rama temporal `fix/audit-remediation` se eliminó (local + remota) a petición del usuario. **364/364 tests.**

---

## 24. Sesión 2026-07-07 (cont.) — hotfix producción: `temperature` deprecado por los modelos actuales

### Síntoma

Tras desplegar a la Pi el Sprint Remediación (§23), el **primer análisis real** desde la UI devolvía en el panel de IA:

```
Error: Internal server error
```

El mensaje genérico ocultaba la causa real, que solo se veía en `journalctl -u cryptex`:

```
BadRequestError: 400 {"type":"invalid_request_error",
  "message":"`temperature` is deprecated for this model."}
  at analyzeMarket (…/anthropicService.js:890)
```

### Causa raíz

El fix **C1** del Sprint Remediación (§23, Fase 1) fijaba `temperature: 0` en la llamada a la Messages API "para reproducibilidad", partiendo de la premisa de que los 3 modelos aceptaban `temperature≠1` por no usar `thinking:enabled`. Esa premisa **quedó obsoleta**: los modelos de la generación actual (**Opus 4.8 / Sonnet 5 / Haiku 4.5**, familia Claude 5) han **deprecado el parámetro `temperature`** y la API responde **400** si se envía — independientemente del valor. Resultado: **todos los análisis fallaban en producción**. No se detectó en local porque no se relanzó un análisis tras la C1 (los tests mockean el SDK y solo verificaban que el campo se construía, no la aceptación de la API).

### Fix — `temperature` pasa a opt-in (default: omitido)

- **`config/env.js`** — `analysisTemperature` default **`null`** (antes `0`). Solo toma valor si `ANALYSIS_TEMPERATURE` se define explícitamente y es válido `[0,1]` (escape hatch para un futuro modelo que sí lo acepte).
- **`services/anthropicService.js`**:
  - `buildLlmRequest` **omite** el campo `temperature` cuando `env.analysisTemperature == null` (spread condicional, mismo patrón que `thinking`).
  - La llamada `client.messages.create()` solo incluye `temperature` si viene definido: `...(temperature != null ? { temperature } : {})`.
- **`tests/modelSelection.test.js`** — el bloque que exigía `temperature === 0` en los 3 modelos ahora exige que **se omita** por defecto (`toBeUndefined()` + `env.analysisTemperature === null`).

### Verificación

- **364/364 tests** pasan tras el cambio (mismo recuento; solo cambió la aserción).
- Desplegado con `./scripts/deploy.sh` (build + rsync + restart systemd, health OK).
- **Análisis real end-to-end** contra la Pi (`POST /api/analyze` SOL/4h, Sonnet 5): respuesta `structured` completa (`action: Esperar`, gating, scores) en ~49s. El 400 desapareció.

### Notas

- **`.env` de la Pi:** no requiere tocar nada. El default `null` ya omite el parámetro; si en el `.env` de la Pi quedó `ANALYSIS_TEMPERATURE=0` de la nota de despliegue de §23, conviene **quitarlo o comentarlo** (con `=0` explícito se reintroduciría el 400). Recordatorio: `deploy.sh` no sincroniza el `.env`.
- **Observación menor (no bloqueante):** en los logs de la Pi aparecen `timeout of 8000ms exceeded` puntuales en Coinalyze (L/S ratio, liquidaciones) → degraded mode devuelve `null`, no rompe. Si se vuelve frecuente, subir el timeout de Coinalyze.

---

## 25. Sesión 2026-07-10 — revisión crítica en profundidad previa a la 2ª auditoría (`v6_4` → `v6_5_block_dedup`)

### Contexto

Acabábamos de pasar el Sprint Remediación (§23) y su hotfix (§24). El usuario pidió una **revisión crítica con ojos de red-team** de lo implementado, para llegar a la 2ª auditoría "sin errores ya tratados no corregidos". Revisión de toda la superficie (gating, decisionGates, expectedScores, validador, anthropicService, outcome/backtesting, indicatorService, SMC, migraciones), verificando además contra la referencia real de la API el claim de deprecación de `temperature`.

### Hallazgos de la revisión

**Sólido (sin acción):** cableado veto→acción autoritativo antes de validar (cierra la circularidad), fail-closed H2, dedupe H4, vetos simétricos H3, IC de Wilson + gate de muestra (C5), `extractJson` balanceado (M3), migraciones idempotentes. Los niveles S/R **sí** llevan `touches` (si no, los vetos estarían muertos silenciosamente — comprobado).

**H1 (ALTO, solo doc) — C1 desfasado en el changelog.** El fix de temperatura se revirtió en §24 (opt-in / omitido), pero CLAUDE.md seguía afirmando "Fijada default 0 … la API acepta temperature≠1" — falso en ambas mitades. Y el objetivo de fondo (reproducibilidad) **no se cumple**: al no poder enviar `temperature`, los análisis corren con el sampling por defecto del modelo. Un auditor pillaría la contradicción doc↔código.

**H2 (MEDIO) — guardia de volumen C2 casi inerte.** `expectedVolumeScore` derivaba el score de `buy_pressure_pct`, que `calculateVolumeDelta` acumula sobre TODA la ventana del TF (168–180 velas) → pegado a ~50 → el término redondeaba a 0 casi siempre → la guardia de divergencia de volumen (C2) prácticamente nunca se disparaba: no daba el chequeo independiente que prometía, y cuando saltaba chocaba con la doctrina de absorción del propio prompt ("precio↑ + CVD↓ = absorción ALCISTA"). El brazo de **derivados** de C2 sí era útil (funding/LSR extremos).

**H3 (BAJO) — churn del backtest + apilamiento de contradicciones por correlación en la ruta sin veto.**

### Cambios aplicados (opción elegida por el usuario en cada hallazgo)

- **H1 — CLAUDE.md §changelog C1 reescrito** para reflejar la realidad: `temperature` deprecado (400) en los modelos actuales, se OMITE, reproducibilidad NO garantizada a nivel de API (limitación conocida, C1 no cerrado del todo).
- **H2 — guardia de volumen C2 reenganchada al CVD del TF primario** (`utils/expectedScores.js`, **opción b**): `expectedVolumeScore(cvd)` usa `technical[primaryTf].cvd` (`trend`/`divergence`/`cvd_strength`/`source`). **CARVE-OUT de absorción**: ante `divergence != "none"` se **abstiene** (score 0) — la divergencia CVD↔precio es la lectura de absorción que el prompt considera alcista; solo puntúa el caso ALINEADO (agresión/FOMO alcista o capitulación/distribución bajista), donde el signo del flujo es inequívoco. `marginal`/sin strength → 0. `source=heuristic` limita a ±1. `computeExpectedScores` pasa a leer el CVD (ya no el order book). Tests reescritos.
- **H3a — churn del backtest acotado** (`services/outcomeService.js`): un setup con `has_executable_setup=1` pero `setup_entry_price` nulo (geometría irreconstruible y **permanente** — la columna se fija en el análisis y nunca se rellena) se marca `setup_outcome='invalid'` **de inmediato** en vez de esperar al horizonte de 7d re-evaluando el barrier en balde cada ciclo. **Test nuevo** `tests/outcomeService.test.js` (4 tests: `runOutcomeJob` con mocks ESM de coingecko/dbService — invalid inmediato, preservación, y contraste con setup válido open/tp1). Cierra la deuda de que `processAnalysis` no tenía test de job.
- **H3b — contradicciones deterministas de-correlacionadas por BLOQUE** (`utils/gating.js`): `contradiction_count` pasa de contar señales sueltas a contar **bloques analíticos distintos** (`volume`/`derivatives`/`structure`, máx 3). Mapa `CONTRADICTION_BLOCK` + helper `countBlocks`; cada contradicción se etiqueta con su `block`. Varias señales del mismo bloque (`price_near_key_level` + `htf_conflict_1w_1d` + `smc_structural_conflict` = todas `structure`) cuentan como UNA — el mismo principio B1/H4 que ya se aplicaba a las *entradas*, ahora también en la ruta sin veto, para que la puerta `>=3 → Esperar` no se dispare por hechos correlacionados del mismo eje. Nuevo campo `gating.contradiction_blocks[]`. Prompt CONVICTION DECAY actualizado; `PROMPT_VERSION → v6_5_block_dedup`.

### Ficheros tocados

- `backend/src/utils/expectedScores.js` — `expectedVolumeScore` (firma `(cvd)`), `computeExpectedScores`.
- `backend/src/utils/gating.js` — `CONTRADICTION_BLOCK`, `countBlocks`, etiquetado por bloque, conteo por bloques en `computeContradictions` + `computeGating` (+ `contradiction_blocks`).
- `backend/src/services/outcomeService.js` — null-entry → `invalid` inmediato.
- `backend/src/services/anthropicService.js` — prompt CONVICTION DECAY + `PROMPT_VERSION`.
- `backend/tests/expectedScores.test.js`, `backend/tests/gating.test.js` — actualizados.
- `backend/tests/outcomeService.test.js` — **nuevo**.
- `CLAUDE.md` — C1 honesto, línea de arquitectura (`v6_5_block_dedup`), payload `contradiction_blocks`, conteo 372, entrada de changelog del seguimiento.

### Verificación

- **372/372 tests** (368 + 4 nuevos de `outcomeService.test.js`). Suite completa en verde.
- Cambios de decisión son funciones puras + cubiertas por `integration.test.js` (`/api/analyze`, `/api/analyze/payload`). No desplegado aún a la Pi (cambios de lógica, no hotfix).

### Notas / pendientes

- **Efecto de H3b:** reduce la frecuencia de `Esperar` cuando las contradicciones venían del mismo bloque (menos falsos bloqueos por correlación) — dirección alineada con el "sesgo a Esperar" que la propia auditoría quería medir. **Validar con `auditStats.mjs`** sobre datos reales de la Pi tras desplegar, para confirmar que el ratio de `Esperar` baja de forma sana y no de más.
- **Reproducibilidad (C1):** sigue sin estar garantizada a nivel de API; si en algún momento importa para interpretar el backtest, tenerlo presente (mitigado hasta donde la API permite).

### 25.1 Despliegue a la Pi + saneo del `.env` (2026-07-10)

- **`./scripts/deploy.sh`** (build frontend + rsync `backend/src`/`frontend/dist` + restart systemd): servicio `active`, health `operational` + DB `connected`.
- **Verificación en vivo** contra `http://localhost:8080/api/analyze/payload?coin=SOL&primary_tf=4h` (SSH a la Pi):
  - `llm_request.prompt_version = v6_5_block_dedup` ✅ (prompt nuevo sirviéndose).
  - **H3b demostrado con dato real:** 3 señales (`oi_flat_or_falling` + `price_near_key_level` + `htf_conflict_1w_1d`) → `contradiction_count: 2`, `contradiction_blocks: ['derivatives','structure']`. Las dos estructurales colapsan a un bloque.
  - **H2 demostrado:** `expected_scores.volume = {score: 0, basis: 'cvd_strength=marginal → sin convicción'}` leyendo el CVD 4h (`trend falling, divergence none, strength marginal`) → se abstiene. Derivados sí puntúa (`-1, LSR contrarian bear`).
  - Sin vetos ni `data_insufficient` en ese momento; sin errores 500.
- **Revisión + saneo del `.env` de la Pi** (con backup `/.env.bak.20260710-183634`):
  - `ANALYSIS_TEMPERATURE` **no estaba definido** → correcto (default `null` omite el campo, sin riesgo del 400 de §24). Recordatorio de §24 cerrado.
  - Alineados `NODE_ENV=production` y `PORT=8080` (antes `development`/`3000` — **inertes**: el unit systemd los sobrescribe, dotenv no pisa `process.env` ya definido; confirmado leyendo `/proc/$MainPID/environ`). Puramente cosmético.
  - **Retirada `OPENROUTER_AI_API_KEY`** (key de pago huérfana; el proyecto habla directo con Anthropic, ningún módulo la lee). Higiene de secretos.
  - No se reinició el servicio por estos cambios (todos inertes en runtime). El `.env` no está en git ni lo sincroniza `deploy.sh`.

---

## 26. Sesión 2026-07-10/12 — 2ª Auditoría Red-Team + sprint de remediación fases 0-4 (`v6_5` → `v6_8_atr_levels`)

### Contexto

El usuario pidió la 2ª auditoría red-team exhaustiva (18 perspectivas: arquitectura de decisión, dataset, doble conteo, correlaciones, gating, scoring, backtesting, look-ahead, alucinación, explicabilidad, casos extremos). Se auditó el **código real** del pipeline (gating, expectedScores, validador, decisionGates, prompt v6_5, controller, outcome/stats), buscando hallazgos NUEVOS no cubiertos por las auditorías previas (§23/§25). Resultado: **3 críticos + 5 altos + ~10 medios/bajos**, y un plan de trabajo en 5 fases aprobado e implementado (fases 0-4; la 5 espera muestra).

### Hallazgos críticos (los 3 cerrados)

1. **Leak de `expected_scores` al LLM (Goodhart).** `buildAnalyzeContext` incluía `expected_scores` y `buildPrompt` serializaba el contexto completo → el modelo VEÍA el score esperado de la guardia C2 y podía copiarlo, anulando el chequeo independiente. **Fix (Fase 1):** `buildPrompt` lo excluye (destructuring); sigue en `/api/analyze/payload` y persistido. Test: el `llm_request` no lo contiene.
2. **PnL del backtest sin signo ni filtro.** `pnl_pct_24h` era el movimiento crudo del precio, calculado para TODAS las acciones, y `AVG()` global → un Vender ganador RESTABA y el promedio media la deriva del mercado, no la estrategia. **Fix (Fase 1):** `pnl_signed_pct_24h` (× dir, solo Comprar/Vender) + `avg_pnl_signed_pct_24h` agrega solo direccionales; modal actualizado.
3. **Semántica CVD/absorción incoherente.** La divergencia CVD 1D (precio↑+CVD↓) tenía 3 tratamientos incompatibles: prompt = absorción MUY ALCISTA sobre soporte; guardia C2 = abstención por ambigua; veto/contradicción = evidencia bajista inapelable. **Fix (Fase 2, v6_6):** la pata CVD del veto y la contradicción exigen `cvd_strength` no-marginal; prompt añade DESAMBIGUACIÓN ESTRUCTURAL (absorción no puede argumentar contra veto activo — la conjunción ya la descartó) y ANTI-DOBLE-DESCUENTO de la bandera CVD 1D. Respaldado por Fase 0: la pata nunca había disparado en la Pi → endurecer no cambió comportamiento observado.

### Resto de fases

- **Fase 0 (verificación empírica):** OI de Coinalyze confirmado en **monedas base** (103.610 BTC vs $6,64B con `convert_to_usd=true` — llamada real); `auditStats.mjs` en la Pi: 10 análisis, 100% Esperar, 0 direccionales.
- **Fase 3 (v6_7, `498851e`):** unidad OI honesta (`value_coins` canónico — mejor señal, independiente del precio, y preserva la continuidad de `history_series`; USD real DERIVADO vía `withDerivedOiUsd` en controllers → el sidebar muestra $B verdaderos sin tocar frontend; columna `analyses.oi_value_coins`); **puerta de PREPARAR** (`prepare_gate` severe — era la vía de escape del gating: niveles ejecutables sin pasar ninguna puerta de score; guardia C2 extendida a Preparar por geometría del setup; fail-closed H2 bloquea Preparar accionable con datos ausentes); `crowded_trade_flag` fail-closed; `price_timestamp_utc` = `fetched_at` real.
- **Fase 4 (v6_8, `1d077cd`):** ATR expuesto en `technical[tf].atr` (faltaba; proxy de vol realizada para SOL sin DVOL); umbral de cercanía a niveles **normalizado por volatilidad** (`dynamicNearLevelPct` = 1.5×ATR% clamp [0.5,3] → `gating.near_level_pct_used`; verificado en local: SOL 4h → 2.16% vs el 1.5% fijo; ATR% varía 0.62 (1h) a 4.67 (1D) — el fijo significaba cosas radicalmente distintas por TF); telemetría `gating.borderline[]` (decisiones de borde: OI a ≤0.25pt, nivel entre 1× y 1.25× del umbral); **inventario hechos→consumidores en BLUEPRINT.md** (§NOTAS) con la regla "un dueño por capa".

### Commits

`cce76c4` (F0+F1) · `9ae2d12` (F2, v6_6) · `498851e` (F3, v6_7) · `1d077cd` (F4, v6_8). Deploy: F1 y F2 desplegadas y verificadas en vivo (2026-07-10); **F3+F4 (v6_7+v6_8) PENDIENTES — la Pi estaba apagada**. Verificadas en local contra datos reales.

### Hallazgos NO accionados (deliberado, esperan evidencia)

- **Fase 5** (backtest falsable): coste de oportunidad de Esperar (hoy el output dominante es infalsable), win-rate path-aware (un 'win' a 24h pudo pasar por el stop), de-dup por episodio antes del IC de Wilson (análisis solapados violan independencia), calibración de conviction. Necesita muestra.
- Ajustes ±0.5 del prompt (order book B2 — snapshot 60s votando en tesis 4h) y 6ª contradicción (solapa con bloques backend): revisar con datos de `auditStats.mjs`, no retirar sin evidencia (sería repetir el error que critican).
- Dependencia de `primaryTf` elegido en la UI (mismo mercado, distinto veredicto por pestaña): mitigada por la normalización ATR; documentada, sin cambio de comportamiento.
- Variables ausentes detectadas: basis perp-spot, calendario macro, dispersión de funding entre exchanges, time-of-day. Features nuevas, sprint aparte si se quiere.
