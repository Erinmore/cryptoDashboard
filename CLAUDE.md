# CLAUDE.md — CRYPTEX Dashboard

Instrucciones para Claude Code en este proyecto.

---

## Proyecto

**CRYPTEX** es un dashboard profesional de análisis técnico de criptomonedas (BTC, ETH, SOL) con:
- 14 indicadores técnicos calculados localmente
- Sentimiento en vivo (Fear & Greed Index)
- Datos de derivados (Funding Rate, Open Interest, Long/Short Ratio via Coinalyze)
- Análisis IA bajo demanda (Anthropic Claude, botón manual)
- Visualización interactiva con PixiJS v7.4.x
- Backend Node.js 18 / Express / SQLite (better-sqlite3)
- Single-user, hosted en VPS propio

El documento de referencia arquitectónica es [BLUEPRINT.md](./doc/BLUEPRINT.md). Consultarlo siempre antes de proponer cambios estructurales.

---

## 🔓 CONGELACIÓN LEVANTADA (2026-07-29) — leer antes de tocar la ruta de decisión

**La congelación del 2026-07-27 se levantó a los 2 días, y con motivo.** Se creó para dejar
correr una muestra evaluable. Pero la propia congelación permitía medir, y medir destapó que
**el sistema no podía emitir ninguna decisión direccional**: el Derivatives Score —cima de la
jerarquía y exigido por AMBAS puertas (`Comprar` >= +1, `Vender` <= -1)— tenía dos reglas
numéricas que disparaban el **0,0 % del tiempo** sobre 90 días × 3 monedas. Salía 0 en 6 de 6
análisis y las 6 acciones fueron `Esperar`.

Seguir recogiendo habría producido 12 días más de datos no evaluables **por construcción** —
exactamente el fallo que la congelación existía para terminar, alcanzado por el otro lado.

**Lo que la hace distinta de los 5 puntos cero anteriores:**

| Antes | Este lote |
|---|---|
| Cambios por hallazgos de inspección de código | Cambios por **distribuciones medidas** (90d × 3 monedas) |
| Un arreglo → punto cero → siguiente hallazgo → repetir | **Lista cerrada** acordada antes de empezar, **un solo punto cero** |
| Umbrales elegidos a ojo | **Ningún umbral sin ver antes su distribución** |

**La regla que sobrevive y no se negocia:** ninguna constante de corte se escribe sin medir
antes la distribución de la magnitud que bucketiza. Es lo que destapó T1-T6, el F&G inerte al
87,8 %, el LSR contrarian constante y el propio Derivatives Score. Si vas a escribir un
número, mídelo primero — y si no se puede medir, no lo escribas.

**Criterio de salida del siguiente periodo (definido de antemano, para no improvisarlo):** el
checkpoint mira `offered_pct` contra su tasa base (`lift`), el reparto de acciones y la
calibración de convicción. Ver SESSION_STATE.md §0.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 18 LTS (instalado via nvm) |
| Backend framework | Express 4.x, ES modules (`"type": "module"`) |
| Base de datos | SQLite3 via better-sqlite3, WAL mode |
| Renderizado frontend | PixiJS **v7.4.x** (no v8 — documentación inmadura) |
| Bundler frontend | Vite 4.x |
| Tests | Jest 29 con `--experimental-vm-modules` (ES modules) |
| Logging | Pino + pino-pretty en development |
| Deploy | Nativo + systemd en Raspberry Pi 5 (un proceso Express en :8080) · Docker disponible como alternativa |
| Reverse proxy | Nginx Proxy Manager (contenedor infra compartida) |

---

## Comandos esenciales

### Backend — ejecutar desde `backend/`

```bash
# Activar nvm (necesario en cada shell nueva)
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Arrancar servidor en desarrollo
npm run dev          # node --watch src/index.js

# Arrancar servidor normal
npm start

# Tests
npm test             # todos los tests
npm run test:watch   # modo watch
npm run test:coverage

# Instalar dependencias
npm install
```

### Frontend — ejecutar desde `frontend/`

```bash
npm run dev     # Vite dev server en :5173 (proxy /api → :3000)
npm run build   # Build de producción en frontend/dist/
npm run preview # Previsualizar build de producción
```

**No hay Makefile ni scripts de raíz.** Backend desde `backend/`, frontend desde `frontend/`.

### Dev launcher — `scripts/runSystem.sh`

Menú interactivo para gestionar backend y frontend sin abrir dos terminales:

```bash
./scripts/runSystem.sh          # menú interactivo
./scripts/runSystem.sh start    [backend|frontend|both]
./scripts/runSystem.sh stop     [backend|frontend|both]
./scripts/runSystem.sh restart  [backend|frontend|both]   # stop + start, libera puertos huérfanos
./scripts/runSystem.sh logs     [backend|frontend|both]
./scripts/runSystem.sh follow   [backend|frontend|both]

# Datos consolidados en BBDD
./scripts/runSystem.sh db stats                          # informe: registros por tabla/serie + rango histórico
./scripts/runSystem.sh db clear [history|analyses|all]   # vaciar (history_series / análisis / ambos)
```

PIDs y logs guardados en `.dev/` (ignorado por git). Estado `● running / ○ stopped` visible en cabecera del menú. `q` cierra el launcher sin matar los procesos.

**Guard de puerto y limpieza de huérfanos:** `start` comprueba si `:3000`/`:5173` ya está ocupado antes de arrancar y **rechaza con mensaje claro** en vez de crashear con `EADDRINUSE` (evita duplicados). `stop`/`restart` matan el **grupo de proceso completo** (`kill_tree` por PGID → arrastra `npm`, `node --watch` y el server) y, si el puerto sigue ocupado por un proceso no trackeado, liberan al huérfano por su PGID. En el menú interactivo: `r` (reiniciar ambos), `rb` (backend), `rv` (frontend).

**Opciones de BBDD en el menú:** `d` muestra datos consolidados (nº de registros por tabla de análisis y por serie de `history_series` con rango de fechas + tamaño en disco) y `x` vacía históricos/análisis con confirmación (`SI`). Ambas usan `backend/scripts/dbStats.mjs` y `backend/scripts/dbClear.mjs` (read-only / borrado + VACUUM vía better-sqlite3, sin arrancar la app).

---

## Arquitectura del backend

