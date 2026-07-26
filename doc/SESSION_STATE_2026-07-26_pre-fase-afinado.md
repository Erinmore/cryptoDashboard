# SESSION_STATE.md — ARCHIVO (snapshot 2026-07-26)

> **Documento archivado.** Cubre §1–§27: desde el Sprint Schema hasta el cierre del Sprint
> Backend Gating, las dos auditorías red-team (v6_0 → v6_8_atr_levels), las dos revisiones
> críticas posteriores y el cierre de la deuda §6 (FVGs).
>
> Se archiva al entrar en **fase de pruebas y afinación** (recogida de datos en producción).
> La bitácora viva continúa en `SESSION_STATE.md` en la raíz, que arranca de cero centrada
> en el plan de recogida. Consultar este archivo para el *porqué* histórico de cualquier
> decisión de diseño: gating determinista, semántica CVD/absorción, unidad del OI, umbral
> ATR, guardia C2, fail-closed H2, etc.

---

## 1. Proyecto

Nombre: CRYPTEX Dashboard
Descripción corta: Dashboard profesional de análisis técnico de criptomonedas (BTC/ETH/SOL). Backend Node.js 18/Express/SQLite, frontend PixiJS v7.4.x, tests Jest 29. **Desplegado en Raspberry Pi 5 — nativo + systemd** (un proceso Express en `:8080` sirviendo API + SPA; NO Docker). Ver §18 y CLAUDE.md §Deploy.

Versiones anteriores archivadas: [`doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md`](doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md) (snapshot completo con §9-§22, pre-poda) · [`doc/SESSION_STATE_2026-04-27_sprint-schema.md`](doc/SESSION_STATE_2026-04-27_sprint-schema.md) (post Sprint Schema).

---

## 2. Estado actual

**413/413 tests pasan** (19 suites). El desglose por fichero está en CLAUDE.md §Tests; las sesiones 21–25 añadieron `gating.test.js`, `decisionGates.test.js`, `expectedScores.test.js`, `stats.test.js`, `levelStrength.test.js` y `outcomeService.test.js`; la §27 añade `fvgSnapshot.test.js` + `fvgPersistence.test.js`.

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
> Sesión 2026-07-10/12 (§26, `v6_5` → `v6_8_atr_levels`): **2ª AUDITORÍA RED-TEAM + sprint de remediación en 5 fases (0-4)** — 3 críticos nuevos cerrados (leak de `expected_scores` al LLM, PnL sin signo en el backtest, semántica CVD/absorción incoherente con el veto) + unidad real del OI (monedas base, no USD), puerta de `Preparar`, umbral de niveles normalizado por ATR, inventario hechos→consumidores en BLUEPRINT.md. 372 → 399 tests. **✅ v6_7+v6_8 DESPLEGADOS y verificados en producción (2026-07-26, ver §27)**. Detalle en §26.
> Sesión 2026-07-26 (§27): **revisión del 1er análisis en producción con v6_8** (dedupe por bloque, umbral ATR y guardia C2 funcionando en vivo) + **deuda §6 CERRADA** (`analysis_fvg_snapshot`). Incidente: un test escribió en la BD de desarrollo por import estático → limpiado y regla de aislamiento documentada. 399 → 413 tests. Detalle en §27.
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

## 9-22. Sesiones 2026-06-30 → 2026-07-06 (ARCHIVADAS)

Las secciones §9-§22 (históricos por coin, auditorías de payload, persistencia SQLite, validador
§6.4, Fase 12 + poller + job outcome, auditoría A1-A14, deploy Pi, kiosko, header compacto,
Sprint Backend Gating y su revisión) están **completadas** y movidas al snapshot
[`doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md`](doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md).
El conocimiento duradero de todas ellas ya vive en CLAUDE.md.

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

---

## 27. Sesión 2026-07-26 — Revisión del 1er análisis en producción (v6_8) + cierre de la deuda §6 (FVGs)

### Contexto

El usuario borró históricos y relanzó un análisis en la Pi para empezar a acumular muestra con la que auditar el sprint. Revisión de ese análisis + dos tareas que no dependen de la muestra.

### Revisión del análisis en producción (SOL 4h, Opus 4.8, 2026-07-26 20:04 UTC)

Primer análisis con **v6_8_atr_levels desplegado**. `Esperar`, conviction 0.30, risk 7/10, 45s, 29k in / 2.5k out. La maquinaria del sprint se comporta como se diseñó (verificado contra `/api/analyze/payload` en vivo):

- **Dedupe por bloque activo y con efecto real**: 3 señales crudas → `contradiction_count: 2` (`oi_flat_or_falling`=derivatives; `price_near_key_level`+`htf_conflict_1w_1d`=structure). Con el conteo ingenuo habrían sido 3 → `Esperar` forzado por decay; el LLM llegó a `Esperar` por análisis propio, no empujado por el gate. Primera evidencia real del fix v6_5.
- **Umbral ATR-normalizado vivo**: `near_level_pct_used: 1.38` (=1.5×ATR% 0.92) en vez del 1.5 fijo. `borderline: []`.
- **Guardia C2 se abstiene correctamente**: `expected_scores.volume = 0` con basis `cvd_strength=marginal → sin convicción`; el LLM también puso 0.
- **Leak de expected_scores sigue cerrado**: backend esperaba `derivatives=-1`, el LLM puso `0` → divergen, que es la prueba de que no lo ve (si lo viera, copiaría). 1 punto de divergencia no dispara la guardia: bien calibrado.
- Calidad analítica alta: distingue crowding (72.6% longs) de apalancamiento caliente (funding neutro, liq 12K) — justo lo que persigue la ANTI-DOUBLE-COUNT; da geometría en ambas direcciones sin emitir setup.

