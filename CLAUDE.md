# CLAUDE.md — CRYPTEX Dashboard

Instrucciones para Claude Code en este proyecto.

---

## Proyecto

**CRYPTEX** es un dashboard profesional de análisis técnico de criptomonedas (BTC, ETH, SOL) con:
- 14 indicadores técnicos calculados localmente
- Sentimiento en vivo (Fear & Greed Index; CryptoPanic requiere plan de pago desde 2026)
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
  indicatorService.js        ← computeIndicators() — orquesta los 14 indicadores
  coingeckoService.js        ← fetchOHLC (15m/1h/4h/8h/1D), fetchCurrentPrice, fetchBTCDominance
  cryptopanicService.js      ← fetchSentiment — degraded si sin suscripción
  fearGreedService.js        ← fetchFearGreed (alternative.me, gratis) + alimenta históricos
  coinalyzeService.js        ← fetchFundingRate, fetchOpenInterest, fetchLongShortRatio, fetchLiquidations + históricos
  historyService.js          ← Gestión de históricos en memoria para análisis LLM (7-30 días)
  cacheService.js            ← Cache en memoria con TTL
src/utils/
  indicators.js              ← Funciones matemáticas puras (sin I/O)
  errors.js                  ← AppError, ValidationError, ExternalApiError