```
src/app.js                   ← Factory createApp() — Express app sin listen() (usado por tests)
src/index.js                 ← Entry point: importa createApp, llama listen(), graceful shutdown
src/config/
  env.js                     ← Todas las variables de entorno con defaults
  constants.js               ← Constantes de indicadores, coins, timeframes, `ANALYSIS_MODELS` (whitelist de modelos IA) + `DEFAULT_ANALYSIS_MODEL`
  db.js                      ← Conexión SQLite, migraciones inline al arrancar
src/middleware/
  security.js                ← Helmet + CORS + Compression + express.json
  logger.js                  ← Instancia Pino singleton
  errorHandler.js            ← Catch-all errors + 404
src/routes/                  ← Solo registran handlers, sin lógica
  data.js                    ← GET /api/data
  analysis.js                ← POST /api/analyze
  history.js                 ← GET /api/history/:coin (incluye outcome via JOIN)
  outcome.js                 ← POST /api/outcome/run + GET /api/outcome/stats (backtesting)
  health.js                  ← GET /health
src/controllers/             ← Orquestación, validación de params, formato respuesta
  dataController.js          ← GET /api/data — 11 fuentes en paralelo, devuelve candles+technical
  analysisController.js      ← POST /api/analyze — fetcha datos, llama Anthropic, guarda en DB
  historyController.js       ← GET /api/history/:coin — paginación, valida coin
src/services/                ← Lógica de negocio, I/O externo, cache
  anthropicService.js        ← Modelo SELECCIONABLE desde el frontend: `resolveModel(id)` valida contra `ANALYSIS_MODELS` (constants) y cae al default `claude-opus-4-8` — nunca deja pasar un id arbitrario. `buildLlmRequest(context, modelId)` / `analyzeMarket(context, modelId)`; `thinking:{type:'disabled'}` SÓLO en Sonnet 5 (Opus/Haiku sin thinking). PROMPT_VERSION **v9_0_deterministic_derivatives** — la sección A ya NO puntúa: el modelo COPIA `derivatives_score.score` que calcula el backend (ver `utils/derivativesScore.js`). Reglas nuevas del lote v9_0: **setup obligatorio en `Comprar`/`Vender`** (un trade sin geometría es una opinión y no se puede evaluar), **`conditional_setup` obligatorio en `Esperar`/`Preparar`** (el trade que se tomaría si apareciera lo que falta — hace la abstención medible y convierte cada espera en un shadow trade evaluable), **criterio para `validity_candles`** anclado a las ventanas del backtest (24h=6 velas, 7d=42; por encima de 7d nada puede evaluarse) y **regla para el conflicto CVD por TF** (el primario fija el score, el 1D limita la convicción, el veto manda). System ENSAMBLADO CONDICIONALMENTE por `buildSystemPrompt` — los bloques de on-chain/ETF/DVOL solo viajan si el dato existe; `llm_request.prompt_blocks` dice cuáles fueron; vetos, contradicciones —`contradiction_count` cuenta BLOQUES distintos volume/derivados/estructura, no señales sueltas—, decay SMC y umbrales de %/severidad movidos al backend → el LLM interpreta flags, no recalcula); OUTPUT FORMAT JSON puro {structured, narrative} — `structured.missing_confirmations[]` lista en lenguaje claro qué falta para operar; `extractJson()` — parse robusto que extrae el JSON de preámbulo/fences markdown (Sonnet 5 no da JSON puro; Opus sí); AppError 502 si tras extraer no es JSON válido
  dbService.js               ← saveAnalysis({ header, tfSnapshots, clusters }) — transacción 4 tablas; getAnalysisHistory() devuelve action/confidence/risk_score/executive_summary/score_total; pruning en cascada
  indicatorService.js        ← computeIndicators() — orquesta los 14 indicadores + Volume Profile + computeTrend ponderado
  coingeckoService.js        ← fetchOHLC (Binance klines: 1h/4h/1D/1W con taker_buy_base real), fetchCurrentPrice, fetchBTCDominance, fetchGlobalMarketData, fetchCoinMarketData
  fearGreedService.js        ← fetchFearGreed (alternative.me, gratis) + alimenta históricos
  coinalyzeService.js        ← fetchFundingRate (con predicted_rate_pct), fetchOpenInterest, fetchLongShortRatio, fetchLiquidations + históricos
  binanceOrderBookService.js ← fetchOrderBookWalls (depth=20: muros, spread, imbalance ratio top20/top5/signal), fetchBinanceTicker
  liquidationClustersService.js ← Inferencia de magnetic zones cruzando liquidaciones 1h con candles 1h (top 5 long/short, distancias)
  onchainService.js          ← Métricas on-chain BTC (MVRV, MVRV Z-score, NUPL, SOPR) — bitcoin-data.com free tier
  etfFlowsService.js         ← Spot ETF flows BTC/ETH (SoSoValue, sin auth) — daily_net_inflow_usd_yesterday, net_inflow_usd_7d_sum, cumulative_net_inflow_usd, trend_7d, by_issuer[]
  macroService.js            ← Macro context DXY/SPX/Gold (Yahoo Finance v8, sin auth) — value, change_24h_pct, trend_5d
  deribitService.js          ← DVOL volatility index BTC/ETH (Deribit public API, sin auth) — value, regime, change_24h_pct; SOL null. Cache 5min
  historyService.js          ← Históricos por coin para análisis LLM (7-30 días) — en memoria (ventana LLM) + persistencia SQLite write-through (tabla history_series). CVD/VWAP se hidratan al arrancar (únicas sin API que sirva su histórico ya calculado — pero SÍ reconstruibles con `scripts/backfillHistorySeries.mjs`, ver abajo); el resto se persiste para acumular pero se rellena fresco de su API
  (scripts) auditVetoFrequency.mjs ← Mide la FRECUENCIA real del veto y del grupo 2 de umbrales (funding severity, LSR contrarian) sobre 90 días de Coinalyze — lo que no se puede medir solo con klines. Resultado vigente: el veto dispara el **8,2 %** del tiempo (11 episodios/90d), así que NO se aflojó de más al recalibrar; el LSR contrarian con corte 60/40 daba `contrarian_bear` el 95,7 % y se corrigió a terciles (y en v9_0 acabó saliendo de la rúbrica)
  (scripts) auditLiquidations.mjs ← Mide skew y magnitud de las liquidaciones (el 3er input sin regla del Derivatives Score). Umbral resultante: `skew <= -0,5` Y `magnitud >= 2×` la mediana de 30d. ⚠️ **Calentamiento de mediana corregido el 2026-07-30** (mismo defecto que en `auditDerivativesRubric`): ahora reporta las cifras con TODOS los anclajes y solo con la mediana de 30d COMPLETA, que es el régimen en el que opera producción por el guard `cascade_min_points: 620`. **El umbral aguanta**: cascada de longs al 8,8→9,9 % (SOL), 10,6→7,0 % (BTC), 8,9→6,5 % (ETH) — se mueve 1-3,6 puntos y las tres siguen en la banda discriminante. Confirma que el calentamiento diluía la FUERZA del efecto (+14,5→+31,3 de lift en el otro script) y no desplazaba el corte. Hallazgo colateral: la cascada ALCISTA cae al **2,0 %** con mediana completa → rama muerta, segunda razón independiente para haberla descartado
  (scripts) auditPriceBand.mjs ← **La banda se MANTIENE en 0,50×, pero no por ser demostrablemente mejor (2026-07-30)**. Nació de que los 2 primeros análisis de `v9_0` dieran `oi_price_cell: "no_signal"`, el segundo con el eje de OI VIVO (+1,68 %) y el precio dentro de banda (−0,81 % vs ~1,6 %): a UNA celda del primer `Vender`. **Fuga real: ~24 % de la señal que habría puntuado** (el 55 % del "eje vivo silenciado" exagera, porque solo 2 de las 4 celdas puntúan). **Aflojar no se justifica**: la celda `OI↑` —con n suficiente— degrada monótonamente (SOL 16,1→11,0→13,1→8,6→4,7) y la `OI↓` deja de ser medible (n<15), así que iríamos a ciegas. **Pero apretar a 0,35× es alternativa real**: las 6 celdas positivas, fuga al ~18 % y MEJOR n (41-59 vs 24-29); ETH lo prefiere. Con 90 días de Coinalyze **los datos NO separan 0,35× de 0,50×**. Se mantiene porque nada obliga a cambiarlo y cambiarlo cuesta un punto cero; 0,35× es el primer candidato si el `no_signal` resulta dominante con más muestra. ⚠️ **Guarda `MIN_N=15` y IC de Wilson añadidos tras una revisión crítica**: la primera versión reportó las filas de 0,75×/1,00× (n=3-7) junto a las de n=42 como si fueran comparables, y la conclusión inicial ("aflojar se va a negativo") se apoyaba en ese ruido
  (scripts) auditDvolRegime.mjs ← **Resultado NEGATIVO: el DVOL de BTC no merece regla (2026-07-29, revisado 2026-07-30)**. Medido sobre 365d × SOL/ETH/BTC (n=2.170 anclajes 4h). Tres razones: (1) **dos de los cuatro buckets están muertos** — `elevated`+`panic` suman 12 anclajes (**0,3 %**) porque el índice pasó el año entre 33,8 y 48,3, así que los cortes en 60/80 son ramas muertas; (2) **el efecto de los dos vivos cae dentro del ruido** — `complacent` +0,5/+1,2/+2,6 y `normal` −0,3/−0,6/−2,0 sobre una base del 36-38 %, con IC muy solapados ([32,5-48,6] vs [28,9-41,3]); (3) **redundancia**: lo único con mecanismo real es que la implícita predice la realizada (ATR% 1,90→2,38→2,34→5,73 en SOL, monótono en las tres), y eso ya lo mide el `ATR%` del propio activo, que además normaliza todos los umbrales → sería doble conteo con un proxy indirecto y con retardo. **Nota de método:** la métrica de oportunidad está ATR-normalizada, así que era incapaz de detectar una señal de volatilidad por construcción — la pregunta estaba mal planteada. ⚠️ **Dos bugs corregidos el 2026-07-30 tras revisión crítica:** la lógica de oportunidad hacía `if (dnAdv) return null`, y `dnAdv` (el precio SUBIÓ 1×ATR) es favorable para la tesis alcista, no adverso — descartaba el ancla entera y subestimaba las oportunidades por un factor 3 (base 11-15 % en vez de 35,8-38,1 %). **La discrepancia con el 34,8 % de `auditOpportunityThresholds` era la señal y no se cuestionó.** Además faltaba la guarda de n en el resumen. Corregirlo tumbó el argumento original de "signos invertidos = ruido": los signos SÍ son consistentes; lo que descarta la regla es la magnitud y la redundancia. Revisar solo con DVOL > 60 sostenido, y por la puerta de RIESGO (tamaño de posición), no la direccional
  (scripts) backfillContradictionBlocks.mjs ← Rellena `analyses.contradiction_blocks` en filas anteriores a la columna. **IMPORTA `CONTRADICTION_BLOCK` de `utils/gating.js`** en vez de copiar el mapa: dos definiciones de "qué bloque es cada señal" y el conteo del decay dejaría de casar con lo que muestra el historial. Comprueba integridad antes de escribir (nº de bloques derivados == `contradiction_count`) y omite la fila si descuadra — sería síntoma de que el dedupe por veto dejó códigos y conteo desalineados, y eso se investiga, no se parchea. `--dry-run`. Ejecutado el 2026-07-31: 4 filas, 0 descuadres
  (scripts) backfillHistorySeries.mjs ← **Reconstruye CVD/VWAP hacia atrás** desde klines (3 monedas, idempotente, `--force`/`--dry-run`). Sirve para recuperarse de un apagado y, sobre todo, para **sembrar** la serie tras un punto cero: el LLM arranca con la ventana de 30 días llena en vez de acumular un día cada 24h. Guarda de integridad: aborta si el CVD sale `heuristic` en vez de `taker_real`, para no mezclar dos definiciones en la misma serie
  historyPoller.js           ← Poller de fondo (index.js, no app.js): cada HISTORY_POLLER_INTERVAL_SEC (300s) recorre las 3 monedas y persiste su history_series (CVD/VWAP + backfill derivados) + F&G — desacopla la persistencia de la moneda visualizada en el frontend. Flag HISTORY_POLLER_ENABLED
  analysisValidator.js       ← Validador determinista del output LLM (§6.4): validateAnalysis() (reglas duras → warnings) + applyFailSafe() (degrada a Esperar ante violación severa). Funciones puras
  outcomeService.js          ← Job de backtesting (index.js, cada OUTCOME_JOB_INTERVAL_SEC=900s): runOutcomeJob() rellena analysis_outcome (precios 1h/4h/24h/7d vía klines históricas, outcome direccional, barrier TP/stop) **+ métricas de RECORRIDO (Fase 5)**: pide las klines 1h para TODOS los análisis (antes solo con setup ejecutable) y deriva excursiones + primeros cruces; el ATR% del TF primario se reconstruye desde klines una sola vez (retroactivo, `atr_pct_at_analysis`). Endpoints POST /api/outcome/run + GET /api/outcome/stats. Lógica pura en utils/outcome.js + utils/pathMetrics.js. Flag OUTCOME_JOB_ENABLED. **El barrier se evalúa SOLO dentro de la vigencia declarada por el propio análisis** (`setup_validity_candles` × TF de `setup_tf_execution`, con fallback a `primary_tf`) vía `setupExpiryMs`/`candlesWithinValidity`: hasta el 2026-07-28 ese campo se persistía y **no lo leía nadie**, así que el barrier recorría los 7d completos y acreditaba como `tp1` un TP tocado días después de que el setup caducase — sesgo no neutro, porque el stop suele estar más cerca que el TP y alargar la ventana favorece al TP. La caducidad la marca ahora la vigencia, no el horizonte de 7d (un setup válido 24h ya no se queda `open` seis días más). **Las métricas de recorrido siguen usando los 7d completos**: miden el mercado, no la decisión. FAIL-OPEN: sin vigencia utilizable no se recorta (preserva el comportamiento anterior en vez de inventar una ventana)
  cacheService.js            ← Cache en memoria con TTL
src/utils/
  indicators.js              ← Funciones matemáticas puras (sin I/O)
  volumeProfile.js           ← Volume Profile (POC, VAH, VAL, HVN, LVN) — función pura
  smc.js                     ← Smart Money Concepts: detectSwings, detectLastBOS, detectLastCHoCH, detectUnmitigatedFVGs, calculateSMC — funciones puras. `calculateSMC` anota `signal_status` (active/context/expired) por evento y FVG (decay precalculado, antes lo hacía el LLM)
  derivativesScore.js        ← **Derivatives Score determinista (v9_0, 2026-07-29)**. Sustituye al scoring del LLM, que era estructuralmente incapaz de salir de 0: sus dos reglas numéricas disparaban el **0,0 %** del tiempo (90d × SOL/BTC/ETH), y como ese score gobierna AMBAS puertas direccionales el sistema no podía emitir `Comprar` ni `Vender`. Rúbrica MEDIDA: eje **OI × dirección del precio 24h** (el OI no tiene dirección propia — expandirse es alcista o bajista según contra qué); solo puntúan las dos celdas que **sobreviven al control de momentum** — `OI↑px↑` = dinero nuevo (+1) y `OI↓px↑` = rally sin dinero nuevo (−1, el efecto mejor evidenciado: continuó al alza 0/24 en SOL y 1/29 en ETH). **`OI↑px↓` NO puntúa**: su efecto aparente era momentum del precio, y meterlo contaminaría con precio un score que está POR ENCIMA de Structure en la jerarquía. Suma la **cascada de liquidaciones de longs** solo si la celda calló (anti-doble-conteo B1: solapan el 33-44 %) y el **funding de cola** (0 % en 90d, correcto: son eventos extremos). Banda de precio = 0,5×ATR%×√n (nunca un % absoluto: fallo T5). FAIL-CLOSED con `data_insufficient` si falta el eje. `measured_at` viaja en la salida: la rúbrica caduca con el régimen. **Telemetría de calibración (2026-08-01):** `priceBandPct(atrPct, tf)` es el ÚNICO dueño de la fórmula de la banda —la consumen `oiPriceCell` para decidir y `computeDerivativesScore` para exponerla—, y `components` incluye `atr_pct`/`band_pct`. Sin ellos no se puede saber a qué distancia del corte quedó cada `no_signal`, que es la magnitud con la que se decide 0,50× vs 0,35×; reconstruirla a posteriori NO es exacto (la última vela sigue formándose entre el análisis y la auditoría). ⚠️ `atr_pct` aquí es el de la ventana de **180** velas (`indicatorService`), NO el `atr_pct_at_analysis` de `analysis_outcome`, que el outcome job reconstruye sobre **19** (`ATR_PERIOD+5`): el ATR de Wilder es recursivo y son dos números distintos. Ambos campos se PODAN del dataset del LLM (misma regla que `cvd_strength_cuts` en v8_1: el modelo lee la etiqueta, no el corte) y siguen en payload y BBDD
  gating.js                  ← Gating determinista (funciones puras): `computeVetos()` (HARD GATING — AND de 3 condiciones de VETO LONG/SHORT sobre S/R del TF primario; la pata CVD 1D exige divergencia con `cvd_strength` moderate/strong — una divergencia marginal es ruido y la lectura de absorción del prompt hace la señal ambigua) + `computeContradictions()` (5 de las 6 del CONVICTION DECAY; la 6ª depende de scores del LLM). Umbral de cercanía a niveles NORMALIZADO POR VOLATILIDAD (`dynamicNearLevelPct(atrPct, tf)` = 1.5×ATR% del TF primario, suelo 0.5% y **techo POR TF** 2/4/10/25% para 1h/4h/1D/1W, fallback 1.5% fijo → `gating.near_level_pct_used`); `gating.borderline[]` = telemetría de condiciones pegadas al umbral. DEDUPE veto↔contradicciones cubre las TRES patas (CVD 1D, nivel, OI). El controller inyecta el resultado en el bloque `gating` del payload; el LLM obedece los flags en vez de recalcular umbrales
  shadowTrade.js             ← **Evaluador de shadow trades (2026-08-01)** — el `conditional_setup` que emite todo `Esperar`/`Preparar` se persistía desde v9_0 y **no lo evaluaba nadie**, así que la salida dominante del sistema seguía sin producir un resultado. `parseConditionalSetup` / `conditionalGeometryProblem` / `geometryDirection` / `evaluateShadowTrade` (funciones puras). **NO reimplementa ninguna regla**: reutiliza `evaluateSetupBarrier` + `setupExpiryMs` + `candlesWithinValidity` de `utils/outcome.js`, o el resultado no sería comparable con el del setup ejecutable. Vocabulario de `cond_outcome` = el de `setup_outcome` + `truncated` (vigencia declarada > los 7d de klines que ve el job: afirmar `not_triggered` sería inventarse los días que nadie ha mirado). ⚠️ **La lectura es MÁS PERMISIVA que el gatillo declarado**: el `trigger` es texto libre y NO se parsea — se evalúa la GEOMETRÍA, con la entrada llena al TOCARLA intravela (`SHADOW_FILL_RULE`), mientras el modelo suele exigir un CIERRE de vela. Por eso un `not_triggered` es robusto por el lado conservador y un `tp1`/`stop` puede no haber cumplido el gatillo estricto; la regla viaja en la respuesta de la API. **Fail-closed ante geometría contradictoria** (`direction_mismatch`, `tp_side`, `missing_tp`, `stop_eq_entry`) → `invalid` inmediato y fuera de todos los denominadores: es lo que el validador ya avisaba, y así no se cuela en el win-rate. ⚠️ **Un shadow trade ganador NO demuestra que la abstención fuera un error** — valida la geometría declarada, no convierte el `Esperar` en fallo
  pathMetrics.js             ← **Fase 5** — recorrido del precio tras un análisis (funciones puras): `computeExcursions` (máximos al alza/baja + hora), `computeFirstPassage` (horas hasta el primer cruce de cada múltiplo de ATR — 0.5/1/1.5/2/3/4 — al alza y a la baja), `computeAtrPct`, `computePathMetrics`. Convención: el instante reportado es el CIERRE de la vela que contiene el evento (cota superior). Límite conocido: si el cruce al alza y el adverso caen en la MISMA vela 1h su orden no es resoluble — el desempate (adverso primero) lo aplica stats.js, igual que `evaluateSetupBarrier` con TP1/stop
  episodes.js                ← **Fase 5** — `episodeKey` / `dedupeByEpisode` / `countEpisodes`: un episodio = una vela del TF primario. Dos análisis de la misma vela 4h comparten casi todo el input, así que contarlos por separado estrecha el IC de Wilson por debajo de la incertidumbre real
  stats.js                   ← IC de Wilson + `summarizeShadowTrades` (**2026-08-01**: `trigger_rate_pct` = ¿llegan a darse las condiciones que el sistema nombra?, y `win_rate` sobre `tp1+stop` con el MISMO gate `MIN_DIRECTIONAL_SAMPLE`. ⚠️ **CENSURA corregida en el denominador**: un condicional que dispara puede resolverse en la 1ª hora mientras uno que no dispara no es terminal hasta agotar su vigencia, así que contar por "tener resultado" sesgaría `trigger_rate` AL ALZA — solo entran los que tienen la **ventana vencida** (`pending_n` aparte). La vigencia se recalcula con `setupExpiryMs`, no se persiste: es función exacta de datos ya guardados. ⚠️ **A `trigger_rate_pct` le falta su tasa base** — sin ella es el mismo número suelto que era `offered_pct` antes de `OPPORTUNITY_BASE_RATE`; depende de cada geometría, así que exige script propio) + **Fase 5**: `classifyOpportunity` (¿ofreció el mercado un movimiento operable? = `targetK`×ATR antes de `adverseK`×ATR en contra, SIN dirección propia), `classifyPathOutcome` (win-rate path-aware: mira el camino, no el destino), `maxExcursionAtr`, `convictionBucket`, y los agregadores `summarizeOpportunity`/`summarizePathWinRate`/`summarizeConviction`. `OPPORTUNITY_DEFAULTS` (2×/1×ATR) son CONVENCIONES sin calibrar — viajan en la respuesta (`thresholds`) para que la cifra nunca se lea sin su regla. `MIN_DIRECTIONAL_SAMPLE=20` vive aquí para que el win-rate clásico y el path-aware compartan gate. **`TRIGGER_BASE_RATE` (2026-08-01)** — la referencia que le faltaba a `trigger_rate_pct`, que era un número suelto igual que `offered_pct` antes de su tasa base. Se creía que había que medirla *por condicional* porque depende de la geometría; medido (`scripts/auditTriggerBaseRate.mjs`), al normalizar la distancia por **`ATR% × √velas`** la tasa **COLAPSA**: 24h y 48h coinciden dentro de 0,4-6,4 pt y las tres monedas dentro de 0,7-3,4 pt → es una **curva de UNA variable**, enviada como constante con `measured_at` (mismo patrón que `OPPORTUNITY_BASE_RATE`). `normalizedTriggerDistance` convierte la vigencia al TF del ATR (un condicional ejecutado en 1h con ATR de 4h daría distancia inflada ×2) y `triggerBaseRateFor` interpola sin extrapolar. ⚠️ El eje usa `atr_pct_at_analysis` (19 velas), NO el `components.atr_pct` de decisión (180): se eligió porque está persistido retroactivamente en TODAS las filas — para una tasa base da igual cuál sea mientras tabla y consumidor usen el mismo. **`expectancy_r` + `breakeven_win_rate_pct`**: el win-rate solo no es interpretable (con R:R 1,77 el equilibrio está en 36,2 %, así que un 40 % gana y un 33 % pierde, y ni con n=40 el IC excluye ese punto); `rr_median`/`breakeven` describen la GEOMETRÍA y están disponibles sin resultados, `expectancy_r` es el RESULTADO y comparte gate con el win-rate. El modal pintaba el acierto contra un **50 % hardcodeado** — corregido para pintarlo contra el equilibrio real. **`expectancyR` (2026-08-01, opción A):** `expectancy_r` es un OBJETO `{point, ci_low, ci_high, n, inconclusive}`, no un número — el punto no se puede leer sin su intervalo, misma disciplina que `fill_rule` con `trigger_rate`. Usa **t de Student** (a n=8 el margen es 21 % mayor que con z, y n=8 es el tamaño del primer checkpoint). **SIN gate de muestra, a diferencia del win-rate**, y es deliberado: `MIN_DIRECTIONAL_SAMPLE=20` está calibrado para una PROPORCIÓN, y para la media de un múltiplo de R con cola es demasiado pequeño — a n=20 el IC sigue siendo ±0,57R y a n=60 ±0,33R, así que un gate protege justo cuando menos falta (n=8, donde el número es obviamente inútil) y falla justo cuando más falta (n=60, donde ya PARECE serio y sigue sin afirmar el signo). `inconclusive` es proporcional a la incertidumbre real en todo n. Medido con R:R 1,65: hacen falta ~64 resueltos para una ventaja fuerte (+0,32R) y **~181 para una moderada** (+0,19R) → a 0,4-0,7 resueltos/día es una pregunta de MESES, no de checkpoint. En el modal, si el intervalo cruza cero el TITULAR es el rango y el punto baja al tooltip. ⚠️ **DENOMINADOR CORREGIDO el 2026-08-01**: la expectativa contaba solo `tp1`+`stop`, y ese subconjunto está enriquecido en stops **por la GEOMETRÍA**, no por el mercado — el stop suele estar más cerca que el objetivo, así que dentro de una vigencia corta lo alcanza mucho más a menudo y lo que no llega a ninguno CADUCA. Medido con 3.733 réplicas de las 7 geometrías reales: **1.172 caducados frente a 1.064 resueltos**, o sea que se tiraba el 52 % de los trades disparados siempre por el mismo lado. Ahora entra todo lo llenado y el caducado aporta su R real vía `analysis_outcome.cond_exit_price` (se persiste el PRECIO, no el R: el R sale de una sola fórmula válida para largo y corto, `(salida − entrada)/(entrada − stop)`, que reproduce +R:R en `tp1` y −1 en `stop`). **El sesgo era de 0,225R**: la línea base pasó de −0,221R [−0,294, −0,148] *concluyentemente negativa* a **+0,004R [−0,036, +0,044]**, que es lo que debe dar una geometría aplicada al azar. `scripts/auditShadowBaseline.mjs` mide esa línea base — sin ella un `−0,1R` real no se sabe si es bueno o malo
  errors.js                  ← AppError, ValidationError, ExternalApiError
```

**Flujo de una request:** `route → controller → services (en paralelo) → response`

**`GET /api/data` devuelve:** `candles` (TF principal, con `taker_buy_base`/`taker_buy_quote`/`quote_volume` reales de Binance), `technical` (4 TFs, incluye `volume_profile` por TF), `sentiment`, `fear_greed`, `derivatives`, `btc_dominance`, `binance_walls` (con `imbalance_ratio`), `last_analysis`, precio, **`history`** (históricos para análisis LLM).

**`GET /api/analyze/payload` añade además:** `order_book` (muros + imbalance), `derivatives.liquidation_clusters` (magnetic zones inferidas + flags `magnetic_long/short_zone_active`), `onchain` (MVRV/NUPL/SOPR para BTC), `etf_flows` (BTC/ETH spot ETF flows vía SoSoValue), `macro` (DXY/SPX/Gold vía Yahoo Finance), `volatility` (btc_dvol/eth_dvol via Deribit — value, regime, change_24h_pct), `volume_history` (CVD/VWAP), `timeframe_analysis` (conflictos entre TFs), **`gating`** (vetos deterministas `veto_long/veto_short/veto_reason` + `contradictions[]`/`contradiction_count` (por bloques)/`contradiction_blocks[]` + `near_level_pct_used` (umbral ATR-normalizado) + `borderline[]` precalculados por `utils/gating.js`), `expected_scores` (guardia C2 — **se EXCLUYE del dataset que recibe el LLM** en `buildPrompt`: si el modelo la viera podría copiarla y anular la guardia), resúmenes consolidados de históricos. `technical[tf]` incluye `atr` ({value, pct, period} — proxy de vol realizada, normaliza el gating y cubre a SOL sin DVOL). `technical[tf]` incluye además `volume_profile` (con `price_vs_poc`, `excursion`) y `smc` (BOS/CHoCH/FVGs con `signal_status`); `cvd.cvd_strength` (+ `cvd_strength_pctile` y `cvd_strength_cuts`, telemetría de la calibración) y `vwap.price_vs_vwap` también precalculados.

## Arquitectura del frontend

```
frontend/
  index.html                 ← Layout completo (header, canvas PixiJS, sidebar)
  vite.config.js             ← Proxy /api → :3000 en dev
  assets/
    css/styles.css           ← Dark mode completo (variables CSS, todos los componentes)
    js/
      app.js                 ← Entry point: init PixiJS, carga datos, conecta eventos, persistencia. **`restoreRecommendationPanel(rec, {serverAnswered})`**: el orden de precedencia es SERVIDOR → puente local → vacío. La copia de `localStorage` es un PUENTE para que el panel no parpadee mientras llega `/api/data`, **no una memoria paralela**: en cuanto el backend contesta (`serverAnswered:true`), un `last_analysis` nulo significa "no hay análisis" y la copia local se PURGA (`clearCoinRecommendation`). Sin esa distinción el fallback no separaba "aún no ha contestado" de "ha dicho que no hay nada", y un análisis viejo sobrevivía a un borrado de BBDD y a un redespliegue, repintado idéntico a uno recién hecho (bug detectado en el punto cero 5, 2026-07-29). runAnalysis() lee el modelo del desplegable `#model-select` (persistido en localStorage `cryptex_model`), muestra "⏳ Analizando…" en el botón y al terminar abre el modal de Historial (openHistory) con el resultado + previos
      api/
        client.js            ← fetchData(coin, tf) + postAnalyze(coin, tf)
      state/
        store.js             ← Estado global: getState(), setState(), subscribe()
        storage.js           ← Persistencia por coin en localStorage (coin, tf, recommendation) + `clearCoinRecommendation(coin)` — borra SOLO la recomendación conservando el `tf`
      ui/
        sidebar.js           ← **`fmtLevel`** (niveles S/R a 2 decimales fijos: `fmtPrice` permitía 4 y pintaba "$73.4633" para un soporte, falsa precisión sobre un promedio de clusters) · **`fmtLiq`** (USD crudos con escala K/M/B; antes asumía millones Y recibía monedas → "$17281M" en SOL) · la unidad de los muros sale de `state.coin` (estaba **hardcodeada a 'BTC'**: un muro de 2.289 SOL se leía como 2.289 BTC, error de factor 900) · Fear & Greed muestra `29 · Fear` + delta numérico `−4 7d` con su referencia escrita (antes solo dos flechas con lógicas distintas y la clasificación únicamente en el tooltip). updateHeader, updateIndicators, updateSentiment, updateRecommendation (schema {structured,narrative}), updateLastAnalysis. show/hideRecommendationLoading fijan `style.display` INLINE (los divs se ocultan con inline en el HTML → togglear sólo la clase `.hidden` no bastaba). Panel "Análisis IA" + "Análisis Previo" son las 2 primeras secciones del sidebar
        history.js           ← Modal historial IA (Fase 12): fetchHistory + fetchOutcomeStats. La insignia de contradicciones dice **`2/3 bloques: derivados + estructura`** — antes ponía "2 contradic. (de 3)", que se lee como "2 de 3 bloques" cuando ese 3 eran las señales CRUDAS. Pinta también el **`conditional_setup`** (caja de borde punteado, distinta del setup real) con geometría, disparo y R:R calculado en el cliente. Cabecera de backtesting (win-rate/PnL/TP-stop) + tarjetas (acción, scores, gating, setup, validation_warnings, resultado outcome por horizonte)
      renderer/
        pixiRenderer.js      ← PIXI.Application + ResizeObserver
        layers.js            ← 4 capas: grid, candle, overlay, ui
        draw.js              ← createViewport, drawGrid, drawCandles, formatTime (HH:MM / DD/MM)
        interactions.js      ← Drag/pan, zoom anclado al cursor, crosshair, tooltip OHLCV
      timer.js               ← Clase Timer: start/stop/reset, countdown en header
