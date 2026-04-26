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

El documento de referencia arquitectónica es [BLUEPRINT.md](./BLUEPRINT.md). Consultarlo siempre antes de proponer cambios estructurales.

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
| Process manager | PM2 (producción) |

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

---

## Arquitectura del backend

```
src/index.js                 ← Entry point, monta Express, init DB, graceful shutdown
src/config/
  env.js                     ← Todas las variables de entorno con defaults
  constants.js               ← Constantes de indicadores, coins, timeframes
  db.js                      ← Conexión SQLite, migraciones inline al arrancar
src/middleware/
  security.js                ← Helmet + CORS + Compression + express.json
  logger.js                  ← Instancia Pino singleton
  errorHandler.js            ← Catch-all errors + 404
src/routes/                  ← Solo registran handlers, sin lógica
  data.js                    ← GET /api/data
  analysis.js                ← POST /api/analyze
  history.js                 ← GET /api/history/:coin
  health.js                  ← GET /health
src/controllers/             ← Orquestación, validación de params, formato respuesta
  dataController.js          ← GET /api/data — 11 fuentes en paralelo, devuelve candles+technical
  analysisController.js      ← POST /api/analyze — fetcha datos, llama Anthropic, guarda en DB
  historyController.js       ← GET /api/history/:coin — paginación, valida coin
src/services/                ← Lógica de negocio, I/O externo, cache
  anthropicService.js        ← Stub: buildPrompt() completo, analyzeMarket() pendiente API key
  dbService.js               ← saveAnalysis(), getAnalysisHistory(), getLastAnalysis()
  indicatorService.js        ← computeIndicators() — orquesta los 14 indicadores + Volume Profile + computeTrend ponderado
  coingeckoService.js        ← fetchOHLC (Binance klines: 1h/4h/1D/1W con taker_buy_base real), fetchCurrentPrice, fetchBTCDominance, fetchGlobalMarketData, fetchCoinMarketData
  fearGreedService.js        ← fetchFearGreed (alternative.me, gratis) + alimenta históricos
  coinalyzeService.js        ← fetchFundingRate (con predicted_rate_pct), fetchOpenInterest, fetchLongShortRatio, fetchLiquidations + históricos
  binanceOrderBookService.js ← fetchOrderBookWalls (depth=20: muros, spread, imbalance ratio top20/top5/signal), fetchBinanceTicker
  liquidationClustersService.js ← Inferencia de magnetic zones cruzando liquidaciones 1h con candles 1h (top 5 long/short, distancias)
  onchainService.js          ← Métricas on-chain BTC (MVRV, MVRV Z-score, NUPL, SOPR) — bitcoin-data.com free tier
  etfFlowsService.js         ← Spot ETF flows BTC/ETH (SoSoValue, sin auth) — total_net_flow, 7d_sum, trend_7d, by_issuer[]
  macroService.js            ← Macro context DXY/SPX/Gold (Yahoo Finance v8, sin auth) — value, change_24h_pct, trend_5d
  historyService.js          ← Gestión de históricos en memoria para análisis LLM (7-30 días)
  cacheService.js            ← Cache en memoria con TTL
src/utils/
  indicators.js              ← Funciones matemáticas puras (sin I/O)
  volumeProfile.js           ← Volume Profile (POC, VAH, VAL, HVN, LVN) — función pura
  smc.js                     ← Smart Money Concepts: detectSwings, detectLastBOS, detectLastCHoCH, detectUnmitigatedFVGs, calculateSMC — funciones puras
  errors.js                  ← AppError, ValidationError, ExternalApiError
```

**Flujo de una request:** `route → controller → services (en paralelo) → response`

**`GET /api/data` devuelve:** `candles` (TF principal, con `taker_buy_base`/`taker_buy_quote`/`quote_volume` reales de Binance), `technical` (4 TFs, incluye `volume_profile` por TF), `sentiment`, `fear_greed`, `derivatives`, `btc_dominance`, `binance_walls` (con `imbalance_ratio`), `last_analysis`, precio, **`history`** (históricos para análisis LLM).