**Dos cosas a vigilar con muestra** (no accionadas): (1) `scores {0,0,0,0}` con la duda expresada sólo en `conviction` — vigilar que no se vuelva el default cómodo; (2) `oi_change_24h_pct=-1.9%` sobre $670M cuenta como contradicción (umbral `<0` estricto) cuando es ruido — candidato a dead-band, a decidir con la distribución real de `auditStats.mjs`.

**Caveat metodológico:** n=1, en `Esperar`, SOL en rango. Ningún veto disparó, el decay no llegó a 3, el fail-closed no actuó, la guardia C2 no degradó. Los caminos endurecidos del sprint **siguen sin ejercitarse en producción**.

### Protocolo de recogida acordado

SOL 4h, **Opus 4.8 fijo** (no cambiar de modelo ni de TF: serían variables de confusión con n≈20). Disparos a **10:05 y 22:05** hora peninsular (tras los cierres 4h de 08:00 y 20:00 UTC); si sólo uno al día, el de 22:05. Extra oportunista ante: cierre 4h >75.75, pérdida de 74.54, OI >+3% 24h, o movimiento >5% — son los caminos nunca ejercitados. Sin cron (decisión del usuario: disparo manual). Checkpoint a ~2 semanas (≈20 análisis) con `auditStats.mjs`.

Nota: `MIN_DIRECTIONAL_SAMPLE = 20` se mide sobre análisis **direccionales**; con 100% `Esperar` el win-rate nunca reportará por mucho que se acumule. La cadencia no es el cuello de botella, la distribución de acciones sí.

### Trabajo hecho

1. **CLAUDE.md — corregida documentación que mentía**: decía "v6_7+v6_8 PENDIENTES DE DEPLOY" cuando producción sirve `v6_8_atr_levels` (verificado). Mismo tipo de hallazgo que el #3 de §22.
2. **Deuda §6 CERRADA — `analysis_fvg_snapshot`** (último ítem). Tabla nueva con la geometría de cada FVG no mitigado: `zone_low/high`, `size_pct`, `mitigation_pct`, `candles_ago`, `signal_status`, `formed_t`, `distance_pct` (con signo: negativo = zona por debajo, 0 = precio dentro). PK `(analysis_id, tf, fvg_type, fvg_rank)`, pruning en cascada. Helper puro `fvgDistancePct` + `buildFvgRows` en el controller, `fvgs` en `saveAnalysis`. **No altera decisiones** (sólo persiste lo que el LLM ya recibía) → no contamina la muestra en curso.

### 🔴 Incidente durante el desarrollo: un test escribió en la BD de desarrollo

El primer intento de `fvgSnapshot.test.js` metió 3 filas basura (`fvg-1`, `fvg-empty`, `fvg-legacy`) en `backend/data/cryptex.db`. **Causa raíz:** `config/env.js` captura `dbPath` al **evaluarse el módulo**; el `import` estático de `analysisController.js` (que arrastra `dbService` → `db.js`) congelaba la ruta por defecto **antes** de que `beforeAll` fijara `DB_PATH` al temporal. `historyPersistence.test.js` no sufría esto porque usa sólo imports dinámicos.

**Limpieza:** borradas las 3 filas por id exacto + cascada; verificados los 7 análisis reales intactos.

**Fix estructural:** tests partidos en dos ficheros — `fvgSnapshot.test.js` (funciones puras, import estático, nunca toca BD) y `fvgPersistence.test.js` (**todos** los imports de `src/` dinámicos tras fijar `DB_PATH`), con una **aserción de guarda** sobre `PRAGMA database_list` que falla ruidosamente si la BD activa no es la temporal. Regla documentada en CLAUDE.md §Tests.

**Nota sobre el fixture de integración:** `MOCK_CANDLES` es una rampa lineal con rangos solapados donde `low[i] > high[i-2]` es imposible → nunca genera FVGs. Por eso la aserción en `integration.test.js` sólo comprueba que la tabla está cableada; el binding del INSERT (que los `@params` casan con las claves) se prueba en `fvgPersistence.test.js` contra BD real.

**Ficheros:** `config/db.js` (tabla+índice), `services/dbService.js` (INSERT + transacción + pruning), `controllers/analysisController.js` (`fvgDistancePct`, `buildFvgRows`, cableado), `tests/fvgSnapshot.test.js` (**nuevo**, 10), `tests/fvgPersistence.test.js` (**nuevo**, 4), `tests/integration.test.js` (+1), `CLAUDE.md`. Suite **399 → 413**.

**Migración:** `CREATE TABLE IF NOT EXISTS` → se crea sola al arrancar. Sin acción manual en la Pi más allá del deploy normal. **Pendiente de deploy** (decisión del usuario: hacerlo o no mientras acumula muestra).