```

**Flujo de datos frontend:** `fetchData() → setState() → subscribe callbacks → renderChart() + updateSidebar()`

---

## Gráfico PixiJS — notas de implementación

### Z-order en `drawGrid()` (draw.js)
Los textos de ejes deben añadirse al `gridLayer` **después** del objeto `PIXI.Graphics` (`gfx`), no antes. Si se hace `gridLayer.addChild(gfx)` al final, los fondos opacos de los ejes (drawRect) tapan los textos. Patrón correcto:
```js
gridLayer.addChild(gfx);           // fondos + líneas grid (debajo)
for (const t of texts) gridLayer.addChild(t);  // etiquetas (encima)
```

### Velas visibles (`createViewport`, draw.js)
`visibleBars = Math.min(candles.length, 80)` — hardcodeado en 80. Para hacerlo parametrizable, pasarlo como argumento o leerlo del store/estado.

### Render bajo demanda
No hay `requestAnimationFrame` ni ticker de Pixi activo. `renderChart()` (app.js) se llama solo en: nuevos datos del backend, drag/zoom del usuario (vía `setViewport` callback en `initInteractions`), y resize. No añadir lógica de animación continua.

### Coordenadas del gráfico
- `PADDING_LEFT=72` reservado para eje Y, `PADDING_BOTTOM=28` para eje X
- `chartWidth()` y `chartHeight()` descuentan el padding — usarlos siempre en vez de `getSize()` directamente para cálculos de posición de velas
- El viewport `{ offsetX, visibleBars, priceMin, priceMax }` es la fuente de verdad para todo el render; `interactions.js` lo modifica vía callback `setViewport`

---

## Convenciones de código

- **ES modules** en todo el proyecto: `import/export`, nunca `require/module.exports`
- **Async/await** siempre. No callbacks ni `.then()` encadenados
- Los servicios externos nunca lanzan errores que rompan `/api/data` — usan `try/catch` y devuelven `null` en fallo (degraded mode)
- `Promise.allSettled` en el controller de datos — ningún fallo externo bloquea la respuesta
- Nombres de campos de candle normalizados: `{ t, open, high, low, close, volume }` — **siempre estos nombres**, no abreviaturas `{o,h,l,c,v}`
- Los indicadores matemáticos en `utils/indicators.js` son **funciones puras** — sin imports de servicios ni I/O
- Clases de error tipadas para todos los errores: nunca `throw new Error('...')` directamente

---

## Convenciones CSS (Frontend)

**IMPORTANTE**: El archivo `frontend/assets/css/styles.css` usa un **sistema completo de variables CSS**. **Nunca hardcodees valores** — siempre usa variables definidas en `:root`.

Lee `frontend/CSS_CONVENTIONS.md` para documentación completa. Resumen de variables:

### Colores principales

```css
--bg-app, --bg-surface, --bg-card, --bg-hover          /* Fondos */
--text-primary, --text-secondary, --text-muted         /* Texto */
--accent, --accent-dim, --accent-hover                  /* Azul principal */
--bullish, --bearish, --neutral                         /* Señales */
--bullish-dim, --bearish-dim, --neutral-dim             /* Fondos señales */
--alert-danger-bg/text, --alert-warning-bg/text, --alert-info-bg/text  /* Alertas */
```

### Tipografía (escala 8px)

```css
--fs-xs (8px) → --fs-sm (9px) → --fs-base (10px) → --fs-md (11px) 
→ --fs-lg (12px) → --fs-xl (13px) → --fs-2xl (16px) → --fs-3xl (18px)
```

### Espaciado (escala 4px)

```css
--sp-xs (2px) → --sp-sm (4px) → --sp-md (6px) → --sp-lg (8px) 
→ --sp-xl (10px) → --sp-2xl (12px)
```

### Border radius

```css
--radius-sm (3px) → --radius-md (4px) → --radius-lg (6px) → --radius-full (50%)
```

### Transiciones

```css
--transition-fast (0.15s) → --transition-base (0.2s) → --transition-slow (0.4s) → --transition-anim (0.7s)
```

**Reglas de oro:**
- ❌ Nunca: `background: #1a1e2a;` → ✅ Siempre: `background: var(--bg-card);`
- ❌ Nunca: `font-size: 11px;` → ✅ Siempre: `font-size: var(--fs-md);`
- ❌ Nunca: `padding: 8px;` → ✅ Siempre: `padding: var(--sp-lg);`
- ❌ Nunca: `border-radius: 4px;` → ✅ Siempre: `border-radius: var(--radius-md);`
- ❌ Nunca: `transition: all 0.15s;` → ✅ Siempre: `transition: all var(--transition-fast);`

**Ventaja:** Cambiar un color/tamaño global = editar una variable en `:root`. Nuevo componentes heredan automáticamente el diseño.

---

## APIs externas

| Servicio | Uso | Auth | TTL cache | Notas |
|----------|-----|------|-----------|-------|
| Binance klines | OHLCV real (4 TFs) con taker_buy_base/quote agressor data | Ninguna | 60s–1800s per-TF | Fuente principal de candles; campos `taker_buy_base`/`taker_buy_quote`/`quote_volume` críticos para CVD/VolumeDelta reales |
| Binance depth/ticker | Order book top 20 + ticker 24h | Ninguna | 60s | `fetchOrderBookWalls` calcula muros + imbalance_ratio sobre 20 niveles + top 5 |
| CoinGecko v3 | Precio actual, BTC Dominance, datos de mercado global y de coin | Opcional (free tier) | 30s precio, 10min dominance | Ya no se usa para OHLCV (Binance klines lo reemplazó) |
| alternative.me | Fear & Greed Index (30 días) | Ninguna | 10min | Obtiene últimos 30 días (`limit=30`); completamente gratis, sin registro |
| Coinalyze v1 | Funding Rate (+predicted), OI, L/S Ratio, Liquidaciones, clusters de liquidación | `COINALYZE_API_KEY` (gratis) | 30min FR, 5min OI/LSR/Liq, 10min liquidation_clusters | Ver estructura de respuesta real abajo |
| bitcoin-data.com (BGeometrics) | On-chain BTC: MVRV, MVRV Z-score, NUPL, SOPR | Ninguna (free tier 8 req/h, **15 req/día**) | **12h** completo o parcial; **30min** cache negativo en fallo total | Solo BTC; ETH/SOL devuelven `null`. NUPL llega como string → parsear. Endpoints `/v1/{mvrv,mvrv-zscore,nupl,sopr}/last`. Datos diarios (cierre UTC), refrescar más a menudo gasta cuota sin valor |
| SoSoValue | Spot ETF flows BTC/ETH (historicalInflowChart + currentEtfDataMetrics) | Ninguna (POST sin auth) | 1h normal, 30min negativo | SOL → `null` (sin spot ETF). Body `{"type":"us-btc-spot"\|"us-eth-spot"}`. Campos numéricos envueltos en `{value, lastUpdateDate, status}` → extraer `.value`. En `historicalInflowChart`: `totalNetInflow` = flujo **diario** (puede ser negativo); `cumNetInflow` = acumulado desde inception (~$39B BTC). NO confundirlos. |
| Yahoo Finance v8 | Macro DXY/SPX/Gold (chart endpoint, interval=1d&range=10d) | Ninguna | 30min normal, 10min negativo | User-Agent obligatorio. Símbolos: `DX-Y.NYB`, `^GSPC`, `GC=F`. Cache coin-agnóstico (`macro:global`). closes[] puede traer null → filtrar |
| Deribit public API | DVOL volatility index BTC/ETH (get_volatility_index_data) | Ninguna | 5min | resolution=43200 (12h), 48h de historia para change_24h_pct. SOL → `null` natural. Regime: panic >80 / elevated 60-80 / normal 40-60 / complacent <40 |
| Anthropic | Análisis IA | `ANTHROPIC_API_KEY` | Sin cache (on-demand) | — |

**Endpoints y estructura de respuesta Coinalyze (verificados 2026-04-06):**
- Funding Rate: `GET /v1/funding-rate?symbols=X` → `[{ symbol, value, update }]` — campo `value` (no `last_funding_rate`)
- Funding Rate History: `GET /v1/funding-rate-history?symbols=X&interval=6hour&from=T&to=T` → `[{ symbol, history: [{t, o, h, l, c}] }]` — candles de 6h para tendencia 48h
- Open Interest: `GET /v1/open-interest?symbols=X` → `[{ symbol, value, update }]` — campo `value` (no `open_interest`). **`value` viene en MONEDAS BASE del instrumento, NO en USD** (verificado 2026-07-12 contra `convert_to_usd=true`: 103.610 BTC vs $6,64B). El servicio lo expone como `value_coins`/`unit:'base_coin'`; el USD real se DERIVA (`withDerivedOiUsd`, coins × spot) en los controllers
- Open Interest History: `GET /v1/open-interest-history?symbols=X&interval=4hour&from=T&to=T` → `[{ symbol, history: [{t, o, h, l, c}] }]` — candles de 4h para cambio 24h y tendencia 7d
- L/S Ratio: `GET /v1/long-short-ratio-history?symbols=X&interval=1hour&from=T&to=T` → `[{ symbol, history: [{t, r, l, s}] }]` — campos `l` (long%) y `s` (short%) en porcentaje directo; se piden 7d completos para histórico
- Liquidations: `GET /v1/liquidation-history?symbols=X&interval=1hour&from=T&to=T` → `[{ symbol, history: [{t, l, s}] }]` — `l` = longs liquidados (USD), `s` = shorts liquidados (USD) en últimas 24h

**Degraded mode:**
- Si `COINALYZE_API_KEY` no está configurada → `env.hasDerivativesData` es `false` y todos los servicios de Coinalyze (incluido `liquidationClustersService`) devuelven `null` sin lanzar error
- `ONCHAIN_DATA_ENABLED=false` en `.env` apaga `onchainService` (no requiere key, sólo flag)
- Si bitcoin-data.com cae o se rate-limitea, `onchainService` cachea un sentinel `{__empty:true}` durante `CACHE_ONCHAIN_NEGATIVE_TTL` (30 min) en lugar de reintentar inmediatamente. La cuota free (15 req/día) se respeta porque el TTL completo es 12h y cada refresh consume 4 requests (4 × 2 = 8 req/día)

---

## Selección de modelo IA — comparativa observada (2026-07-03)

El modelo del análisis se elige desde el desplegable del header (whitelist `ANALYSIS_MODELS`, default **Opus 4.8**). Comparativa empírica de los 3 tiers sobre el **mismo mercado** (SOL, ~$81.4, F&G 21, sin apenas movimiento en 2h → las diferencias son interpretación del modelo, no condiciones distintas):

| Modelo | Total | Volumen (V) | Riesgo | Cómo llega a Esperar | Calidad de la tesis |
|--------|-------|-------------|--------|----------------------|---------------------|
| **Opus 4.8** (~$0.20) | +1 | 0 | 6/10 | "setup cargado, falta trigger" | **La más accionable**: da el trigger exacto (*cierre 4h sobre 82.0–82.6 con expansión de OI*) |
| **Sonnet 5** (~$0.09) | +0.5 | +1 | 6/10 | scores contradictorios | Muy cerca de Opus; añade el matiz de **agotamiento técnico** (StochRSI 1D en 100, WT 4h overbought) |
| **Haiku 4.5** (~$0.04) | −0.33 | −1 | 7/10 | **gating** (veto duro) | Coherente pero más superficial: "conflicto, fuera" sin plan hacia delante |

**Conclusiones (guía para elegir modelo):**
- **Los 3 convergen en `Esperar`** con el mismo driver (`structure`) y el mismo diagnóstico de fondo (CHoCH bullish 1D vs 1W bajista + resistencia ~83 sin expansión de OI). El tier se nota en la **profundidad de la tesis y los scores**, no en la acción. **Matiz (auditoría red-team 2026-07-07)**: esta convergencia NO es por sí sola prueba de robustez — el gating determinista empuja estructuralmente hacia `Esperar` (contradicciones ≥3, vetos), así que los tres modelos heredan ese sesgo. La convergencia refleja el gate compartido, no un acuerdo independiente entre modelos. Ver el sprint de remediación abajo (H1).
- **El score de Volumen es la gran divergencia** (Haiku −1 / Opus 0 / Sonnet +1): el mismo CVD 1h divergente + OI plano se lee de tres formas. Señal genuinamente ambigua donde cada modelo mete su sesgo.
- **Haiku 4.5 es más conservador/bajista** en señales ambiguas (V−1, riesgo 7/10, tiende a **gating**): puede vetar setups que Opus/Sonnet dejarían en "preparar". Útil como filtro rápido/barato, no para la tesis final.
- **Recomendación**: como el output *es el producto*, usar **Opus 4.8** (o Sonnet 5, casi a la par y 2× más barato) para decisiones reales; Haiku 4.5 para un pulso rápido y económico.
- El **badge de modelo** en cada tarjeta del historial (vía `analyses.model_used`) permite hacer esta comparación de un vistazo.

---

## Timeframes

`TIMEFRAMES = ['1h', '4h', '1D', '1W']` — ordenados de menor a mayor.

| TF | Fuente | Candles | Cache TTL | Notas |
|----|--------|---------|-----------|-------|
| 1h | Binance klines `interval=1h&limit=168` | 168 | 60s | OHLCV real (high/low verdadero), sin API key |
| 4h | Binance klines `interval=4h&limit=180` | 180 | 300s | OHLCV real, consistente con 1h |
| 1D | Binance klines `interval=1d&limit=90` | 90 | 600s | OHLCV real; velas de 1 día exacto. CoinGecko market_chart solo da snapshots (no usar para OHLCV) |
| 1W | Binance klines `interval=1w&limit=52` | 52 | 1800s | OHLCV real; velas alineadas a lunes UTC natively por Binance |

**Fuente OHLCV:** Binance klines (`/api/v3/klines`) para todos los TFs. CoinGecko se mantiene solo para precio actual, BTC dominance y datos de mercado global.

`draw.js → formatTime`: si intervalo entre velas ≥ 6h → `DD/MM`; si < 6h → `HH:MM`.

---

## Base de datos (SQLite)

Las migraciones se ejecutan inline en `config/db.js` al arrancar. No hay ficheros de migración externos.

**Tablas:**
- `analyses` — cabecera de cada análisis IA: precio, mercado, sentimiento, macro, volatilidad, on-chain, derivados, ETF flows, order book, decisión LLM, scores internos, setup táctico, texto narrative. Máx 1000 por coin, pruning automático en cascada.
- `analysis_tf_snapshot` — 4 filas por análisis (una por TF 1h/4h/1D/1W): indicadores clave, SMC, S/R, Volume Profile, WaveTrend.
- `analysis_outcome` — resultado real a posteriori: precios 1h/4h/24h/7d después, outcome, PnL, barrier de setup (TP1/TP2/stop). **Fase 5** añade el RECORRIDO: `atr_pct_at_analysis`, `max_up/down_pct_24h`, `max_up/down_pct_7d`, `t_max_up/down_h` y `path_first_passage` (JSON con las horas del primer cruce de cada múltiplo de ATR). Ventana única de 7d para los cruces — el horizonte de 24h se filtra en lectura; los máximos sí necesitan versión de 24h porque un máximo a 7d no lo acota. Rellenado por el job `outcomeService.js` (cada 15min + `POST /api/outcome/run`); el upsert usa COALESCE en esas columnas para que un fallo transitorio de Binance no borre lo ya medido. **Shadow trade (2026-08-01)**: `cond_outcome` / `cond_filled` / `cond_invalid_reason` — el `conditional_setup` evaluado con el mismo barrier y la misma vigencia que el setup real (ver `utils/shadowTrade.js`). Estas tres **NO llevan COALESCE**: el estado evoluciona (`open` → terminal) y el servicio ya preserva explícitamente ante fallo de klines. No se guardan `hit_tp1`/`hit_stop` (sin TP2 son idénticos a `cond_outcome`) ni la caducidad (`setupExpiryMs` la recalcula exacta desde datos ya persistidos). `getAnalysesNeedingOutcome` reselecciona un condicional vivo aunque el resto de la fila esté completa, acotado a los mismos 8 días del backfill del recorrido.
- `analysis_liquidation_snapshot` — hasta 10 filas por análisis (5 long + 5 short): clusters de liquidación persistidos en el momento del análisis.
- `analysis_fvg_snapshot` — geometría de cada FVG no mitigado (hasta 5 × 2 direcciones × 4 TFs): `zone_low/high`, `size_pct`, `mitigation_pct`, `candles_ago`, `signal_status`, `formed_t` y `distance_pct` (distancia con signo del precio al borde más cercano: negativo = zona por debajo, 0 = precio dentro). Cierra la deuda §6 — el TF snapshot sólo guardaba el *conteo*, así que no se podía comprobar a posteriori si el precio llegó a rellenar el gap (la tesis del FVG como imán). PK `(analysis_id, tf, fvg_type, fvg_rank)`, `fvg_rank` 0 = más reciente; pruning en cascada.
- `candles_cache` — reservada para futuro (no se usa actualmente)
- `history_series` — series históricas persistidas (`coin`, `metric`, `ts_key`, `payload` JSON, PK compuesta). Alimentada por `historyService.js` write-through para las 7 métricas (funding/oi/lsr/liq/cvd/vwap/fear_greed; fear_greed bajo coin `GLOBAL`). **No se dropea** en migraciones — sobrevive reinicios. Retención 400 días. Ver excepción a la regla de abajo.

**`saveAnalysis()` es una transacción** que inserta en las 4 tablas de análisis atómicamente. El pruning borra en cascada manual (better-sqlite3 no garantiza FK enforcement sin triggers).

**No guardar** datos OHLC ni indicadores técnicos por-request en DB — son efímeros y se recalculan en cada request. **Excepción:** los *snapshots diarios* de CVD/VWAP sí se persisten en `history_series` porque ninguna API los sirve ya calculados. **CORRECCIÓN (2026-07-27):** durante mucho tiempo se afirmó aquí que además eran *irreconstruibles*, y de ahí salía la regla de que la Pi no podía apagarse. Es FALSO: `historyPoller` los calcula con `computeIndicators` sobre las 90 velas diarias de Binance, o sea que son función pura de datos públicos y permanentes. `scripts/backfillHistorySeries.mjs` los regenera para cualquier fecha pasada. Lo único que faltaba era que `fetchHistoricalKlines` arrastrase `taker_buy_base` (sin él, el CVD cae al proxy heurístico, que da signo distinto).

---

## Persistencia frontend (localStorage)

`state/storage.js` gestiona tres claves:

| Clave | Contenido |
|-------|-----------|
| `cryptex_coin` | Última coin seleccionada ('BTC' \| 'ETH' \| 'SOL') |
| `cryptex_state_BTC` | `{ tf, recommendation }` de BTC |
| `cryptex_state_ETH` | `{ tf, recommendation }` de ETH |
| `cryptex_state_SOL` | `{ tf, recommendation }` de SOL |

Al cambiar de coin se guarda el estado de la coin que se abandona y se restaura el de la nueva (TF activo + panel de recomendación IA).

---

## Tests

```bash
# Desde backend/
npm test
```