```

**Flujo de una request:** `route → controller → services (en paralelo) → response`

**`GET /api/data` devuelve:** `candles` (TF principal), `technical` (5 TFs), `sentiment`, `fear_greed`, `derivatives`, `btc_dominance`, `last_analysis`, precio, **`history`** (históricos para análisis LLM).

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

## Convenciones de código

- **ES modules** en todo el proyecto: `import/export`, nunca `require/module.exports`
- **Async/await** siempre. No callbacks ni `.then()` encadenados
- Los servicios externos nunca lanzan errores que rompan `/api/data` — usan `try/catch` y devuelven `null` en fallo (degraded mode)
- `Promise.allSettled` en el controller de datos — ningún fallo externo bloquea la respuesta
- Nombres de campos de candle normalizados: `{ t, open, high, low, close, volume }` — **siempre estos nombres**, no abreviaturas `{o,h,l,c,v}`
- Los indicadores matemáticos en `utils/indicators.js` son **funciones puras** — sin imports de servicios ni I/O
- Clases de error tipadas para todos los errores: nunca `throw new Error('...')` directamente

---

## APIs externas

| Servicio | Uso | Auth | TTL cache | Notas |
|----------|-----|------|-----------|-------|
| CoinGecko v3 | OHLC (5 TFs), precio, BTC Dominance | Opcional (free tier) | 60s OHLC, 30s precio, 10min dominance | — |
| CryptoPanic v2 | Sentimiento noticias | `CRYPTOPANIC_TOKEN` | 5min | **Requiere plan de pago desde 2026.** Sin suscripción devuelve `results: []` → dashboard muestra "—" |
| alternative.me | Fear & Greed Index | Ninguna | 10min | Completamente gratis, sin registro |
| Coinalyze v1 | Funding Rate, OI, L/S Ratio, Liquidaciones | `COINALYZE_API_KEY` (gratis) | 30min FR, 5min OI/LSR, 5min Liq | Ver estructura de respuesta real abajo |
| Anthropic | Análisis IA | `ANTHROPIC_API_KEY` | Sin cache (on-demand) | — |

**Endpoints y estructura de respuesta Coinalyze (verificados 2026-04-03):**
- Funding Rate: `GET /v1/funding-rate?symbols=X` → `[{ symbol, value, update }]` — campo `value` (no `last_funding_rate`)
- Funding Rate History: `GET /v1/funding-rate-history?symbols=X&interval=6hour&from=T&to=T` → `[{ symbol, history: [{t, o, h, l, c}] }]` — candles de 6h para tendencia 48h
- Open Interest: `GET /v1/open-interest?symbols=X` → `[{ symbol, value, update }]` — campo `value` (no `open_interest`)
- Open Interest History: `GET /v1/open-interest-history?symbols=X&interval=4hour&from=T&to=T` → `[{ symbol, history: [{t, o, h, l, c}] }]` — candles de 4h para cambio 24h y tendencia 7d
- L/S Ratio: `GET /v1/long-short-ratio-history?symbols=X&interval=1hour&from=T&to=T` → `[{ symbol, history: [{t, r, l, s}] }]` — campos `l` (long%) y `s` (short%) en porcentaje directo; se piden 7d completos para histórico
- Liquidations: `GET /v1/liquidation-history?symbols=X&interval=1hour&from=T&to=T` → `[{ symbol, history: [{t, l, s}] }]` — `l` = longs liquidados (USD), `s` = shorts liquidados (USD) en últimas 24h

**Degraded mode:**
- Si `COINALYZE_API_KEY` no está configurada → `env.hasDerivativesData` es `false` y todos los servicios de Coinalyze devuelven `null` sin lanzar error
- CryptoPanic sin suscripción → `score: null`, `unavailable: true` → sidebar muestra "—"
- Si CryptoPanic falla con datos previos → usa caché SQLite con flag `stale: true`

---

## Timeframes

`TIMEFRAMES = ['15m', '1h', '4h', '8h', '1D']` — ordenados de menor a mayor.

| TF | Fuente CoinGecko | Candles aprox. | Notas |
|----|-----------------|----------------|-------|
| 15m | `/ohlc?days=1` | ~48 | Granularidad ~30min real de CoinGecko |
| 1h | `market_chart?days=7&interval=hourly` | ~168 | 1 tick/hora → `open = prev.close` para evitar dojis planos |
| 4h | `/ohlc?days=30` | ~180 | Granularidad 4h nativa |
| 8h | `market_chart?days=60&interval=hourly` | ~180 | Buckets de 8h con OHLCV real (múltiples ticks) |
| 1D | `/ohlc?days=365` | ~365 | Granularidad diaria nativa |

`draw.js → formatTime`: si intervalo entre velas ≥ 6h → `DD/MM`; si < 6h → `HH:MM`.

---

## Base de datos (SQLite)

Las migraciones se ejecutan inline en `config/db.js` al arrancar. No hay ficheros de migración externos.

**Tablas:**
- `analyses` — histórico de análisis IA (máx 1000 por coin, pruning automático)
- `sentiment_cache` — fallback persistente de CryptoPanic por coin
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
- No hay tests de integración aún (pendiente Fase 15)

**Al añadir un nuevo indicador** en `utils/indicators.js`, añadir tests en `indicators.test.js` siguiendo el patrón existente: null con datos insuficientes, estructura del resultado, comportamiento en tendencia alcista/bajista.

---

## Indicadores implementados

Todos en `backend/src/utils/indicators.js`. Funciones exportadas:

| Función | Descripción |
|---------|-------------|
| `calculateRSI(closes, period?)` | RSI Wilder |
| `calculateEMA(values, period)` | EMA helper |
| `calculateATR(candles, period?)` | ATR Wilder |
| `calculateMACD(closes, fast?, slow?, signal?)` | MACD + histograma 4 colores |
| `calculateStochRSI(closes, ...)` | Stochastic RSI |
| `calculateWaveTrend(candles, n1?, n2?)` | WaveTrend Oscillator — devuelve `{ wt1, wt2, signal }` donde signal puede ser `neutral/overbought/oversold/oversold_cross_up/overbought_cross_down` |
| `calculateADX(candles, period?)` | ADX + DMI |
| `calculateBollingerBands(closes, period?, mult?)` | BB + width + %B |
| `calculateSuperTrend(candles, ...)` | SuperTrend adaptativo — usar `st.support` (UP) o `st.resistance` (DOWN) para el nivel |
| `calculateVolumeDelta(candles)` | Presión compradora/vendedora |
| `calculateCVD(candles)` | Cumulative Volume Delta |
| `calculateOBV(candles)` | On-Balance Volume |
| `calculateFibonacci(high, low, levels?)` | Niveles Fibonacci |
| `calculateSupportResistance(candles, ...)` | Soporte & Resistencia |
| `detectRSIDivergence(closes, ...)` | Divergencias RSI |
| `detectMarketRegime(candles, closes)` | Régimen TRENDING/RANGING/HIGH_VOLATILITY — devuelve string plano, no objeto |

---

## Estado del proyecto (2026-04-03)

| Bloque | Contenido | Estado |
|--------|-----------|--------|
| Bloque 1 | Setup, skeleton, 14 indicadores | ✅ Completo |
| Bloque 2 | 7 servicios externos, GET /api/data | ✅ Completo |
| Bloque 3 | POST /api/analyze, historial, anthropicService stub | ✅ Completo (pendiente API key) |
| Bloque 4 | Frontend Fases 7, 8, 9, 10, 11, 13 completas | ✅ Completo |
| Bloque 4.5 | Sistema de históricos para análisis LLM (7-30 días) | ✅ Completo |
| Bloque 5 | Tests integración, deploy VPS, docs | ⏳ Pendiente |

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

- **Bug 1h**: velas planas (open=close) corregido en `fetchMarketChartAggregated` usando `prev.close` como `open`
- **Timeframes ampliados**: añadidos 8h y 1D; botones ordenados 15m → 1h → 4h → 8h → 1D
- **WaveTrend sidebar**: señal corregida — usa `wt.signal` del backend (`cross up/down`, `overbought/oversold`) en vez de solo `wt1 > 0`
- **Coinalyze**: campos de respuesta corregidos tras verificar la API real (`value` en FR y OI; `l`/`s` en LSR)
- **CryptoPanic**: ahora muestra "—" correctamente cuando la API no retorna resultados (plan de pago requerido)
- **Open Interest**: sidebar muestra valor absoluto formateado (`$90.2M`) + cambio 24h real vía endpoint de históricos
- **Funding Rate**: sidebar muestra tasa + tendencia (rising/falling/stable) vía endpoint de históricos 48h
- **Liquidaciones**: nuevo endpoint `/liquidation-history` con suma 24h de longs vs shorts liquidados
- **Tooltips sentimiento**: Fear & Greed, CryptoPanic, Funding Rate, Open Interest, L/S Ratio, Liquidaciones — mismo estilo que indicadores, con icono punto azul en hover (`::after` en `.sent-label[title]`)
- **Tooltips indicadores**: reescritos con nivel didáctico para alguien nuevo en trading
- **Sistema de históricos**: módulo `historyService.js` gestiona 7-30 días de contexto temporal para análisis LLM. Incluye: F&G 30d, FR 48h, OI 7d, L/S 7d, Liq 7d

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
- Fear & Greed: 30 días (una entrada/día)
- Funding Rate: 8 candles (48h @ interval=6hour)
- Open Interest: 42 candles (7d @ interval=4hour)
- Long/Short Ratio: 168 candles (7d @ interval=1hour)
- Liquidations: 7 días (una entrada/día, acumulado 24h)

**Overhead:**
- Memoria: ~50KB máximo
- Tokens LLM: ~2000 adicionales por análisis (negligible)
- Costo API: 0 (se usan datos ya fetched en `/api/data`)

**Funciones disponibles (`historyService.js`):**
- `addFearGreedEntry(value, classification, trend)` — Alimentado por `fearGreedService`
- `addFundingRateEntry(candle)` — Alimentado por `coinalyzeService`
- `addOpenInterestEntry(candle)` — Alimentado por `coinalyzeService`
- `addLongShortRatioEntry(entry)` — Alimentado por `coinalyzeService`
- `addLiquidationsEntry(date, longs_usd, shorts_usd)` — Alimentado por `coinalyzeService`
- `getHistories()` — Retorna todos los históricos (usado en `dataController`)

**Integración con Anthropic API:**
El LLM recibe automáticamente los históricos en la respuesta de `/api/data` para análisis temporal más preciso. Los históricos proporcionan:
- Reversiones de extremos (F&G)
- Ciclos de pago de funding rate
- Acumulación/distribución de OI
- Cambios de posicionamiento L/S
- Presión de liquidaciones

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
- `CRYPTOPANIC_TOKEN` — token (sin plan de pago activo → devuelve vacío)
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