**`GET /api/analyze/payload` añade además:** `order_book` (muros + imbalance), `derivatives.liquidation_clusters` (magnetic zones inferidas), `onchain` (MVRV/NUPL/SOPR para BTC), `etf_flows` (BTC/ETH spot ETF flows vía SoSoValue), `macro` (DXY/SPX/Gold vía Yahoo Finance), `volume_history` (CVD/VWAP), `timeframe_analysis` (conflictos entre TFs), resúmenes consolidados de históricos. `technical[tf]` incluye además `volume_profile` y `smc` (BOS/CHoCH/FVGs).

## Arquitectura del frontend

```
frontend/
  index.html                 ← Layout completo (header, canvas PixiJS, sidebar)
  vite.config.js             ← Proxy /api → :3000 en dev
  assets/
    css/styles.css           ← Dark mode completo (variables CSS, todos los componentes)
    js/
      app.js                 ← Entry point: init PixiJS, carga datos, conecta eventos, persistencia
      api/
        client.js            ← fetchData(coin, tf) + postAnalyze(coin, tf)
      state/
        store.js             ← Estado global: getState(), setState(), subscribe()
        storage.js           ← Persistencia por coin en localStorage (coin, tf, recommendation)
      ui/
        sidebar.js           ← updateHeader, updateIndicators, updateSentiment, updateRecommendation
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
| SoSoValue | Spot ETF flows BTC/ETH (historicalInflowChart + currentEtfDataMetrics) | Ninguna (POST sin auth) | 1h normal, 30min negativo | SOL → `null` (sin spot ETF). Body `{"type":"us-btc-spot"\|"us-eth-spot"}`. Campos numéricos envueltos en `{value, lastUpdateDate, status}` → extraer `.value` |
| Yahoo Finance v8 | Macro DXY/SPX/Gold (chart endpoint, interval=1d&range=10d) | Ninguna | 30min normal, 10min negativo | User-Agent obligatorio. Símbolos: `DX-Y.NYB`, `^GSPC`, `GC=F`. Cache coin-agnóstico (`macro:global`). closes[] puede traer null → filtrar |
| Anthropic | Análisis IA | `ANTHROPIC_API_KEY` | Sin cache (on-demand) | — |

**Endpoints y estructura de respuesta Coinalyze (verificados 2026-04-06):**
- Funding Rate: `GET /v1/funding-rate?symbols=X` → `[{ symbol, value, update }]` — campo `value` (no `last_funding_rate`)
- Funding Rate History: `GET /v1/funding-rate-history?symbols=X&interval=6hour&from=T&to=T` → `[{ symbol, history: [{t, o, h, l, c}] }]` — candles de 6h para tendencia 48h
- Open Interest: `GET /v1/open-interest?symbols=X` → `[{ symbol, value, update }]` — campo `value` (no `open_interest`)
- Open Interest History: `GET /v1/open-interest-history?symbols=X&interval=4hour&from=T&to=T` → `[{ symbol, history: [{t, o, h, l, c}] }]` — candles de 4h para cambio 24h y tendencia 7d
- L/S Ratio: `GET /v1/long-short-ratio-history?symbols=X&interval=1hour&from=T&to=T` → `[{ symbol, history: [{t, r, l, s}] }]` — campos `l` (long%) y `s` (short%) en porcentaje directo; se piden 7d completos para histórico
- Liquidations: `GET /v1/liquidation-history?symbols=X&interval=1hour&from=T&to=T` → `[{ symbol, history: [{t, l, s}] }]` — `l` = longs liquidados (USD), `s` = shorts liquidados (USD) en últimas 24h

**Degraded mode:**
- Si `COINALYZE_API_KEY` no está configurada → `env.hasDerivativesData` es `false` y todos los servicios de Coinalyze (incluido `liquidationClustersService`) devuelven `null` sin lanzar error
- `ONCHAIN_DATA_ENABLED=false` en `.env` apaga `onchainService` (no requiere key, sólo flag)
- Si bitcoin-data.com cae o se rate-limitea, `onchainService` cachea un sentinel `{__empty:true}` durante `CACHE_ONCHAIN_NEGATIVE_TTL` (30 min) en lugar de reintentar inmediatamente. La cuota free (15 req/día) se respeta porque el TTL completo es 12h y cada refresh consume 4 requests (4 × 2 = 8 req/día)

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
- `analyses` — histórico de análisis IA (máx 1000 por coin, pruning automático)
- `candles_cache` — reservada para futuro (no se usa actualmente)

**No guardar** datos OHLC ni indicadores técnicos en DB — son efímeros y se recalculan en cada request.

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
- **69 tests unitarios** en `indicators.test.js` — todos deben pasar siempre
- Los tests de indicadores usan datos sintéticos diseñados para ejercitar comportamiento, no valores exactos de mercado
- **96 tests** en `indicators.test.js` (incluye 8 de SMC) — todos deben pasar siempre
- No hay tests de integración aún (pendiente Fase 15)

**Al añadir un nuevo indicador** en `utils/indicators.js` o `utils/`, añadir tests en `indicators.test.js` siguiendo el patrón existente: null con datos insuficientes, estructura del resultado, comportamiento en tendencia alcista/bajista.

---

## Indicadores implementados

Todos en `backend/src/utils/indicators.js`. Funciones exportadas:

| Función | Descripción |
|---------|-------------|
| `calculateRSI(closes, period?)` | RSI Wilder |
| `calculateEMA(values, period)` | EMA helper |
| `calculateATR(candles, period?)` | ATR Wilder |
| `calculateMACD(closes, fast?, slow?, signal?)` | MACD + 4 estados momentum: `bullish_accelerating/bullish_decelerating/bearish_accelerating/bearish_decelerating` |
| `calculateStochRSI(closes, ...)` | Stochastic RSI |
| `calculateWaveTrend(candles, n1?, n2?)` | WaveTrend Oscillator — devuelve `{ wt1, wt2, signal }` donde signal puede ser `neutral/overbought/oversold/oversold_cross_up/overbought_cross_down` |
| `calculateADX(candles, period?)` | ADX + DMI |
| `calculateBollingerBands(closes, period?, mult?)` | BB + width_pct + position (0.0-1.0, no status) |
| `calculateSuperTrend(candles, ...)` | SuperTrend adaptativo — usar `st.support` (UP) o `st.resistance` (DOWN) para el nivel |
| `calculateVolumeDelta(candles)` | Presión compradora/vendedora — usa `taker_buy_base` real de Binance cuando los candles lo traen (`source: 'taker_real'`); fallback heurístico `(close-low)/(high-low)` si falta o es inválido (NaN, fuera de rango) |
| `calculateCVD(candles)` | Cumulative Volume Delta — mismo patrón taker_real / heuristic. Delta real = `2*taker_buy_base - volume` |
| `calculateVWAP(candles, period?)` | VWAP (rolling 20-period) — Volume-Weighted Average Price |
| `calculateFibonacci(high, low, levels?)` | Niveles Fibonacci |
| `calculateSupportResistance(candles, ...)` | Soporte & Resistencia — devuelve `{supports, resistances}` sin campo `type` (ya declarado por la lista) |
| `detectRSIDivergence(closes, ...)` | Divergencias RSI |
| `detectMarketRegime(candles, closes)` | Régimen TRENDING/RANGING/HIGH_VOLATILITY — devuelve string plano, no objeto |

**Helpers adicionales (no en `indicators.js`):**
- `calculateVolumeProfile(candles, opts?)` en `utils/volumeProfile.js` — POC, VAH, VAL, HVN/LVN (top 5), bin_size, total_volume. Distribución uniforme: cada vela contribuye `volume / numBins` a cada bin que cubre su rango.
- `computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta })` en `services/indicatorService.js` — string ponderado por jerarquía del SYSTEM_PROMPT: estructura 50% (ADX+SuperTrend), ejecución 30% (RSI+MACD+WaveTrend+StochRSI), volumen 20%. Devuelve `strongly_bullish | bullish | neutral | bearish | strongly_bearish`.
- `calculateSMC(candles, opts?)` en `utils/smc.js` — wrapper que devuelve `{ last_bos, last_choch, unmitigated_fvgs }`. Funciones internas: `detectSwings` (pivote fractal lookback=2), `detectLastBOS` (continuación de tendencia HH/HL o LH/LL), `detectLastCHoCH` (ruptura en dirección opuesta = primer aviso de reversión), `detectUnmitigatedFVGs` (ventana 100 velas, top 5 por dirección, más recientes primero). Expuesto como `technical[tf].smc`.

---

## Estado del proyecto (2026-04-27)

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
| Sprint D' | Deribit DVOL, update SYSTEM_PROMPT con bloques nuevos | ⏳ Pendiente |
| Bloque 5 | Tests integración, deploy VPS | ⏳ Pendiente |

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
- **Open Interest**: sidebar muestra valor absoluto formateado (`$90.2M`) + cambio 24h real vía endpoint de históricos
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
  - **ETF Flows** (`etf_flows` top-level): `etfFlowsService.js` consume SoSoValue (POST sin auth). BTC + ETH cubiertos; SOL `null`. Output: `total_net_flow_usd_yesterday`, `total_net_flow_usd_7d_sum`, `trend_7d` (`accumulating/distributing/neutral`, umbral 100M USD), `by_issuer[]` top 10 por net_assets. Cache 1h / negativo 30min con sentinel `{__empty:true}`.
  - **Macro** (`macro` top-level): `macroService.js` consume Yahoo Finance v8 chart. DXY (`DX-Y.NYB`), SPX (`^GSPC`), Gold (`GC=F`). Output por símbolo: `{value, change_24h_pct, trend_5d}`. User-Agent obligatorio. Cache 30min coin-agnóstico (`macro:global`) / negativo 10min. `closes[]` puede traer `null` (festivos/intradía) — se filtran antes de calcular trend.
  - **SMC** (`technical[tf].smc`): `utils/smc.js` (funciones puras). `detectSwings`: pivote fractal lookback=2. `detectLastBOS`: rompe último swing en dirección de tendencia HH/HL o LH/LL (continuación). `detectLastCHoCH`: rompe en dirección opuesta (reversión). `detectUnmitigatedFVGs`: patrón 3 velas, mitigado si alguna vela posterior toca la zona, ventana 100 velas, top 5 por dirección. 8 tests nuevos (total 96/96).

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

## Próximo paso

**Bloque 5:**
1. Panel frontend de histórico análisis IA (Fase 12 — backend ya operativo)
2. Deploy VPS: Nginx + SSL/TLS (certbot) + PM2 (Fase 14)
3. Tests de integración de endpoints (Fase 15)

**Pendiente de API key:**
`src/services/anthropicService.js` — rellenar el cuerpo de `analyzeMarket()`.
El stub ya tiene `buildPrompt()` completo y el código de integración SDK en comentarios.

**API keys configuradas en `.env`:**
- `COINGECKO_API_KEY` — demo key
- `COINALYZE_API_KEY` — key gratuita, operativa

---

## Lo que NO hacer

- No cambiar PixiJS a v8 — se eligió v7.4.x deliberadamente
- No añadir TypeScript — el proyecto usa JS puro con tipos via JSDoc si es necesario
- No usar `require()` — solo ES modules
- No guardar OHLC en SQLite — es efímero, se recalcula
- No llamar a Anthropic en el timer de 60s — solo en POST /api/analyze (botón manual)
- No exponer API keys al frontend — todas las keys son exclusivamente backend
- No lanzar errores en servicios externos que rompan `/api/data` — usar degraded mode
- No usar `last_funding_rate`, `open_interest` ni `long_ratio` en Coinalyze — los campos reales son `value` (FR/OI) y `l`/`s` (LSR)
- **No hardcodear valores CSS** — siempre usar variables definidas en `:root` (colores, tamaños, espaciado, border-radius, transiciones). Ver `CSS_CONVENTIONS.md`