- Framework: **Jest 29** con soporte ES modules vía `--experimental-vm-modules`
- Los tests están en `backend/tests/`
- **691 tests totales** (tras la Fase 5, el afinado, la vigencia del setup, el lote v9_0, el preflight, el historial, la telemetría de banda y el evaluador de shadow trades): `derivativesScore.test.js` + `indicators.test.js` + `integration.test.js` + `analysisValidator.test.js` + `outcome.test.js` + `outcomeService.test.js` + `gating.test.js` + `decisionGates.test.js` + `expectedScores.test.js` + `stats.test.js` + `timeSeries.test.js` + `timeframeConflicts.test.js` + `levelStrength.test.js` + `historyPersistence.test.js` + `fvgSnapshot.test.js` + `fvgPersistence.test.js` + `extractJson.test.js` + `fundingSummary.test.js` + `modelSelection.test.js` + `lsrSummary.test.js` + `percentiles.test.js` + `cvdStrengthPersistence.test.js` + `promptAssembly.test.js` + `pathMetrics.test.js` + `episodes.test.js` + `opportunityPersistence.test.js` + `historicalKlines.test.js` + `btcContextPersistence.test.js` + `shadowTrade.test.js` + `shadowTradePersistence.test.js`

**Tests que tocan la BD: imports dinámicos obligatorios.** `config/env.js` captura `dbPath` al evaluarse el módulo, así que un `import` estático de cualquier cosa que arrastre `config/db.js` (p. ej. un controller) congela la ruta por defecto **antes** de que `beforeAll` fije `DB_PATH` → el test escribe en `backend/data/cryptex.db`, la BD real. Patrón correcto (`historyPersistence.test.js`, `fvgPersistence.test.js`): fijar `process.env.DB_PATH` primero y luego `await import()` de todo lo de `src/`, con una aserción de guarda sobre `PRAGMA database_list` que falle ruidosamente si la BD activa no es la temporal.
- Los tests de indicadores usan datos sintéticos diseñados para ejercitar comportamiento, no valores exactos de mercado
- Los tests de integración usan supertest + `jest.unstable_mockModule` para mockear todos los servicios externos — offline, deterministas, ~1.5s

**Al añadir un nuevo indicador** en `utils/indicators.js` o `utils/`, añadir tests en `indicators.test.js` siguiendo el patrón existente: null con datos insuficientes, estructura del resultado, comportamiento en tendencia alcista/bajista.

**Patrón de mocks ESM (integration.test.js):** usar `jest.unstable_mockModule` antes del `await import()` del app. Importar el app desde `src/app.js` (no `src/index.js`) para evitar `EADDRINUSE` en tests. Los mocks con `mockRejectedValueOnce` sobre servicios cacheados no propagan — el cache absorbe la llamada; para degraded-mode tests usar `mockResolvedValueOnce(null)` con coin/tf distintos al test anterior.

---

## Indicadores implementados

Todos en `backend/src/utils/indicators.js`. Funciones exportadas:

| Función | Descripción |
|---------|-------------|
| `calculateRSI(closes, period?)` | RSI Wilder |
| `calculateEMA(values, period)` | EMA helper |
| `calculateATR(candles, period?)` | ATR Wilder — último elemento de `calculateATRSeries` (no pueden divergir) |
| `calculateATRSeries(candles, period?)` | Serie completa del ATR en una pasada — sitúa el ATR actual en su propia distribución sin O(n²) |
| `calculateADXSeries(candles, period?)` | Ídem para ADX; ambos salen del núcleo compartido `adxCore` |
| `calculateMACD(closes, fast?, slow?, signal?)` | MACD + 4 estados momentum: `bullish_accelerating/bullish_decelerating/bearish_accelerating/bearish_decelerating` |
| `calculateStochRSI(closes, ...)` | Stochastic RSI |
| `calculateWaveTrend(candles, n1?, n2?)` | WaveTrend Oscillator — devuelve `{ wt1, wt2, signal }` donde signal puede ser `neutral/overbought/oversold/oversold_cross_up/overbought_cross_down` |
| `calculateADX(candles, period?)` | ADX + DMI |
| `calculateBollingerBands(closes, period?, mult?)` | BB + width_pct + position (0.0-1.0, no status) |
| `calculateSuperTrend(candles, ...)` | SuperTrend adaptativo — usar `st.support` (UP) o `st.resistance` (DOWN) para el nivel |
| `calculateVolumeDelta(candles)` | Presión compradora/vendedora — usa `taker_buy_base` real de Binance cuando los candles lo traen (`source: 'taker_real'`); fallback heurístico `(close-low)/(high-low)` si falta o es inválido (NaN, fuera de rango) |
| `calculateCVD(candles)` | Cumulative Volume Delta — mismo patrón taker_real / heuristic. Delta real = `2*taker_buy_base - volume` |
| `calculateVWAP(candles, period?)` | VWAP (rolling 20-period) — Volume-Weighted Average Price |
| `calculateFibonacci(high, low, levels?)` | Niveles Fibonacci — el wrapper en `indicatorService` lo expone como `{ swing_high, swing_low, swing_high_date, swing_low_date, type: 'retracement', levels[] }` |
| `calculateSupportResistance(candles, ...)` | Soporte & Resistencia sobre **pivotes fractales** con **ancla fija**. Devuelve `{supports, resistances}` sin campo `type`. `touches` = rechazos locales reales, no tiempo de permanencia (ver auditoría de umbrales T4) |
| `detectRSIDivergence(closes, ...)` | Divergencias RSI |
| `detectMarketRegime(candles, closes)` | Régimen TRENDING/RANGING/HIGH_VOLATILITY — devuelve string plano, no objeto |

**Helpers adicionales (no en `indicators.js`):**
- `calculateVolumeProfile(candles, opts?)` en `utils/volumeProfile.js` — POC, VAH, VAL, HVN/LVN (top 5), bin_size, total_volume. Distribución uniforme: cada vela contribuye `volume / numBins` a cada bin que cubre su rango.
- `computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta })` en `services/indicatorService.js` — string ponderado por jerarquía del SYSTEM_PROMPT: estructura 50% (ADX+SuperTrend), ejecución 30% (RSI+MACD+WaveTrend+StochRSI), volumen 20%. Devuelve `strongly_bullish | bullish | neutral | bearish | strongly_bearish`.
- `calculateSMC(candles, opts?)` en `utils/smc.js` — wrapper que devuelve `{ last_bos, last_choch, unmitigated_fvgs }`. Funciones internas: `detectSwings` (pivote fractal lookback=2), `detectLastBOS` (continuación de tendencia HH/HL o LH/LL), `detectLastCHoCH` (ruptura en dirección opuesta = primer aviso de reversión), `detectUnmitigatedFVGs` (ventana 100 velas, top 5 por dirección, más recientes primero). Expuesto como `technical[tf].smc`.

---

## Estado ACTUAL — leer esto antes que la tabla histórica

| | |
|---|---|
| Código | **`v9_0_deterministic_derivatives`** · 691 tests |
| Fase | **Periodo de medición ACTIVO** desde el punto cero 5 (2026-07-29 23:17 CEST) |
| Producción | Pi `192.168.1.250:8080` · crons A+B+C+D activos · BBDD desde cero |
| Revisión temprana | **2026-08-02** (~7-9 análisis) — NO es el checkpoint |
| Dónde mirar | **`SESSION_STATE.md §0`** — tabla de hallazgos abiertos, criterio de salida y calendario |

**Qué se está midiendo y por qué:** hasta v9_0 el sistema **no podía emitir ninguna decisión
direccional** — el Derivatives Score, cima de la jerarquía y exigido por ambas puertas, tenía
dos reglas que disparaban el 0,0 % del tiempo. Con la rúbrica medida ese score alcanza
`|>=1|` el 23-25 % del tiempo, así que este periodo responde tres preguntas: ¿sale de 0?, si
sigue todo `Esperar` ¿quién bloquea ahora?, y ¿vienen los `conditional_setup` bien formados?

**Hallazgos ABIERTOS que un ingeniero nuevo debe conocer antes de tocar la ruta de decisión**
(detalle en `SESSION_STATE.md §0`): el `veto_short` puede tener coste direccional · el veto
dispara al 50 % en muestra vs 8,2 % en 90d · `offered_pct` es la cifra del checkpoint · la
evaluación del shadow trade está sin montar · hay cuatro "vigencias" implícitas sin unificar.

---

## Estado histórico por bloques (hasta 2026-04-27)

| Bloque | Contenido | Estado |
|--------|-----------|--------|
| Bloque 1 | Setup, skeleton, 14 indicadores | ✅ Completo |
| Bloque 2 | 7 servicios externos, GET /api/data | ✅ Completo |
| Bloque 3 | POST /api/analyze, historial, anthropicService stub | ✅ Completo (pendiente API key) |
| Bloque 4 | Frontend Fases 7, 8, 9, 10, 11, 13 completas | ✅ Completo |
| Bloque 4.5 | Sistema de históricos para análisis LLM (7-30 días) | ✅ Completo |
| Sprint A' | Volume Delta/CVD con taker_buy real, predicted_rate_pct, computeTrend ponderado | ✅ Completo |
| Sprint B' | Order book imbalance, Volume Profile, Liquidation Clusters, On-chain BTC | ✅ Completo |
| Sprint C' | ETF Flows, Macro (DXY/SPX/Gold), SMC (BOS/CHoCH/FVG) | ✅ Completo |
| Sprint D' | Deribit DVOL, update SYSTEM_PROMPT v3_extended_context, docs | ✅ Completo |
| Sprint Audit | Auditoría técnica + fixes correctitud (SuperTrend, ADX naming, S/R clustering, RSI divergence, computeTrend ranging, payload semántica) | ✅ Completo |
| Fase 15 | Tests de integración de endpoints (47 tests, supertest) | ✅ Completo |
| Sprint Briefing | Deficiencias de dataset + prompt auditadas (briefing 2026-04-27): D1-D22, P1-P7 | ✅ Completo |
| Sprint Schema | Rediseño persistencia IA: 4 tablas, OUTPUT FORMAT JSON, analyzeMarket() implementado | ✅ Completo |
| Bloque 5 | Schema ✅, panel historial IA ✅, panel en vivo ✅, poller multi-coin ✅, validador §6.4 ✅, analysis_outcome job ✅, deploy Pi nativo+systemd ✅ (2026-07-03) | ✅ Completo |

### Detalle Bloque 4

| Fase | Contenido | Estado |
|------|-----------|--------|
| Fase 7 | Vite + PixiJS setup, grid, velas dummy | ✅ Completo |
| Fase 8 | Drag, zoom (anclado al cursor), crosshair + tooltip OHLCV | ✅ Completo |
| Fase 9 | API client, store, sidebar, datos reales | ✅ Completo |
| Fase 10 | UI polish: noticias, flash precio, timer "soon", tooltips indicadores y sentimiento detallados, icono punto azul hover | ✅ Completo |
| Fase 11 | Timer 60s + countdown + botón refresh | ✅ Completo |
| Fase 13 | Selector coin + TF + persistencia localStorage por coin | ✅ Completo |

### Fixes y mejoras adicionales implementados

- **Timeframes optimizados**: 1h → 4h → 1D → 1W; cache per-TF (60s–1800s); todos servidos por Binance klines nativo (1W con `interval=1w` alineado a lunes UTC)
- **WaveTrend sidebar**: señal corregida — usa `wt.signal` del backend (`cross up/down`, `overbought/oversold`) en vez de solo `wt1 > 0`
- **Coinalyze**: campos de respuesta corregidos tras verificar la API real (`value` en FR y OI; `l`/`s` en LSR)
- **Open Interest**: sidebar muestra valor absoluto formateado (`$6.6B`) + cambio 24h real vía endpoint de históricos. El USD es DERIVADO (`value_coins × precio spot` vía `withDerivedOiUsd` en dataController) — Coinalyze reporta en monedas base
- **Funding Rate**: sidebar muestra tasa + tendencia (rising/falling/stable) vía endpoint de históricos 48h
- **Liquidaciones**: nuevo endpoint `/liquidation-history` con suma 24h de longs vs shorts liquidados
- **Tooltips sentimiento**: Fear & Greed, Funding Rate, Open Interest, L/S Ratio, Liquidaciones — mismo estilo que indicadores, con icono punto azul en hover (`::after` en `.sent-label[title]`)
- **Tooltips indicadores**: reescritos con nivel didáctico para alguien nuevo en trading
- **Sistema de históricos**: módulo `historyService.js` gestiona 7-30 días de contexto temporal para análisis LLM. Incluye: F&G 30d, FR 48h, OI 7d, L/S 7d, Liq 7d
- **Refactorización CSS (2026-04)**: Se eliminaron ~60 valores hardcodeados del CSS. Implementado sistema modular de variables (colores, tipografía, espaciado, border-radius, transiciones). Estilos duplicados consolidados. Documentación en `CSS_CONVENTIONS.md`
- **Mejoras semántica JSON (2026-04-06)**:
  - Eliminado campo redundante `type` de support/resistance (la lista ya lo declara)
  - Renombrado `histogram_color` → `momentum_state` en MACD para semántica clara (`bullish_accelerating`, etc.)
  - Eliminados campos `status` de MACD (redundante) y Bollinger Bands (nombre semánticamente incorrecto)
  - Añadido campo `severity` a funding_rate (normal/elevated/high/extreme)
  - Añadidos campos `distance_to_nearest_support_pct` y `distance_to_nearest_resistance_pct` a cada timeframe para acción inmediata del LLM
- **Fear & Greed históricos completos (2026-04-06)**:
  - Aumentado limit de API a 30 días (`limit=30` en alternative.me)
  - Ahora `fearGreedService` alimenta el histórico con todos los 30 días, usando timestamps reales de cada dato
  - `fear_greed_history` en `/api/analyze/payload` devuelve: `current`, `yesterday`, `7d_ago`, `30d_ago` con búsqueda exacta de fechas (fallback a dato más antiguo si no existe fecha exacta)
  - Datos históricos completamente alineados con sitio web de alternative.me

- **Sprint A' (2026-04-26) — datos institucionales reales**:
  - `calculateVolumeDelta` y `calculateCVD` consumen `taker_buy_base` real de Binance klines (índice 9). Campo `source` (`'taker_real' | 'heuristic'`) indica el origen al LLM. Guard `Number.isFinite` + clamp `[0, volume]` blinda contra NaN o datos corruptos
  - `predicted_rate_pct` integrado en `fetchFundingRate` vía endpoint `/v1/predicted-funding-rate` (mismo Promise.allSettled, no servicio separado)
  - `computeTrend` reescrito con jerarquía Estructura > Ejecución > Volumen (50/30/20) según pide el SYSTEM_PROMPT — devuelve `strongly_bullish | bullish | neutral | bearish | strongly_bearish`

- **Sprint B' (2026-04-26) — expansión de fuentes**:
  - **Order Book Imbalance** (`order_book` en payload): `imbalance_ratio` sobre 20 niveles, `imbalance_top5_ratio`, `imbalance_signal` (`buy_pressure` / `sell_pressure` / `balanced`); `spread_usd` y `spread_pct` con 6 decimales para mercados tight
  - **Volume Profile** (`technical[tf].volume_profile`): POC, VAH, VAL, HVN/LVN (top 5), distribución uniforme `volume / numBins`. Función pura en `utils/volumeProfile.js`
  - **Liquidation Clusters** (`derivatives.liquidation_clusters`): inferencia de magnetic zones cruzando `liquidation-history` 1h de Coinalyze con candles 1h de Binance (longs en swing low, shorts en swing high). Top 5 long/short, distancias % al cluster más cercano. `source: 'coinalyze_inferred'` para que el LLM sepa que es proxy, no CoinGlass real
  - **On-chain BTC** (`onchain`): MVRV, MVRV Z-score, NUPL, SOPR + clasificadores tipados (`low/fair/elevated/extreme`, `capitulation/hope/optimism/belief/euphoria`, `loss/neutral/profit_taking`). Free tier 15 req/día; cache 12h (4 req × 2 = 8 req/día) + cache negativo 30min en fallo total con sentinel `{__empty:true}` (commit `45568ae`)

- **Sprint C' (2026-04-26) — contexto institucional y estructural**:
  - **ETF Flows** (`etf_flows` top-level): `etfFlowsService.js` consume SoSoValue (POST sin auth). BTC + ETH cubiertos; SOL `null`. Output: `daily_net_inflow_usd_yesterday` (flujo diario, puede ser negativo), `net_inflow_usd_7d_sum` (suma de 7 flujos diarios), `cumulative_net_inflow_usd` (acumulado desde inception del ETF), `trend_7d` (`accumulating/distributing/neutral`, umbral 100M USD), `by_issuer[]` top 10 por net_assets. Cache 1h / negativo 30min con sentinel `{__empty:true}`.
  - **Macro** (`macro` top-level): `macroService.js` consume Yahoo Finance v8 chart. DXY (`DX-Y.NYB`), SPX (`^GSPC`), Gold (`GC=F`). Output por símbolo: `{value, change_24h_pct, trend_5d}`. User-Agent obligatorio. Cache 30min coin-agnóstico (`macro:global`) / negativo 10min. `closes[]` puede traer `null` (festivos/intradía) — se filtran antes de calcular trend.
  - **SMC** (`technical[tf].smc`): `utils/smc.js` (funciones puras). `detectSwings`: pivote fractal lookback=2. `detectLastBOS`: itera swings newest→oldest y devuelve el **primer candle que primero rompió** el swing más reciente en dirección de tendencia HH/HL o LH/LL (continuación). `detectLastCHoCH`: mismo patrón pero en dirección opuesta (reversión). `break_candle_t` refleja el timestamp real del evento estructural, no la posición actual del precio. `detectUnmitigatedFVGs`: patrón 3 velas, mitigado si alguna vela posterior toca la zona, ventana 100 velas, top 5 por dirección. 8 tests nuevos (total 96/96).

- **Sprint D' (2026-04-27) — volatilidad implícita y SYSTEM_PROMPT v3**:
  - **DVOL** (`volatility` top-level): `deribitService.js` consume Deribit public API sin auth. Endpoint `GET /api/v2/public/get_volatility_index_data?currency={BTC|ETH}&resolution=43200`. BTC + ETH cubiertos; SOL → `null` natural (sin DVOL en Deribit). Output: `{ btc_dvol, eth_dvol, sol_dvol: null }`. Cada uno: `{ value, regime, change_24h_pct, source }`. Regime: `panic >80 / elevated 60-80 / normal 40-60 / complacent <40`. Cache 5min. Degraded mode (null en fallo).
  - **SYSTEM_PROMPT v3_extended_context**: `anthropicService.js` actualizado de `v2_quantitative`. Nuevas secciones: B2 (Order Book Imbalance como ajuste al Volume Flow Score), B3 (Volume Profile POC/VAH/VAL/HVN/LVN), E (On-Chain Score -2..+2 con MVRV/NUPL/SOPR), F1-F5 (Macro + ETF Flows + DVOL + SMC + Liquidation Clusters como contexto institucional sin score directo).

- **Fase 15 (2026-04-27) — tests de integración**:
  - `backend/tests/integration.test.js` — 47 tests con supertest. Cubre: `GET /health`, `GET /api/data` (candles, indicadores, degraded mode, validación), `GET /api/analyze/payload` (todos los bloques top-level: smc, volume_profile, order_book, macro, volatility, onchain, etf_flows, timeframe_analysis, distance fields), `GET /api/history/:coin` (paginación, clamp, validación), `POST /api/analyze` (stub LLM), 404/error handler.
  - `src/app.js` extraído como factory `createApp()` — separa construcción del app de `app.listen()`, necesario para importar en tests sin `EADDRINUSE`.
  - `src/index.js` simplificado: importa `createApp`, llama `listen()` por separado.
  - **Bug fix `historyController`**: `parseInt('0', 10) || 10` evaluaba a `10` (el `|| 10` pisaba el `0` explícito del usuario). Corregido con `Number.isFinite(rawLimit) ? rawLimit : 10`.
  - **Total: 158/158 tests pasan** (111 unitarios + 47 integración).

- **Sprint Audit (2026-04-27) — auditoría técnica y fixes de correctitud**:
  - **SuperTrend (CRITICAL)**: bandas inicializadas con la primera vela (antes `0`, lo que rompía el "stickiness" en la 1ª iteración). El multiplicador adaptativo se aplica ahora a TODA la serie (antes solo a la última vela, produciendo discontinuidades artificiales en el `trend` final).
  - **ADX naming**: variable interna `atr` renombrada a `smTR` (era una suma suavizada Wilder, no un ATR). El ratio `smPlusDM/smTR` queda matemáticamente idéntico.
  - **`calculateSupportResistance`**: clustering ya no es path-dependent — los precios candidatos se ordenan antes del agrupamiento (greedy fallaba si el primer high del slice era outlier). Reclasificación cruzada por posición real respecto al precio actual: clusters de highs que tras promediar quedan por debajo del precio se cuentan como soporte (antes se descartaban silenciosamente).
  - **`detectRSIDivergence`**: pivot fractal `lookback=2` (alineado con SMC), antes pivot simple de 3 velas → ruidoso en ranging. Serie RSI iterativa O(n) (antes O(n²) llamando `calculateRSI(slice)` por cada vela).
  - **`calculateStochRSI`**: misma optimización O(n²)→O(n) en serie RSI interna.
  - **`computeTrend`**: ADX no contribuye al score estructural cuando `regime === 'ranging'` (antes su `trend_direction` era ruido estadístico que sesgaba el bias).
  - **`calculateCVD` divergence**: añadido threshold 0.1% sobre `priceChange` para evitar divergencias falsas con movimientos de precio mínimos.
  - **`onchainService.num()`**: usa `Number.isFinite` para protegerse contra strings no-numéricos como `"N/A"` (antes `parseFloat("N/A") = NaN` colaba al payload).
  - **`coinalyzeService.fetchFundingRate`**: campo `severity` (`normal/elevated/high/extreme`) calculado en el servicio, expuesto por igual en `/api/data` y `/api/analyze/payload` (antes solo en analyze).
  - **`analysisController` S/R**: eliminado el reordenado por `Math.abs(currentPrice - price)` que rompía la semántica "supports[0] = más cercano por debajo". `calculateSupportResistance` ya garantiza el orden correcto.
  - **Precisión numérica**: MACD/ATR/CVD/VWAP cambiados de `toFixed(8|4)` a `toFixed(2)` — para BTC ($90k) los decimales extra eran ruido que degradaba la legibilidad del LLM.
  - **RSI guard**: caso `avgGain===0 && avgLoss===0` (precio totalmente flat) devuelve `50` (antes `NaN` por `0/0`).
  - **`calcMitigationPct` SMC**: comentario corregido (mide overlap individual máximo, no acumulado — semántica SMC clásica). Función muerta `isMitigated` eliminada.
  - **Cache armonizado**: `deribitService` usa el mismo patrón `cached.__empty ? null : cached` que el resto.
  - **`onchainService` catch path (2026-04-27)**: `cacheSet(cacheKey, null, ...)` → `cacheSet(cacheKey, { __empty: true }, ...)`. El armonizado anterior solo había llegado a `deribitService`; aquí el `null` se interpretaba como cache miss y cada request post-fallo re-pegaba bitcoin-data.com, agotando la cuota free (15 req/día) en minutos. Ahora el sentinel bloquea reintentos durante `onchainNegativeTtl` (30 min) como pretendía el diseño original.
  - **12 tests nuevos** cubriendo: RSI flat market, BB stdDev=0, ADX ranging, SuperTrend UP↔DOWN transitions, CVD con `taker_buy_base` corrupto (NaN/negativo/>volume), Volume Profile single-bin, computeTrend con ADX en ranging vs trending. **111/111 tests pasan**.

- **Sprint Briefing (2026-04-27) — deficiencias de dataset + prompt**:
  - **D1** (`coinalyzeService`): `severity_negative` simétrico para funding negativo (`elevated/high/extreme_short_overload`). El campo `severity` (positivo) se mantiene sin cambios.
  - **D2** (`indicators.js`): `calculateCVD` ampliado a ventana 20 velas para divergencia. Añadidos campos `divergence_window_candles`, `price_change_pct_window`, `cvd_change_pct_window` al output.
  - **D3** (`volumeProfile.js` + `indicatorService.js`): Volume Profile incluye `period_start`, `period_end`, `candles_covered`. Flag `valid`, `poc_distance_pct`, `invalid_reason` calculados en `indicatorService` donde se conoce el precio actual.
  - **D4** (`analysisController`): CVD summary añade `change_pct_24h`, `high_7d`, `low_7d`.
  - **D5** (`liquidationClustersService`): Cada cluster incluye `total_usd_display` ("182.74M") y `unit: 'usd'`.
  - **D6** (`indicatorService`): Fibonacci estructurado como `{ swing_high, swing_low, swing_high_date, swing_low_date, type: 'retracement', levels[] }`.
  - **D7** (`coinalyzeService`): L/S Ratio incluye `source: 'coinalyze'`.
  - **D8** (`analysisController`): ETF flows enriquecido con `data_lag_days`, `data_freshness`, `freshness_warning`.
  - **D9** (`analysisController`): `exchange_netflow_unavailable_reason: 'not_in_free_tier'` cuando el campo es null.
  - **D11/D12** (`analysisController`): Liquidations history 7d y CVD summary devuelven `null` si hay menos de 2 puntos históricos (evita datos espurios 7d ≡ 24h con servidor recién arrancado).
  - **D13** (`indicatorService`): Payload de TF incluye `trend_basis: 'ema_cross_swing'` y `momentum_alignment` (bool: el computeTrend coincide con SuperTrend).
  - **D14** (`indicators.js`): Bollinger Bands incluye `window` y `std_dev_mult`.
  - **D15** (`macroService`): `macro_regime` ('risk_on' / 'risk_off' / 'mixed') + `macro_regime_basis` sintetizados desde SPX/DXY/Gold.
  - **D21** (`indicatorService`): `last_bos` anotado con `valid`, `invalid_reason`, `retracement_pct` (precio retrocedió por debajo del nivel roto = `valid: false`).
  - **D22** (`analysisController`): `price_source: 'binance_spot'` + `price_timestamp_utc` en el raíz del payload.
  - **P1** (prompt): Regla FUNDING NEGATIVO simétrica con +1/+2 al Derivatives Score según `severity_negative`.
  - **P2** (prompt): Regla BOS POST-RETROCESO (usa `last_bos.valid`) + regla de secuencia CHoCH→BOS trampa estructural.
  - **P3** (prompt): Fallback de Volume Profile cuando `poc_distance_pct > 5` o `valid=false`.
  - **P4** (prompt): Regla VWAP como ajuste de convicción (no scoring directo).
  - **P5** (prompt): Estado PREPARAR como cuarto output (setup cargado pero sin trigger confirmado).
  - **P6** (prompt): Interacción multiplicativa ETF Flows × Funding (+0.5 conviction en co-ocurrencia).
  - **P7** (prompt): Nomenclatura de TFs estandarizada (`"1h"`, `"4h"`, `"1D"`, `"1W"`). Versión: `v4_2_briefing_fixes`.
  - **10 tests nuevos** cubriendo: CVD divergencia explícita (4 tests), VolumeProfile metadata (3), Bollinger Bands metadata (3). **168/168 tests pasan** (121 unitarios + 47 integración).

- **Sprint Schema (2026-04-27) — rediseño persistencia IA**:
  - **`config/db.js`**: DROP de la tabla `analyses` antigua + CREATE de 4 tablas nuevas con índices: `analyses` (~70 campos), `analysis_tf_snapshot` (4 filas/análisis, una por TF), `analysis_outcome` (vacía, rellena con job futuro), `analysis_liquidation_snapshot` (hasta 10 filas/análisis).
  - **Campos añadidos respecto al diseño inicial**: `funding_severity TEXT` (severidad positiva, junto a `funding_severity_negative`), `ob_imbalance_top5_ratio REAL` (junto a `ob_imbalance_ratio`), `wave_trend_signal TEXT` en `analysis_tf_snapshot`.
  - **`services/dbService.js`**: `saveAnalysis({ header, tfSnapshots, clusters })` — transacción atómica. `pruneOldAnalyses()` borra en cascada en las 4 tablas. `getAnalysisHistory()` expone `action`, `confidence`, `risk_score`, `executive_summary`, `primary_driver`, `score_total`.
  - **`services/anthropicService.js`**: OUTPUT FORMAT actualizado a JSON puro `{structured, narrative}` — sin markdown, sin bloques de código. `analyzeMarket()` implementado con import dinámico del SDK, parse + validación de estructura, `AppError 502` si el JSON es inválido. `PROMPT_VERSION = 'v5_0_structured_output'`.
  - **`controllers/analysisController.js`**: Tres helpers nuevos: `buildAnalysisHeader()` (mapea ~70 campos del contexto + LLM output), `buildTfSnapshots()` (4 filas, una por TF, incluyendo `wave_trend_signal` y `fvg_bullish/bearish_count` desde `smc.unmitigated_fvgs.bullish/bearish`), `buildClusterRows()` (hasta 10 filas de clusters). Respuesta de `POST /api/analyze` actualizada a `{structured, narrative, ai_metadata}`.
  - **`tests/integration.test.js`**: mock de `analyzeMarket` actualizado al nuevo formato. Test nuevo `analysis is persisted — history returns it after POST` verifica que un análisis queda en BD y `GET /api/history/SOL` lo devuelve con los campos correctos. **169/169 tests pasan** (121 unitarios + 48 integración).
  - **Deuda técnica anotada**: FVGs detallados (tabla separada), S/R strength del nivel más cercano, SuperTrend level numérico, `volume_history.vwap` top-level, job `analysis_outcome`. Ver SESSION_STATE.md §6.

- **Deploy nativo en la Pi + fix `last_analysis` (2026-07-03)**:
  - **Deploy nativo + systemd** (no Docker) — ver §Deploy. Cambio de código habilitante: en `app.js`, con `NODE_ENV=production` y si existe `frontend/dist/index.html`, Express sirve el SPA (`express.static` + fallback `app.get(/^(?!\/api|\/health).*/)`) desde el mismo origen que la API. `security.js`: `helmet({ contentSecurityPolicy: false })` (el SPA usa `style=` inline; app single-user en LAN). Gated a producción → dev (Vite) y los 264 tests intactos. Nuevo `scripts/deploy.sh` (build + rsync + restart systemd).
  - **Fix `last_analysis` (bug preexistente)**: en `dataController`, `getLastAnalysis()` va dentro del `Promise.allSettled` pero se usaba **sin `resolve()`**, devolviendo el resultado settled crudo → `last_analysis: {}` (campos `undefined`). Rompía el panel "Análisis Previo" del sidebar desde el rename del Sprint Schema. Corregido con `const lastAnalysisRow = resolve(lastAnalysis)`. Commits `31f748d` (deploy) + `c1b5de2` (fix).
  - **S/R strength persistido (deuda §6 resuelta)**: `analysis_tf_snapshot` guardaba solo la distancia % al nivel más cercano, no su fuerza. Ahora persiste `nearest_support_strength`/`nearest_resistance_strength` (escala 0-5 = `min(floor(touches/2),5)`, ya calculada por `calculateSupportResistance`). `computeLevelDistances` (exportada) coge el `strength` de `supports[0]`/`resistances[0]`; migración idempotente `ensureColumn` en `db.js`; INSERT ampliado en `dbService`. 4 tests nuevos (`levelStrength.test.js`). Migración verificada en la Pi (filas viejas → NULL).
  - **SuperTrend level persistido (deuda §6, media prioridad)**: `analysis_tf_snapshot` guardaba solo `supertrend_direction`, no el nivel numérico. Ahora persiste `supertrend_level REAL` (banda de soporte en UP / resistencia en DOWN, vía helper puro `supertrendLevel(st)` exportado). Mismo patrón `ensureColumn` + map + INSERT. 3 tests. **Nota:** estos ítems de snapshot son de *persistencia* (enriquecen historial/backtesting) — el LLM ya recibía el dato en el payload en vivo. 271 tests.

- **Sprint Backend Gating (2026-07-06) — mover cálculo determinista del prompt al backend (PROMPT_VERSION v6_0_backend_gating)**. Motivado por una auditoría externa: el prompt había acumulado demasiadas reglas de umbral que el LLM recalculaba a mano. El principio del sprint: el backend precalcula flags; el LLM interpreta. Neto: ~60 líneas de prompt borradas + 4 cálculos movidos al backend, sin tocar la calidad analítica. 271 → 298 tests.
  - **Poda de redundancia (Cubo A)**: eliminados del prompt los umbrales numéricos que duplicaban flags categóricos ya emitidos (`funding_rate.severity`/`severity_negative`, `imbalance_signal`). F1 Macro ahora consume `macro.macro_regime` (ya sintetizado en `macroService`) en vez de re-derivar DXY/SPX/Gold a mano. On-chain se dejó intacto (sus buckets de score no mapean 1:1 con las etiquetas → riesgo de colisión).
  - **Vetos al backend (`utils/gating.js` → `computeVetos`)**: el HARD GATING (AND de 3 condiciones de VETO LONG/SHORT) se calcula ahora en código sobre la S/R del **TF primario**, exigiendo dato presente (no veta sobre datos ausentes). Se expone en el bloque `gating` del payload; el prompt obedece `gating.veto_long/veto_short`. El veto del backend es **autoritativo sobre la acción**, no solo sobre la columna persistida: en `applyDecisionGates` (`services/decisionGates.js`, llamado desde el handler `analyze()`), si `veto_long||veto_short`, se impone `gating_active=true` en el `structured` **antes** de `validateAnalysis` → el validador dispara `gating_forces_wait` (severo) si el LLM desobedeció (`action != Esperar`) y el fail-safe degrada a `Esperar` (neutraliza el setup). El hard gate degrada **con independencia de `ANALYSIS_FAILSAFE_ENABLED`** (ese flag solo gobierna las violaciones de reglas del prompt). Así el hard gate no depende del cumplimiento del LLM ni del flag de observación. 22 tests (`gating.test.js`) + 8 (`decisionGates.test.js`).
  - **Contradicciones al backend (`computeContradictions`)**: 5 de las 6 del CONVICTION DECAY se precalculan (`gating.contradictions[]` + `contradiction_count`); la 6ª (Volume<0 con Structure>0) la suma el LLM porque depende de sus scores. Nuevo campo de salida `structured.missing_confirmations[]` (idea del auditor: explicación legible de por qué NO se opera), **persistido** como columna JSON `missing_confirmations` en `analyses` (`ensureColumn`) y devuelto por `getAnalysisHistory`.
  - **SMC `signal_status` (`calculateSMC`)**: `active/context/expired` precalculado por evento (BOS/CHoCH) y FVG según antigüedad (sub-umbral `ACTIVE_CANDLES_AGO_BY_TF`) y mitigación. Borró el bloque de decay más grande del prompt (~35 líneas / 4 tablas por-TF).
  - **Flags baratos**: `cvd.cvd_strength` (marginal/moderate/strong — **auto-normalizado por terciles de la propia serie** desde v7_0, antes cortes fijos 2%/8%), `vwap.price_vs_vwap`, `volume_profile.price_vs_poc` + `excursion` (above_vah/below_val) en `indicatorService`; `liquidation_clusters.magnetic_long/short_zone_active` en `liquidationClustersService`. El prompt lee los flags en vez de comparar rangos.
  - Verificado end-to-end contra `/api/analyze/payload` con datos reales (gating, contradictions, todos los flags poblados). **298/298 tests.**
  - **Fix post-sprint (revisión crítica)**: el veto del backend no forzaba la *acción*, solo la columna persistida (`buildAnalysisHeader` hacía OR) — el fail-safe se guiaba por el `gating_active` auto-reportado del LLM, así que un LLM que desobedeciera el veto (`Comprar` con `gating_active=false` y scores que pasan la puerta) se persistía y devolvía tal cual. Ahora `applyDecisionGates` (extraído del handler `analyze()`) impone `gating_active=true` sobre el `structured` **antes** de validar (el fail-safe degrada a `Esperar`); OR redundante del header eliminado. Además la contradicción `no_active_smc_structure` pasa a exigir `signal_status="active"` (una señal en `context` ya no cuenta como confirmación, alineado con "fuera del umbral táctico" del prompt). Y se persiste el conteo determinista del backend: columnas `contradiction_count INTEGER` + `contradiction_codes TEXT` (JSON de códigos) en `analyses` (`ensureColumn` idempotente, filas viejas → NULL), mapeadas desde `context.gating` en `buildAnalysisHeader` y devueltas por `getAnalysisHistory` — telemetría separada del `contradictions_found` booleano del LLM. **300/300 tests.**

- **Sprint Remediación Auditoría Red-Team (2026-07-07) — 17 hallazgos en 5 fases (PROMPT_VERSION v6_0 → v6_4)**. Auditoría externa "red team" del pipeline de decisión que identificó tres fallos estructurales: circularidad de validación, confluencia inflada por correlación/doble conteo, y backtesting no concluyente. Remediación por fases, cada una con tests y commit propio. **300 → 364 tests.** Herramienta de evidencia: `backend/scripts/auditStats.mjs` (read-only) cuantifica sesgo a Esperar, frecuencia de contradicciones/vetos, muestra real del backtest y fill-rate.
  - **C1 (temperatura)**: `analyzeMarket` enviaba a la API sin `temperature` → sampling por defecto del modelo → decisiones no reproducibles. **Corrección posterior (commit `b464100`):** los modelos actuales (Opus 4.8 / Sonnet 5, familia Claude 5) **DEPRECAN `temperature` — la Messages API responde `400` si se envía**, así que NO se puede fijar en 0. Por eso `env.analysisTemperature` es `null` por defecto y `buildLlmRequest` **omite** el campo (escape hatch `ANALYSIS_TEMPERATURE` reservado para un modelo futuro que sí lo acepte). **Limitación conocida (C1 no cerrado del todo):** al no poder pasar `temperature`, la reproducibilidad NO está garantizada a nivel de API — los análisis corren con el sampling por defecto del modelo, no con un valor fijado. Mitigado hasta donde la API permite; si el determinismo importa para interpretar el backtest, tenerlo presente.
  - **C3 (BTC context)**: el BTC DOMINANCE OVERRIDE inferia la estructura de BTC de `technical["1D"].trend`, que en ETH/SOL es el trend del **alt**. Nuevo bloque `btc_context` (trend_1d/1w reales de BTC vía klines; `source:'self'` para BTC) en `buildAnalyzeContext`; prompt corregido.
  - **M3 (parse/schema)**: `extractJson` con escaneo balanceado de llaves (ignora `}` en strings/prosa) en vez del `slice` greedy; `assertStructuredShape` lanza 502 si faltan campos requeridos (antes se persistían `undefined`).
  - **Gating (`utils/gating.js`)**: **H3** vetos LONG/SHORT SIMÉTRICOS (mismos ejes CVD 1D + OI + S/R; se retira la condición de funding asimétrica). **H2** FAIL-CLOSED: `data_insufficient` cuando falta CVD 1D u OI → `applyDecisionGates` bloquea direccionales (flag `GATING_FAIL_CLOSED_ON_MISSING`, default true). **H1** ausencia de estructura SMC ya NO es contradicción (→ `missing_structural_confirmation`); solo un CONFLICTO activo (BOS vs CHoCH opuestos) cuenta; `price_near_key_level` exige 2+ toques. **H4** `computeGating` deduplica veto↔contradicciones. **M4** 6ª contradicción del validador ahora simétrica. Verificado: SOL `contradiction_count` 4→3.
  - **Scoring**: **C2** guardia de divergencia (`utils/expectedScores.js`): el backend calcula el score direccional esperado (coarse) de Derivatives/Volume desde el dato; el validador emite `score_divergence_<block>` (severe → degrada) si el LLM abre la puerta contra el dato → la puerta deja de validarse solo contra el auto-reporte del LLM. **C4** prompt: CVD primario (VD/OBV confirmación, no 3 votos); Structure ancla en estructura de precio, no re-puntúa los osciladores de Execution. **H5** dead-bands en `computeTrend` (`signWithDeadband`) contra el flicker sub-tick. **B2** `backendScoreTotal` reproducible. Columnas nuevas: `score_total_backend`, `score_derivatives_expected`, `score_volume_expected`.
  - **Backtesting**: **C5** `utils/stats.js` (IC de Wilson); `getOutcomeStats` reporta win-rate solo con muestra ≥20 (si no, `sample_insufficient`), + IC, + `directional_n`, + segmentación por `primary_tf`/`model_used`. **H6** `setup_fill_rate` (los `not_triggered` cuentan) + warnings `setup_entry_far`/`setup_low_rr`. **M2** baseline del outcome anclado a klines (misma fuente que los horizontes). Frontend: el modal muestra IC / "muestra insuficiente" en vez de un % engañoso.
  - **Menores**: **B1** ANTI-DOUBLE-COUNT RULE en el prompt (funding/LSR/F&G/ETF son crowding correlacionado, no votos independientes). **B3** el término de interacción ETF×Funding pasa de `±0.5` numérico (sin respaldo) a señal **cualitativa**; `auditStats.mjs` es la herramienta para validarlo/retirarlo con datos reales de la Pi.

- **Seguimiento revisión crítica (2026-07-10, PROMPT_VERSION v6_4 → v6_5_block_dedup)** — 3 hallazgos de una relectura interna previa a la 2ª auditoría. 364 → 372 tests. **Desplegado a la Pi y verificado en vivo** (ver último bullet).
  - **C1 corregido en la doc (no en el código)**: el fix de temperatura se había revertido (los modelos Claude 5 devuelven 400 si se envía `temperature`) pero el changelog seguía afirmando "fijada a 0". Reescrito el bullet de C1 para reflejar que `temperature` se OMITE y que la reproducibilidad NO está garantizada a nivel de API (limitación conocida, no cierre total).
  - **Guardia de volumen C2 reenganchada al CVD del TF primario** (`utils/expectedScores.js`): `expectedVolumeScore` derivaba el score de `buy_pressure_pct`, que se acumula sobre toda la ventana del TF (168–180 velas) → pegado a ~50 → la guardia de divergencia de volumen casi nunca se disparaba (no daba el chequeo independiente que prometía). Ahora usa `technical[primaryTf].cvd` (trend/divergence/cvd_strength) con **CARVE-OUT de absorción**: ante `divergence != "none"` la guardia se ABSTIENE (score 0), porque la divergencia CVD↔precio es la lectura de absorción que el prompt considera ALCISTA — solo puntúa el caso alineado (agresión/capitulación), donde el signo es inequívoco. `computeExpectedScores` pasa a leer el CVD (ya no el order book).
  - **Contradicciones deterministas de-correlacionadas por BLOQUE** (`utils/gating.js`): `contradiction_count` pasa de contar señales sueltas a contar **bloques analíticos distintos** (volume/derivados/estructura, máx 3). Varias señales del mismo bloque (precio en nivel + conflicto 1W/1D + conflicto SMC = todas 'estructura') cuentan como una — mismo principio B1/H4 aplicado a la ruta sin veto, para que la puerta de >=3 → Esperar no se dispare por hechos correlacionados del mismo eje. Nuevo campo `gating.contradiction_blocks[]`; prompt CONVICTION DECAY actualizado.
  - **Churn del backtest acotado** (`services/outcomeService.js`): un setup con `has_executable_setup=1` pero `entry_price` nulo (geometría irreconstruible y **permanente**) se marca `setup_outcome='invalid'` de inmediato en vez de esperar al horizonte de 7d re-evaluando el barrier en balde cada ciclo. Cubierto por `tests/outcomeService.test.js` (4 tests: `runOutcomeJob` con mocks ESM de coingecko/dbService — invalid inmediato, preservación, y contraste con setup válido open/tp1).
  - **Desplegado a la Pi (2026-07-10)** con `deploy.sh` y **verificado en vivo** contra `/api/analyze/payload` (SOL/4h): `prompt_version=v6_5_block_dedup` sirviéndose; el dedupe por bloque colapsa 3 señales (`oi_flat_or_falling`+`price_near_key_level`+`htf_conflict_1w_1d`) → **2 bloques** (`derivatives`+`structure`); la guardia de volumen se **abstiene** con CVD 4h `marginal`. `.env` de la Pi saneado de paso: `NODE_ENV`/`PORT` alineados a production/8080 (eran inertes — systemd los sobrescribe) y retirada la key huérfana `OPENROUTER_AI_API_KEY` (no la usa ningún módulo).

- **Sprint 2ª Auditoría Red-Team (2026-07-10/12, PROMPT_VERSION v6_5 → v6_8_atr_levels)** — auditoría interna exhaustiva del pipeline de decisión (18 perspectivas) que encontró 3 críticos nuevos + serie de altos/medios. Remediación en 5 fases (0-4), cada una con tests y commit. **372 → 399 tests.** Detalle completo en `doc/SESSION_STATE_2026-07-26_pre-fase-afinado.md` §26.
  - **Fase 0 (verificación)**: OI de Coinalyze confirmado en MONEDAS BASE (103.610 BTC vs $6,64B con `convert_to_usd=true`); telemetría de la Pi vía `auditStats.mjs`: 10 análisis, 100% Esperar, la pata CVD del veto nunca había disparado.
  - **Fase 1 (críticos, `cce76c4`)**: (1) **leak de `expected_scores` al LLM cerrado** — `buildPrompt` lo excluye del dataset (el modelo podía copiar el score esperado y anular la guardia C2; sigue en payload/BD para telemetría); (2) **PnL firmado** — `pnl_signed_pct_24h` (× dir, solo Comprar/Vender) + `avg_pnl_signed_pct_24h` agrega SOLO direccionales (el promedio del pnl crudo sobre todas las acciones era deriva del mercado, y un short ganador restaba); (3) dedupe OI↔veto (`oi_flat_or_falling` en `DEDUPE_CODES`); (4) validador: `primary_driver_enum`, `setup_tp_side`/`setup_stop_eq_entry` → SEVERE con setup ejecutable.
  - **Fase 2 (`9ae2d12`, v6_6)**: **semántica CVD/absorción unificada** — la divergencia CVD 1D tenía 3 tratamientos incompatibles (prompt: absorción MUY ALCISTA sobre soporte / guardia C2: abstención / veto: evidencia bajista inapelable). La pata CVD del veto y la contradicción exigen ahora `cvd_strength` no-marginal; prompt añade DESAMBIGUACIÓN ESTRUCTURAL (la tesis de absorción no puede argumentar contra un veto activo — la conjunción divergencia real + resistencia probada + OI estancado ya la descartó) y ANTI-DOBLE-DESCUENTO (si `cvd_1d_divergence` está en `gating.contradictions`, la bandera CVD 1D no reduce convicción otra vez).
  - **Fase 3 (`498851e`, v6_7)**: **unidad OI honesta** (`value_coins` canónico + USD derivado `withDerivedOiUsd`; columna `analyses.oi_value_coins`; summary `*_coins`; filas pre-fix distinguibles por coins NULL); **puerta de PREPARAR** (`prepare_gate` severe: Preparar CON setup ejecutable exige derivatives>=+1 y structure>=0 — era la vía de escape del gating; guardia C2 cubre Preparar por geometría del setup; fail-closed H2 bloquea Preparar accionable con datos ausentes); `crowded_trade_flag` fail-closed (dato ausente ya no activa el flag); `price_timestamp_utc` = `fetched_at` real del fetch del precio.
  - **Fase 4 (`1d077cd`, v6_8)**: **ATR en `technical[tf].atr`** (faltaba en el payload; proxy de vol realizada para SOL); **umbral de niveles normalizado** (`dynamicNearLevelPct` = 1.5×ATR%, clamp [0.5,3], fallback 1.5 → `gating.near_level_pct_used`); **telemetría borderline** (`gating.borderline[]` — condiciones a ≤0.25pt/1.25× del umbral; histéresis real exigiría estado); **inventario hechos→consumidores en BLUEPRINT.md** (regla "un dueño por capa" contra dobles conteos futuros).
  - **Pendientes deliberados**: Fase 5 (backtest falsable: coste de oportunidad de Esperar, win-rate path-aware, de-dup por episodio para el IC de Wilson, calibración de conviction) espera muestra acumulada; ajustes ±0.5 del prompt y 6ª contradicción se revisan con datos de `auditStats.mjs`. **v6_7+v6_8 DESPLEGADOS y verificados en producción** (2026-07-26: `prompt_version=v6_8_atr_levels` sirviéndose en la Pi, `near_level_pct_used=1.38` ATR-normalizado y dedupe por bloque activos en un análisis real de SOL).

- **Revisión crítica + auditoría de umbrales (2026-07-26, v6_8 → v7_0_calibrated)** — revisión de todo el proyecto (uso, payload, prompt, cron, infra, medición) documentada en [`doc/REVISION_CRITICA_2026-07-26.md`](./doc/REVISION_CRITICA_2026-07-26.md). **399 → 442 tests.**
  - **Hallazgo de fondo:** ninguna constante de corte del sistema se había validado nunca contra la distribución de la magnitud que bucketiza. Medidas con `backend/scripts/auditThresholds.mjs` (funciones reales del backend sobre ventanas rodantes del tamaño de producción, SOL + BTC/ETH de control), **5 de 13 estaban mal calibradas y los fallos replicaban en las tres monedas**. Patrón: los umbrales revisados con un caso concreto delante (decay SMC, mitigación FVG, `ADX_RANGING`) estaban bien; los números redondos (2 %, 8 %, 25, 3 toques, 2×, techo 3 %) estaban mal.
  - **T1 · `high_volatility` era rama muerta** (0,0 % en las 12 combinaciones moneda × TF): el ATR de Wilder está autocorrelacionado con su propia SMA, así que el cociente nunca despegaba de 1. Ahora percentil 90 del ATR% **Y** expansión ≥1,5× la mediana — las dos condiciones, porque el percentil solo etiquetaba un mercado plano como volátil (lo destapó un test sintético).
  - **T2 · `ADX=25` caía en el percentil ~50** (moneda al aire) y decide si `computeTrend` pondera ADX. Ahora terciles de la propia serie con el corte de Wilder como suelo absoluto.
  - **T3 · `cvd_strength`** pasa de cortes fijos 2 %/8 % a **terciles de la propia serie** + suelo absoluto 0,25 %. El corte del 2 % caía sobre la mediana del 4h y dejaba `strong` vacío por encima de 1h. Nuevos campos de telemetría `cvd_strength_pctile` / `cvd_strength_cuts`.
  - **T4 · `calculateSupportResistance` reescrito.** Alimentaba el `high` y el `low` de TODAS las velas (no pivotes) y re-centraba el cluster con media incremental sobre precios ordenados → el ancla derivaba y encadenaba (100 candidatos → 8 clusters, 88 % excediendo su tolerancia hasta ×2,2). `touches` medía **tiempo de permanencia, no rechazos**, y el filtro "3+ toques" del veto admitía el 89 % de los niveles. Ahora: **pivotes fractales + ancla fija + `SR_LOOKBACK=100` + `SR_MIN_TOUCHES=1`** (con pivotes, un toque ya es un rechazo real; exigir 2 dejaba el 1W sin niveles). `>=3 toques` pasa a seleccionar el 22 % en 4h.
  - **T5 · techo del clamp por TF** (2/4/10/25 % en 1h/4h/1D/1W): el tope único de 3 % saturaba el 100 % de las ventanas en 1D/1W — la "normalización por ATR" era allí una constante disfrazada.
  - **T6 · banda de `priceSide`** = 0,25 × ATR% en vez de ±0,05 % fijo (el estado `at` salía al 0-2,5 %: campo binario de facto).
  - **Refactor:** `calculateATRSeries` / `calculateADXSeries` + núcleo compartido `adxCore` — los escalares públicos son el último elemento de su serie (no pueden divergir) y se evita un O(n²) por re-slicing.
  - **Telemetría añadida (categoría A, sin tocar la decisión):** `analysis_tf_snapshot.cvd_strength` + `cvd_delta_vs_volume_pct` — sin esa covariable era imposible separar a posteriori "el modelo eligió Esperar" de "no se le permitió otra cosa". Backup diario `scripts/backupDb.sh` (VACUUM INTO + `integrity_check` + rotación 14 d, cron 03:10 UTC). `deploy.sh` ahora sincroniza `scripts/` y `backend/scripts/` (antes derivaban en silencio). `dbClear.mjs` no borraba `analysis_fvg_snapshot` → filas huérfanas; corregido.
  - **Resultado verificado en producción:** `cvd_strength` 35/34/31 en 4h (antes 52/47/**0**), `high_volatility` 3,3-10,4 % (antes 0,0), S/R `>=3 toques` 22,1 % (antes 89,1), densidad de niveles conservada (5,4/ventana). **El veto disparó por primera vez** (`veto_short`: CVD 1D bullish moderate + OI −3,09 % + soporte a 0,63 % con 5 toques) — con la calibración vieja ese CVD habría salido `marginal`. Confirma que el camino no estaba muerto, estaba tapado por el umbral.
  - **Prompt condicional + poda del dataset (v7_1_conditional_blocks):** `buildSystemPrompt(ctx)` retira las secciones E (on-chain), F2 (ETF flows) y F3 (DVOL) cuando el dato no está presente — para SOL son ~61 de 733 líneas de reglas inaplicables pagadas en cada análisis. Se **filtran, no se borran**: BTC/ETH conservan la capacidad, y si un servicio falla en un análisis de BTC la sección cae sola. `llm_request.prompt_blocks` registra cuáles viajaron. `buildPrompt` retira además `buy_pressure_pct`/`sell_pressure_pct` del dataset del LLM (clavados en ~50 por acumularse sobre toda la ventana; siguen en payload y en `analysis_tf_snapshot`). Medido en producción: system −10,9 % (35.000 → 31.202 chars). El dataset creció un 7,5 % por la telemetría nueva y por unos S/R más ricos, así que el ahorro NETO es del 1,8 % — pero el efecto buscado no era el coste sino retirar instrucciones inaplicables, y de paso la relación se invirtió: ahora hay más datos (36.867) que instrucciones (31.202).
  - **Pendiente:** grupo 2 de la auditoría (funding `severity`, LSR contrarian 60/40, `SCORE_WEIGHTS`) requiere histórico de Coinalyze, no medible con klines.

- **Prompt v8_0 — aprovechar el payload entero (2026-07-27, `v7_2` → `v8_0_full_payload`)** — auditoría del prompt cruzando las 651 claves del dataset contra las referencias del system. Resultado de partida: **0 referencias rotas** (el prompt no pedía ningún campo inexistente), pero varios bloques viajaban **sin dueño**.
  - **Principio aplicado:** un prompt profesional no es el que menciona todos los campos, sino aquel en el que **cada dato tiene exactamente un dueño y un papel**. Por eso el lote tiene dos mitades: dar regla a lo que la merecía, y RETIRAR lo que ya estaba representado en otro sitio.
  - **Reglas nuevas** (cada una consume un flag precalculado, nunca un número crudo):
    - **B4 · Régimen de volatilidad** — `bollinger_bands.volatility_state` (squeeze/normal/expansion) **calculado por terciles de su propia serie**: `width_pct` vale ~2,7 en 1h y ~33 en 1W para el mismo activo, así que un umbral absoluto habría sido otra constante disfrazada (fallo T5). Verificado 24-42 % por bucket en las 12 combinaciones moneda × TF — sin ramas muertas. La regla clave: **un squeeze no tiene dirección**, favorece `Preparar` con dos escenarios, no `Comprar`.
    - **B5 · Posicionamiento y participación** — `coin_market.volume_vs_30d_median` (volumen del día frente a la mediana de 30 días: normalizado **contra el propio activo**, sin introducir umbral nuevo), `turnover_pct` y `ath_change_pct`. Modulan convicción, nunca crean dirección. Con ANTI-DOBLE-CONTEO explícito frente al Volume Flow Score: participación diaria y agresión intra-vela son ejes distintos.
    - **D · Execution Score reescrito a rúbrica contable** — era el score peor especificado del sistema ("+2 = timing limpio alcista", sin criterio). Ahora es un **conteo de votos** de 5 indicadores con umbrales explícitos por indicador y una tabla suma→score. Además `momentum_alignment` (que existía desde el Sprint Briefing y nunca se usó) exige trigger explícito cuando estructura y timing discrepan.
  - **Poda por falta de dueño** (del dataset del LLM; siguen en payload y BBDD): `adx` crudo (su lectura ya viaja destilada en `regime`, que lo percentiliza, y en `trend`, que lo pondera y lo excluye en ranging — y además `adx.regime` y `technical[tf].regime` eran **dos vocabularios distintos con el mismo nombre**), `trend_basis` (constante en los 4 TFs: metadato), `distance_to_nearest_*_pct` (la proximidad ya la resuelve el gating con el umbral ATR-normalizado) y `timeframe_analysis.guidance`/`hierarchy_tiers` (**instrucciones dentro de los datos**, en inglés dentro de un prompt en español: el comportamiento debe cambiarse en un solo sitio).
  - **Coste:** dataset −4,4 % (35.634 → 34.061 chars), system +18,5 % (31.313 → 37.124). La relación se invierte respecto a v7_1: vuelve a haber más instrucciones que datos. Es deliberado —las instrucciones nuevas son aplicables y consumen campos concretos, a diferencia de las que v7_1 retiró— pero **deja abierta la hipótesis B1** ("un prompt largo induce a rellenar el formulario"), que solo la muestra puede responder.
  - Verificado en producción: **0 referencias rotas** tras el cambio, y los flags nuevos ya diferencian el mercado (1h `expansion` · 4h `normal` · 1D/1W `squeeze`, con `volume_vs_30d_median=0,49` → participación a la mitad de lo normal, justo el caso que la regla B5 degrada).

- **Prompt v8_1 — sentimiento auto-normalizado, idioma explícito y telemetría fuera (2026-07-27)**
  - **La regla de Fear & Greed estaba inerte el 87,8 % del tiempo.** Usaba cortes absolutos `<15` / `>85`: medido sobre **730 días** de alternative.me, el primero dispara el 11,2 % y el segundo el **1,0 %** (rama muerta con el mismo criterio que aplicamos al resto). Ahora hay **dos lecturas**: la absoluta se conserva (un 12 es miedo real, no relativo) y se añade `fear_greed_history.range_position_pct` — posición del valor de hoy dentro de su propio rango de 30 días. El dato ya existía a medias en el payload (`period_min/max/avg`); solo faltaba cerrarlo. Verificado en vivo: F&G=30 con rango 11-33 → `range_position_pct=86` + `trend_30d=improving` = complacencia relativa. Con la regla vieja ese mismo 30 no aportaba **nada**.
  - **Idioma especificado.** El prompt no tenía ni una mención al idioma: que el modelo respondiera en español era un efecto colateral de que las instrucciones lo estuvieran. Ahora es explícito y distingue qué va en español (los textos que ve el usuario) de qué se mantiene en inglés (claves JSON y enums internos como `primary_driver`, que mapean a columnas de BBDD).
  - **Telemetría de calibración fuera del dataset del LLM**: `width_pctile`/`width_cuts`, `cvd_strength_pctile`/`cvd_strength_cuts`, `adaptive_multiplier`. El modelo debe leer la ETIQUETA (`volatility_state`, `cvd_strength`), no el corte con el que se generó — o re-deriva el umbral que el backend ya fijó. Siguen en payload y BBDD para auditar la calibración.
  - **`gating.deduped_by_veto` retirado del dataset — este era activamente peligroso**: lista las contradicciones que el backend RETIRÓ a propósito por estar ya contenidas en el veto. Enseñárselas al modelo invita justo al doble conteo que el dedupe existe para evitar. Con él se van `contradictions_signal_count` y `contradiction_blocks_pre_veto` (auditoría, no decisión).

- **Prompt v8_2 — posición de ciclo y coherencia confidence↔conviction (2026-07-27)**
  - **`confidence` y `conviction` eran dos salidas para la MISMA magnitud sin relación definida.** El prompt dice "reducir la convicción un nivel" una decena de veces —vocabulario de la escala Alta/Media/Baja— pero el campo numérico es otro, y el validador comprobaba cada uno por separado: un `confidence:"Alta"` con `conviction:0.2` pasaba sin queja. Desde v8_2 **confidence es la discretización de conviction** con los MISMOS cortes que `convictionBucket` de `utils/stats.js` (<0.4 · 0.4-0.7 · >=0.7), de modo que la calibración de convicción del backtest mide la misma escala que reporta el modelo. Nuevo aviso `confidence_conviction_mismatch` (severidad `minor`: es incoherencia de formato, no una decisión mal tomada, así que no degrada a `Esperar`).
  - **Posición de ciclo**: `coin_market.ath_date`/`atl_date` (los servía CoinGecko y se descartaban) + `days_since_ath` derivado. Sin la fecha, un −74 % desde el ATH es ambiguo: no es lo mismo un techo de hace tres semanas (ciclo bajista joven, aún distribuyendo) que uno de hace año y medio (base larga). Es un hecho de calendario, **sin umbral que calibrar** — el prompt obliga a leer drawdown y antigüedad juntos y a declarar la lectura en la tesis. Verificado en vivo: SOL `ath_date 2025-01-19`, `days_since_ath 554`, −74,27 %.

- **Fase 5 — backtest falsable (2026-07-27)** — 457 → 518 tests. **No toca la ruta de decisión**: es medición pura, así que no invalida la muestra recogida ni exige nuevo punto cero.
  - **El problema que resuelve:** `classifyOutcome` compara precio-del-análisis con precio-al-horizonte, así que solo clasifica direccionales; `decorateOutcomeRow` calcula el win-rate sobre `win+loss`. Con `Esperar` como salida dominante el denominador es **estructuralmente 0** y `MIN_DIRECTIONAL_SAMPLE=20` no reportará jamás. No era falta de muestra: **un sistema que solo dice `Esperar` era inmune a la refutación por construcción**.
  - **Qué se mide ahora:** el RECORRIDO del precio tras cada análisis, normalizado por el ATR% del TF primario en ese instante. `classifyOpportunity` responde *"¿ofreció el mercado algo operable?"* — `targetK`×ATR en algún sentido **antes** de `adverseK`×ATR en contra. La segunda condición es la que separa oportunidad de latigazo: un +3 % precedido de un −1,5 % no era operable.
  - **Sin dirección propia, deliberadamente:** no se abre un trade hipotético en el signo de ningún score. Responde "¿había algo que operar?", no "¿en qué lado?", para no inventar una tesis que el análisis nunca formuló. El shadow trade se puede añadir después **sin re-fetch**: la rejilla de primeros cruces en ambos sentidos ya permite evaluar cualquier geometría en tiempo de lectura.
  - **Se persisten hechos, no interpretaciones** (misma lección que el PnL firmado): `analysis_outcome` guarda excursiones y tiempos de cruce; la definición de "coste de oportunidad" vive en `stats.js` y se puede redefinir sin volver a pedir un dato a Binance. `OPPORTUNITY_DEFAULTS` (2×/1×ATR) son convenciones **sin calibrar** y viajan en la respuesta.
  - **Retroactivo:** el ATR se reconstruye desde klines en vez de persistirse en el análisis, así que los análisis ya guardados también se rellenan. La re-selección del backfill está **acotada a 8 días** para no reintentar para siempre una fila cuyo ATR no se puede reconstruir (mismo churn que cerró el `setup_outcome='invalid'`).
  - **De-dup por episodio** (`utils/episodes.js`): un episodio = una vela del TF primario. Criterio objetivo derivado de `timestamp` + `primary_tf`, sin constantes nuevas que calibrar. `path_win_rate.by_episode` es la cifra honesta cuando hay varios análisis de la misma vela.
  - **Verificado contra Binance real** (SOL 4h, análisis simulado 3 días atrás): ATR% 1,28 · el precio tocó −2×ATR a las 11 h mientras al alza no pasó de 1,5×ATR (y a las 61 h) → oportunidad limpia a la baja. Exactamente el caso que el win-rate direccional no podía ver.
  - **Calibración de la métrica (mismo día, `scripts/auditOpportunityThresholds.mjs`)**: rejilla de 5 targets × 4 adverses × 2 horizontes sobre 90 días de velas 4h, SOL/BTC/ETH (n≈578 anclas/moneda). **Tres hallazgos:** (1) el par por defecto 2×/1× a 24h cae en el **34,8 % de media** (SOL 35,1 · BTC 34,4 · ETH 34,9) — banda plenamente discriminante, la convención estaba bien elegida y **no se cambia**; (2) el **horizonte de 7d discrimina mal** (67-69 % en el par por defecto, y la esquina superior de la rejilla satura al **100 %** en las tres monedas: a 7 días casi cualquier objetivo de 1×ATR acaba tocándose limpio) → se reporta como CONTEXTO, no como evidencia (`base_rate_discriminates: false`); (3) `4×ATR` a 24h es rama muerta (≤5 %) en SOL/BTC. La coincidencia de las tres monedas a menos de 1 punto indica que la tasa base es propiedad del recorrido cripto normalizado por ATR, no de SOL.
  - **`OPPORTUNITY_BASE_RATE` — la referencia que faltaba**: sin ella `offered_pct` es un número flotando. Si los `Esperar` ofrecen oportunidad al mismo ritmo que un instante al azar, **la abstención no aporta información** por bueno que parezca el porcentaje. `summarizeOpportunity` devuelve `base_rate_pct` + `lift_pct` (la diferencia, que es lo que refuta o confirma) y el modal lo muestra como "vs. azar". Medida sobre historia de mercado y **antes** de ver ninguna decisión del sistema — ajustar el múltiplo a los outcomes de CRYPTEX reintroduciría la circularidad de validación de la 1ª auditoría. Caduca con el régimen: `measured_at` va en la respuesta y se vuelve a medir en cada revisión.
  - **Lote de afinado previo al punto cero (2026-07-27, `v7_1` → `v7_2_oi_band_levels`)** — hecho AHORA porque la muestra se descarta igualmente: cambiar código de decisión con recogida en marcha invalida lo acumulado, así que este era el único momento en que salía gratis.
    - **Banda muerta del OI** (`gating.js`): la contradicción usaba `< 0 %` y el veto `< +1 %`. Medido sobre 90 días de Coinalyze (n=534/moneda), la MEDIANA del cambio 24h del OI es ~0 (SOL −0,16 · BTC −0,26 · ETH +0,06) → el corte de la contradicción caía **justo sobre la mediana** y disparaba el 49-54 %: moneda al aire, el fallo T2 otra vez. **El diagnóstico previo ("una de las dos definiciones sobra") era incorrecto**: preguntan cosas distintas. Ahora comparten una banda muerta de ±1 % y usan cada borde — el veto `> +1 %` (expansión real para confirmar ruptura), la contradicción `< −1 %` (contracción real) → 30-38 %.
    - **`CONTRADICTION_MIN_TOUCHES` 2 → 3** = `MIN_TOUCHES` del veto: una sola definición de "nivel clave". `price_near_key_level` pasa del 77,4 % al **45,7 %** (medido tras el cambio, 208 ventanas SOL 4h) y deja de ser un fondo casi permanente del bloque `structure`. ⚠️ El "~22 %" que se anotó al principio era un ERROR: confundía la *proporción de niveles* con 3+ toques (22,1 %, auditoría T4) con la *proporción de ventanas* en que el precio está cerca de uno de ellos. Son magnitudes distintas.
    - **Banda muerta de `classifyOutcome`** normalizada a 0,25×ATR% (antes 0,3 % fijo para toda moneda y TF), con el 0,3 de fallback. Medido: reclasifica ~1 punto porcentual — **es consistencia, no un arreglo grande**; la definición dura de acierto la da el win-rate path-aware.
    - **Pares de oportunidad POR HORIZONTE**: 24h 2×/1× · 7d **4×/1×**. Un múltiplo fijo se vuelve trivial según crece la ventana (a 7d, 2×/1× saturaba al 67-69 %). El recorrido escala con √t: de 24h a 7d hay 7× de tiempo (√7≈2,6) y el objetivo pasa de 2× a 4×. Verificado: la tasa base a 7d con 4×/1× es 30-42 %, la misma banda que 24h → los dos horizontes pasan a ser comparables.
  - **Endpoint:** `GET /api/outcome/stats` añade `opportunity_cost` (24h/7d), `path_win_rate` (con `by_episode`), `conviction_calibration` y `episodes`. El modal de historial muestra el bloque **antes** del win-rate clásico — enterrarlo bajo un "muestra insuficiente" repetiría el problema que vino a resolver.

- **Lote v9_0 — el Derivatives Score pasa al backend (2026-07-29, `v8_2` → `v9_0_deterministic_derivatives`)** — 567 → **620 tests**. Levantó la congelación a los 2 días, con motivo medido (ver §CONGELACIÓN LEVANTADA).
  - **El hallazgo que lo desencadena:** el Derivatives Score es la cima de la jerarquía y lo exigen AMBAS puertas (`Comprar` >= +1, `Vender` <= −1). Medido con `scripts/auditDerivativesScore.mjs` sobre 90d × SOL/BTC/ETH, sus **dos únicas reglas numéricas disparaban el 0,0 %** del tiempo y **ninguna producía negativo**: `Vender` no era difícil, era **inalcanzable por construcción**. En producción salió 0 en 6/6 análisis, todos `Esperar`. Es el mismo defecto que v8_0 arregló para Execution ("+2 = timing limpio", sin criterio), aplicado esta vez al score que está PRIMERO en la jerarquía.
  - **La rúbrica y cómo se midió** (`scripts/auditDerivativesRubric.mjs`, n≈534 anclajes/moneda). Dos correcciones metodológicas propias durante el diseño, ambas encontradas al revisar críticamente la medición: **(1) confundido de momentum** — comparar cada celda contra la tasa base GLOBAL mezcla la información del OI con el hecho de que el precio ya venía moviéndose; al controlar por dirección de precio pasada, `OI↑px↓` **se cae** (+3,7/+4,7/−3,4: ruido) mientras `OI↓px↑` **se refuerza** (−20,2/−24,2). Sin ese control habríamos escrito una celda con el signo invertido. **(2) calentamiento de la mediana** — un tercio de los anclajes se calibró con una mediana a medio formar, **diluyendo la señal de la cascada casi a la mitad** (+14,5 → +31,3 de lift).
  - **Anti-doble-conteo en la composición:** la cascada solo suma **si la celda OI×precio calló** — medido que duplican el signo el 33-44 % de las veces. Es la regla B1 aplicada dentro del propio score.
  - **La guardia C2 habría anulado la rúbrica en silencio.** `expectedDerivativesScore` implementaba OTRA rúbrica (funding + LSR contrarian, ±1 el 33 % del tiempo por terciles): un `Comprar` legítimo con derivatives=+1 chocaba con expected=−1 → divergencia ≥2 → **SEVERE → degradado a `Esperar`**. Habría matado ~1 de cada 3 señales direccionales y en BBDD habría parecido una decisión del modelo. Término retirado; la guardia de `volume` sigue viva.
  - **Fix de unidad de liquidaciones** (`*_coins` canónico + `withDerivedLiqUsd`) y **ventana de 7 → 30 días**: con 7d la mediana coincide con la de 30 solo en el 65,7 % de los EVENTOS pese a tener casi la misma frecuencia agregada, y **en régimen ya cargado pierde el 22 % de las cascadas**. Comparar solo frecuencias lo habría ocultado.
  - **`setup_validity_candles` deja de ignorarse** (arreglo previo del mismo día): el barrier recorría los 7d completos y acreditaba como `tp1` un TP tocado tras la caducidad del setup — sesgo no neutro, porque el stop suele estar más cerca que el TP.
  - **Reglas nuevas del prompt:** setup obligatorio en direccionales (`directional_without_setup`, severe) · `conditional_setup` en `Esperar`/`Preparar` (severidad `minor`: su ausencia es defecto de reporte, no decisión mal tomada) · criterio para `validity_candles` anclado a las ventanas del backtest · precedencia explícita ante conflicto CVD entre TFs.
  - **Poda por falta de dueño (2ª pasada):** `crowded_trade_flag` (sin regla ni consumidor), los CORTES del LSR (`signal_cuts`, `long_pct_percentile` — lo mismo que v8_1 retiró para `cvd_strength_cuts`), `atl_change_pct` (+14.482 % sin lectura posible) y `derivatives_score.rubric`. Todos siguen en el payload y en BBDD.
  - **Columnas nuevas:** `score_derivatives_backend`, `derivatives_score_components`, `derivatives_data_insufficient`, `conditional_setup`, `liq_longs_24h_coins`, `liq_shorts_24h_coins`. Migraciones idempotentes; el esquema es aditivo.

- **Preflight de dashboard y prompt (2026-07-29, tras el punto cero 5)** — 630 → **635 tests**. El vaciado de la BBDD destapó una cadena de fallos que solo aparecen en el estado que nunca se prueba: base vacía + `localStorage` poblado.
  - **El panel de IA resucitaba análisis borrados.** `restoreRecommendationPanel` consulta el servidor primero, pero **no distinguía "aún no ha contestado" de "ha dicho que no hay nada"** — ambos caían al mismo `else` y pintaban la copia local. Un análisis de `v8_2` sobrevivía al borrado y al redespliegue. Flag `serverAnswered`: tras la respuesta, un `last_analysis` nulo es autoritativo y la copia local se **purga**. Se descartó un TTL (el arreglo que sugería una IA externa): seguiría pintando el fósil durante su vigencia y ocultaría un análisis legítimo pasada esta — el problema era de PRECEDENCIA, no de antigüedad.
  - **El SPA fallback devolvía 200 con HTML para assets inexistentes.** Tras un deploy el bundle cambia de hash y `rsync --delete` borra el anterior; un navegador con el `index.html` viejo en cache pedía el bundle borrado y recibía **una página web donde esperaba JavaScript**. El script no parseaba, no arrancaba nada del cliente, y quedaba el cascarón: overlay de "Cargando datos…" y canvas en negro. Ahora `/assets/` queda FUERA del regex del fallback (404 honesto) y el `index.html` va con `Cache-Control: no-cache`. ⚠️ El primer intento —una ruta aparte con `next()`— NO funcionaba: `next()` cae justo en el fallback que se quería esquivar.
  - **`updateUI` no aislaba fallos, y eso convirtió un campo ausente en un dashboard sin gráfico.** Diez actualizadores en serie con `renderChart()` AL FINAL: la excepción en `updateSentiment` mataba los cuatro paneles siguientes y el gráfico. La causa raíz era mía — renombré las liquidaciones a `*_coins` y cableé el USD derivado en el controller de *analyze*, **olvidando `dataController`**, que es el que alimenta el dashboard. Ahora cada panel corre aislado (`safeUpdate`): **el gráfico no puede depender de que los diez funcionen**.
  - **Cuatro datos mal mostrados**, encontrados capturando lo que cada panel escribe en el DOM en vez de leer código: muros de Binance con la unidad **hardcodeada a BTC** (factor 900 de error en SOL), liquidaciones en `$17281M` (unidad y formateador rotos a la vez, tapándose mutuamente), niveles S/R con falsa precisión y desalineados, y `1 touches`.
  - **`fear_greed.trend_1d` sin rama `stable`**: el ternario mandaba a `worsening` todo lo que no fuera estrictamente mayor, así que un índice PLANO reportaba deterioro — y llegaba así al dataset del LLM. Es la cuarta variante esta semana del mismo descuido (el caso del medio sin cubrir): F&G inerte, ADX cortando por la mediana, OI sin banda muerta, y esto.
  - **Auditoría del prompt simulando la llamada** (`buildLlmRequest` sin ejecutar): **0 referencias rotas** y nomenclatura de TFs coherente. Encontró un **bloque huérfano completo** —`volatility.btc_dvol`/`eth_dvol` viajaban en análisis de SOL con la sección F3 excluida— y una **colisión de nombre real**: `sentiment.fear_greed.trend_1d` (improving/worsening/stable, sin regla) contra `btc_context.trend_1d` (bullish/bearish, con regla) — el patrón que v8_0 retiró con `adx.regime`. Ambos podados. Y se desambigua en la sección A que `derivatives_score.data_insufficient` NO es `gating.data_insufficient` (colisión introducida el mismo día con la rúbrica: el segundo bloquea direccionales, el primero solo dice que la rúbrica no evaluó su eje).

- **Historial de IA: tres cosas invisibles (2026-07-31)** — 635 tests. Encontradas al pedir explicación de una entrada real del modal.
  - **La insignia de contradicciones engañaba.** Decía `2 contradic. (de 3)` y se lee como "2 de 3 bloques", pero ese 3 eran las señales CRUDAS. El conteo cuenta **BLOQUES** (volumen/derivados/estructura, máx. 3) y con los 3 la convicción decae y se fuerza `Esperar`. Ahora: `2/3 bloques: derivados + estructura`, con la escala explicada en el tooltip.
  - **`conditional_setup` no salía del backend.** Se persistía desde v9_0 pero **faltaba en el `SELECT` de `getAnalysisHistory`**, así que el modal no podía pintarlo aunque quisiera — igual que `score_derivatives_backend` y `derivatives_data_insufficient`. Es el camino de lectura que olvidé al cerrar el lote: persistir sin exponer deja el dato tan invisible como no guardarlo.
  - **`contradiction_blocks` se calculaba y se tiraba.** `gating.js` lo producía y solo se guardaban los códigos, así que el modal no podía decir CUÁLES fallan sin re-derivar el mapa en el frontend (segundo dueño para la misma regla). Ahora se persiste, y `scripts/backfillContradictionBlocks.mjs` normalizó las filas previas.
  - **Solo hay UN `conditional_setup`, no uno por dirección** — deliberado: si declarara los dos escenarios, siempre acertaría uno y el shadow trade dejaría de poder refutarlo. Obligarle a elegir dirección es lo que hace falsable la abstención.

- **Preflight pre-recogida (2026-07-29, mismo día que v9_0) — F1 + F2** — 620 → **630 tests**. Revisión exhaustiva antes de reactivar los crons; un hallazgo real y una covariable que faltaba.
  - **F1 · El Derivatives Score del backend es AUTORITATIVO sobre las puertas, no solo sobre el prompt.** El prompt ordena copiar `derivatives_score.score` en `scores.derivatives`, pero `buy_gate`/`sell_gate`/`prepare_gate` validan contra la copia — y la guardia C2 de derivatives se retiró por "no puede divergir de sí mismo", que es cierto para el cálculo y falso para la copia. Una copia inflada abría `Comprar` sin respaldo determinista; una desinflada bloqueaba un direccional legítimo dejándolo en BBDD como decisión del modelo. Fix en `applyDecisionGates` (`services/decisionGates.js`): sobrescribe `scores.derivatives` con el valor del backend **antes** de validar (misma filosofía que la imposición de `gating_active`) y registra la discrepancia como warning `derivatives_copy_mismatch` (minor: la sobrescritura ya corrige, no degrada por sí misma). La columna `score_derivatives` persiste así siempre el valor verdadero.
  - **F2 · `btc_trend_1d` / `btc_trend_1w` persistidos en `analyses`** (`ensureColumn` idempotente, mapeados desde `context.btc_context` en `buildAnalysisHeader`, que pasa a exportarse). El BTC DOMINANCE OVERRIDE degrada cualquier `Comprar` de un alt con BTC 1D bajista: sin esta covariable, el checkpoint no puede separar "Volume bloquea" de "BTC bloquea" sin reconstruir klines de BTC a posteriori. Test de partición SQL en `btcContextPersistence.test.js`.

---

## Sistema de Históricos para Análisis LLM

Módulo `historyService.js` gestiona históricos en memoria con límites automáticos y auto-cleanup.

**Datos históricos disponibles en `/api/data`:**

```json
{
  "history": {
    "fear_greed": [
      { "date": "2026-04-02", "value": 12, "classification": "Extreme Fear", "trend": "improving" }
    ],
    "funding_rate": [
      { "t": 1775109600, "o": 0.003521, "h": 0.003521, "l": 0.000845, "c": 0.000845, "trend": "falling" }
    ],
    "open_interest": [
      { "t": 1775152800, "o": 89173.535, "h": 89214.098, "l": 88270.335, "c": 88496.406 }
    ],
    "long_short_ratio": [
      { "t": 1775163600, "long_pct": 65.1, "short_pct": 34.9 },
      ...
    ],
    "liquidations": [
      { "date": "2026-04-02", "longs_usd": 155.53, "shorts_usd": 64.85 }
    ]
  }
}
```

**Límites de almacenamiento:**
- Fear & Greed: 30 días (una entrada/día) — obtenidos de alternative.me con `limit=30`
- Funding Rate: 8 candles (48h @ interval=6hour)
- Open Interest: 42 candles (7d @ interval=4hour)
- Long/Short Ratio: 168 candles (7d @ interval=1hour)
- Liquidations: 7 días (una entrada/día, acumulado 24h)

**Overhead:**
- Memoria: ~50KB máximo
- Tokens LLM: ~2000 adicionales por análisis (negligible)
- Costo API: 0 (se usan datos ya fetched en `/api/data`)

**Funciones disponibles (`historyService.js`):**
- `addFearGreedEntry(value, classification, trend, date?)` — Alimentado por `fearGreedService` (date opcional, usa hoy si no se proporciona)
- `addFundingRateEntry(candle)` — Alimentado por `coinalyzeService`
- `addOpenInterestEntry(candle)` — Alimentado por `coinalyzeService`
- `addLongShortRatioEntry(entry)` — Alimentado por `coinalyzeService`
- `addLiquidationsEntry(date, longs_usd, shorts_usd)` — Alimentado por `coinalyzeService`
- `getHistories()` — Retorna todos los históricos (usado en `dataController` y `analysisController`)

**Integración con Anthropic API:**
El LLM recibe automáticamente los históricos en la respuesta de `/api/data` y `/api/analyze/payload` para análisis temporal más preciso. Además de los históricos brutos, el endpoint `/api/analyze/payload` proporciona resúmenes consolidados:
- `fear_greed_history`: current, yesterday, 7d_ago, 30d_ago + periodo_min/max/avg + trend_30d
- `funding_rate.history`: open_48h, close_current, high/low_48h, trend_48h, % candles positivos
- `open_interest.history`: cambios 7d/24h, trend (increasing/decreasing/stable)
- `long_short_ratio.history`: posición actual, cambio 7d, promedio, trend
- `liquidations.history`: totales 7d, últimas 24h, ratio longs/shorts, trend

Estos resúmenes proporcionan contexto consolidado para decisiones más informadas sin saturar tokens LLM.

---

## Deploy — Raspberry Pi 5 (nativo + systemd)

**Hardware:** Raspberry Pi 5 8GB · Raspberry Pi OS Bookworm 64-bit (aarch64, modo terminal) · IP fija `192.168.1.250` · usuario `pi`.

**Acceso:** SSH desde red local únicamente (clave pública autorizada). Sin acceso externo WAN. Sin SSL/TLS (red de confianza).

**Modelo de despliegue (elegido 2026-07-03): nativo + systemd, SIN Docker ni reverse-proxy.** La Pi ya corre un asistente en modo kiosko (Chromium `--kiosk` → `http://localhost:8000`), así que CRYPTEX **convive** con él en otro puerto (`:8080`), sin colisión. Para una sola app single-user en LAN de confianza, Docker+NPM añadía overhead sin beneficio real → se descartó. Los `Dockerfile`/`docker-compose.yml` del repo se **conservan como alternativa**, pero **no es lo que corre en la Pi**.

### Cómo corre en la Pi

```
Pi (192.168.1.250, user pi)
│
├── ~/  (asistente en modo kiosko — Chromium --kiosk → http://localhost:8000)  ← NO se toca
│
└── ~/cryptex/                          ← este proyecto (llega por rsync desde dev, no git clone)
    ├── backend/  (Node 18 vía nvm)     ← UN SOLO proceso Express
    │   ├── src/index.js                ← escucha en :8080
    │   └── data/cryptex.db             ← SQLite persistente (WAL)
    └── frontend/dist/                  ← build de Vite, servido por el propio Express
```

**Clave del diseño:** un **único proceso Node**. En producción, Express sirve la API **y** el `frontend/dist/` construido (static + fallback SPA) **desde el mismo origen** → `/api` es same-origin, sin CORS ni reverse-proxy. Todo vive en `:8080`. Esto solo se activa con `NODE_ENV=production` (ver `app.js`: guard `existsSync(dist/index.html)` + `NODE_ENV`); en dev el frontend lo sigue sirviendo Vite (`:5173`) y en tests no hay `dist/`. `security.js` aplica `helmet({ contentSecurityPolicy: false, frameguard: false })` porque el SPA usa atributos `style=` inline (CSP off) y el kiosko lo embebe en un iframe cross-origin (frameguard off) — app single-user en LAN, sin contenido externo. El callback de CORS ante un origen no permitido responde `cb(null, false)` (no lanza): un `throw` daba HTTP 500 en los assets `crossorigin` del build de Vite, dejando la página sin estilos. Ver §Integración kiosko (iframe).

**URL:** `http://192.168.1.250:8080` desde cualquier equipo de la LAN. (`cryptex.lan` pendiente de entrada DNS en el router Zyxel — daría `http://cryptex.lan:8080`.)

### Servicio systemd

`/etc/systemd/system/cryptex.service` (User=pi, arranque al boot, `Restart=on-failure`):

```ini
[Unit]
Description=CRYPTEX Dashboard (backend + frontend en un puerto)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/cryptex/backend
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=DB_PATH=/home/pi/cryptex/backend/data/cryptex.db
ExecStart=/home/pi/.nvm/versions/node/v18.20.8/bin/node src/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cryptex

[Install]
WantedBy=multi-user.target
```

Las `Environment=` del unit tienen **prioridad sobre el `.env`** (dotenv no pisa un `process.env` ya definido) → `NODE_ENV/PORT/DB_PATH` los fija systemd. El resto de claves (API keys, TTLs) vienen del `.env` en la raíz del repo.

```bash
sudo systemctl {start,stop,restart,status} cryptex
journalctl -u cryptex -f           # logs en vivo
```

### Actualizar — `scripts/deploy.sh`

Deploy desde la máquina de desarrollo (build local + rsync + restart remoto):

```bash
./scripts/deploy.sh          # build frontend + sync backend/src + frontend/dist + restart
./scripts/deploy.sh --deps   # además npm ci en la Pi (solo si cambió package-lock — recompila better-sqlite3 arm64)
```

Overrides por env: `PI_HOST` (`pi@192.168.1.250`), `PI_DIR` (`/home/pi/cryptex`), `SERVICE` (`cryptex.service`), `PORT` (`8080`). **El `.env` NO se sincroniza** (secretos, se gestiona en la Pi).

### Primer despliegue (referencia — ya realizado)

1. Node 18 vía nvm en la Pi (queda en `~/.nvm/versions/node/v18.20.8/bin/node`).
2. `rsync` del repo a `~/cryptex` (excluye `node_modules`, `.git`, `backend/data`, `.dev`) **incluyendo** `.env` (con las API keys) y `frontend/dist/`.
3. `cd backend && npm ci --omit=dev` — compila `better-sqlite3` arm64 (build tools `make/gcc/g++/python3` ya presentes en Bookworm).
4. Crear el unit systemd + `sudo systemctl enable --now cryptex`.
5. Verificar `curl localhost:8080/health` + UI + `/api/data`.

### Migración de datos dev → Pi

La BD de desarrollo se migró con un snapshot consistente: `VACUUM INTO` (consolida el WAL en un único fichero sin tocar el original vía better-sqlite3) → transfer → `stop` servicio → reemplazar `cryptex.db` (borrando `-wal`/`-shm`) → `start`. Se migró en vez de empezar de cero por `history_series` (CVD/VWAP). *(Nota 2026-07-27: esa razón ya no aplica — son reconstruibles con `scripts/backfillHistorySeries.mjs`.)*

### Crons de recogida en la Pi — ⚠️ `CRON_TZ` NO funciona en Debian

Cuatro entradas en el `crontab -l` del usuario `pi` (no están en el repo; los scripts sí, en `scripts/`): **A** recogida fija 2/día (`collect.sh`), **B** oportunista horario sin coste LLM (`collectOpportunistic.sh`), **C** backup diario (`backupDb.sh`), **D** salud de la recogida (`checkCollection.sh`, publica `.collect/health.json` → visible en `/health.collection`).

**El cron de Debian (3.0pl1-162) no implementa `CRON_TZ`** — su `man 5 crontab` ni lo menciona: lo pasa al job como variable de entorno normal y **planifica siempre en hora local**. Descubierto el 2026-07-27: `CRON_TZ=UTC` + `5 8,20 * * *` disparaba en realidad a las **18:05 UTC** (= 20:05 CEST), es decir a **mitad de la vela 4h**, metiendo en el cálculo una vela medio formada (high/low/volumen a la mitad) de la que cuelgan ATR, Volume Profile, SMC y `cvd_strength`. Las velas 4h cierran a 00/04/08/12/16/20 UTC y la recogida quiere disparar 5 min después.

- **Regla:** escribir las horas del crontab **en local** y anotar la equivalencia UTC en el comentario. En CEST, `5 10,22` = 08:05/20:05 UTC; en CET habría que poner `5 9,21`.
- **Si algún día hace falta anclaje a UTC inmune al cambio de hora**, la vía es un timer de systemd (`OnCalendar=*-*-* 08,20:05:00 UTC`), no el crontab.
- Los scripts usan `date -u` explícito en todos sus timestamps (log, marcador diario del oportunista, sello del backup), así que **no dependen de la TZ del cron**: quitar `CRON_TZ` no altera ningún dato.

### Integración kiosko (iframe) — 2 fixes de cabeceras en `security.js`

CRYPTEX se embebe en un `<iframe>` dentro del kiosko de piAssistant (Chromium `--kiosk` → `http://localhost:8000`). El kiosko y CRYPTEX son **orígenes distintos** (`localhost:8000` vs `192.168.1.250:8080`), lo que obligó a relajar dos cabeceras. Ambos cambios viven en el código (los propaga `deploy.sh`), no solo en la Pi:

- **Framing (`frameguard: false`)** — helmet emite por defecto `X-Frame-Options: SAMEORIGIN`, que bloqueaba el iframe cross-origin (ni se veía). `X-Frame-Options` no admite un origen concreto (solo `DENY`/`SAMEORIGIN`) y la alternativa CSP `frame-ancestors` no sirve porque la CSP ya está apagada (SPA con `style=` inline). → `helmet({ contentSecurityPolicy: false, frameguard: false })`.
- **CORS (`cb(null, false)`)** — los assets del build de Vite llevan `crossorigin` → el navegador los pide en modo CORS con cabecera `Origin`. El callback de CORS **lanzaba** ante orígenes fuera de la allow-list (vacía en producción) → `throw` = HTTP 500 → CSS/JS no cargaban (página plana). (`curl` no lo destapaba: no manda `Origin`.) Fix: `cb(null, false)` en vez de `cb(new Error(...))` — no añade cabeceras CORS pero **no rompe**: same-origin no las necesita y una cross-origin real sigue bloqueada por el navegador al faltar `Access-Control-Allow-Origin` (no abre agujero).

**Si algún día se expone CRYPTEX fuera de la LAN, reconsiderar ambos** (reacotar framing vía CSP `frame-ancestors` y restringir CORS a orígenes concretos). Ver `doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md` §19.

### Ficheros Docker (alternativa, NO en uso)

`backend/Dockerfile`, `frontend/Dockerfile` y `docker-compose.yml` siguen en el repo por si algún día se migra al modelo contenedores + reverse-proxy (p. ej. al añadir más proyectos a la Pi). El diseño single-process actual se contiene en 1 sola imagen trivialmente. El plan original documentado (NPM en `:80` enrutando por hostname, red externa `proxy`, dos contenedores) queda **archivado** — no refleja lo desplegado.

---

## Próximo paso

**AHORA (2026-07-31): recoger muestra y no tocar la ruta de decisión sin medir.** La lista de
lo que se revisa, cuándo y con qué criterio está en `SESSION_STATE.md §0`. Lo que NO conviene
hacer: cambiar un umbral porque "se ve mal" — de las cuatro mediciones de los últimos dos días,
**dos dijeron "no cambies nada"** (banda de precio, DVOL) y una tercera corrigió el signo de una
celda que se iba a escribir al revés.

**Bloque 5 — COMPLETO ✅ (histórico):**
1. ~~Tests de integración de endpoints (Fase 15)~~ ✅
2. ~~Rediseño schema persistencia IA (Sprint Schema)~~ ✅
3. ~~Panel frontend de histórico análisis IA (Fase 12)~~ ✅ — modal con backtesting + outcome
4. ~~Panel recomendación IA en vivo (fix schema {structured,narrative})~~ ✅
5. ~~Poller de fondo multi-coin + persistencia BBDD entre reinicios~~ ✅
6. ~~Validador determinista del output §6.4 (log+flag + fail-safe)~~ ✅
7. ~~Job `analysis_outcome` + endpoints /api/outcome~~ ✅
8. ~~**Deploy en la Pi**~~ ✅ (2026-07-03) — **nativo + systemd** (no Docker). Un proceso Express en `:8080` sirviendo API + SPA; `cryptex.service`; BD dev migrada; `scripts/deploy.sh` para actualizar. Ver §Deploy.

**Deuda menor pendiente:**
- Entrada DNS `cryptex.lan → 192.168.1.250` en el router Zyxel (URL bonita, opcional).
- ~~Integración en el kiosko del asistente (`:8000`)~~ ✅ (2026-07-03/04) — CRYPTEX se embebe en un `<iframe>` del kiosko; 2 fixes de cabeceras en `security.js` (`frameguard: false` + CORS `cb(null, false)`). Ver §Integración kiosko (iframe) y [`doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md`](./doc/SESSION_STATE_2026-07-12_pre-archivo-audit2.md) §19 (archivado).
- ~~Deuda §6~~ ✅ **CERRADA (2026-07-26)**: FVGs detallados (tabla `analysis_fvg_snapshot`) ✅; S/R strength ✅, SuperTrend level ✅ (2026-07-03); `volume_history.vwap` ya resuelto por §12. Todos eran de *persistencia* (historial/backtesting), no de contexto al LLM.

**API keys configuradas en `.env`:** `ANTHROPIC_API_KEY` operativa. **Modelo IA seleccionable desde el frontend** (desplegable en el header): Opus 4.8 (~$0.20, default) / Sonnet 5 (~$0.09) / Haiku 4.5 (~$0.04). Whitelist `ANALYSIS_MODELS` en `constants.js`; validado por `resolveModel`; persistido en localStorage; el modelo usado se guarda en `analyses.model_used` y se muestra en cada tarjeta del historial. `COINALYZE_API_KEY` y `COINGECKO_API_KEY` activas.

**Jobs de fondo (index.js):** `historyPoller` (300s, persiste todas las monedas) + `outcomeService` (900s, rellena backtesting). Flags `HISTORY_POLLER_ENABLED` / `OUTCOME_JOB_ENABLED`.

---

## Lo que NO hacer

- **No escribir NINGUNA constante de corte sin medir antes su distribución** — es la regla que destapó T1-T6, el F&G inerte al 87,8 %, el LSR constante y el Derivatives Score al 0,0 %. Si no se puede medir, no se escribe. Ver §CONGELACIÓN LEVANTADA arriba.
- **No dejar campos huérfanos en el dataset del LLM** — cada dato, un dueño y un papel. Los cortes de calibración (`*_cuts`, `*_pctile`) NO viajan al modelo: lee la etiqueta, no el umbral con el que se generó.
- No cambiar PixiJS a v8 — se eligió v7.4.x deliberadamente
- No añadir TypeScript — el proyecto usa JS puro con tipos via JSDoc si es necesario
- No usar `require()` — solo ES modules
- No guardar OHLC en SQLite — es efímero, se recalcula
- No llamar a Anthropic en el timer de 60s — solo en POST /api/analyze (botón manual)
- No cambiar el OUTPUT FORMAT del SYSTEM_PROMPT sin actualizar `buildAnalysisHeader()` en `analysisController.js` — los campos del `structured` mapean 1:1 a columnas de la tabla `analyses`
- No exponer API keys al frontend — todas las keys son exclusivamente backend
- No lanzar errores en servicios externos que rompan `/api/data` — usar degraded mode
- No usar `last_funding_rate`, `open_interest` ni `long_ratio` en Coinalyze — los campos reales son `value` (FR/OI) y `l`/`s` (LSR)
- **No hardcodear valores CSS** — siempre usar variables definidas en `:root` (colores, tamaños, espaciado, border-radius, transiciones). Ver `CSS_CONVENTIONS.md`
