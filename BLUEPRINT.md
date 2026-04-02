# CRYPTEX — Blueprint Arquitectónico Completo

**Fecha inicio:** 1 de abril de 2026  
**Última actualización:** 3 de abril de 2026  
**Estado:** EN DESARROLLO — Bloques 1, 2 y 3 completados; Bloque 4 completado; Bloque 4.5 (históricos para IA) completado; Bloque 5 pendiente  
**Versión:** 1.5  

---

## 📋 ÍNDICE

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [Stack Técnico](#stack-técnico)
3. [Arquitectura General](#arquitectura-general)
4. [Estructura de Carpetas](#estructura-de-carpetas)
5. [Endpoints Backend](#endpoints-backend)
6. [Schemas JSON](#schemas-json)
7. [Base de Datos](#base-de-datos)
8. [Flujos de Datos](#flujos-de-datos)
9. [Roadmap de Implementación](#roadmap-de-implementación)
10. [Decisiones Finales](#decisiones-finales)

---

## 🎯 RESUMEN EJECUTIVO

**CRYPTEX** es un sistema profesional de análisis técnico para criptomonedas que integra:

**Indicadores técnicos (cálculo local, coste $0):**
- ✅ RSI con Wilder smoothing + detección de divergencias automática
- ✅ Stochastic RSI (oscilador de momentum optimizado para cripto 24/7)
- ✅ MACD (12/26/9) con histograma de 4 colores (aceleración/deceleración)
- ✅ WaveTrend Oscillator (el oscilador más popular de TradingView para cripto)
- ✅ ADX + DMI (filtro de régimen: TRENDING / RANGING / HIGH VOLATILITY)
- ✅ Bollinger Bands (20/2) + BB Width + BB %B
- ✅ SuperTrend adaptativo (trailing stop dinámico basado en ATR)
- ✅ Fibonacci retracements automáticos
- ✅ Soporte & Resistencia automáticos
- ✅ Volume Delta por vela (presión compradora/vendedora)
- ✅ CVD — Cumulative Volume Delta (acumulado, detecta divergencias de largo plazo)
- ✅ OBV — On-Balance Volume (acumulación institucional silenciosa)
- ✅ Market Regime Badge (TRENDING / RANGING / HIGH VOLATILITY)

**Sentimiento y contexto de mercado (con históricos para análisis IA):**
- ✅ CryptoPanic en vivo (votos bullish/bearish + noticias)
- ✅ Fear & Greed Index en vivo + histórico 30d (alternative.me — gratis, sin registro)
- ✅ Funding Rate agregado multi-exchange + histórico 48h + tendencia (Coinalyze — gratis con registro)
- ✅ Open Interest 24h + histórico 7d + cambio 24h real (Coinalyze)
- ✅ Long/Short Ratio + histórico 7d (Coinalyze)
- ✅ Liquidaciones 24h + histórico 7d (Coinalyze)
- ✅ BTC Dominance % (CoinGecko — ya integrado)

**Sistema IA y visualización:**
- ✅ **Análisis IA bajo demanda** (Anthropic Claude — botón manual, prompt enriquecido con todos los datos anteriores)
- ✅ Contexto multi-temporal (15m/1h/4h)
- ✅ Visualización interactiva (Drag/Zoom con PixiJS v7)
- ✅ Persistencia histórica (SQLite)

**Monedas:** BTC, ETH, SOL (selector dropdown)  
**Acceso:** Privado (usuario único)  
**Hosting:** VPS propio del usuario  
**Auto-refresh:** Timer 60 segundos (indicadores técnicos + sentimiento, SIN IA)  
**Refresh Manual:** Botón "🔄 Actualizar" (on-demand)  
**IA Analysis:** Manual (botón "⚡ Analizar")

---

## 🔧 STACK TÉCNICO

### Backend
```
Runtime:          Node.js 18.x LTS
Framework:        Express.js 4.x
Database:         SQLite3 (better-sqlite3)
Process Manager:  PM2
APIs externas:
  • Anthropic SDK (IA)
  • Axios (HTTP client)
  • node-cron (scheduling)
  • CoinGecko API v3 (OHLC + BTC Dominance — free tier)
  • CryptoPanic API (sentimiento — token gratuito)
  • alternative.me API (Fear & Greed Index — completamente gratis, sin registro)
  • Coinalyze API (Funding Rate, Open Interest, L/S Ratio, Liquidaciones + históricos — gratis con registro)
Utilities:
  • dotenv (configuration)
  • uuid (IDs)
  • joi (validation)
  • pino (logging)
  • compression (middleware)
```

### Frontend
```
Render Engine:    PixiJS 7.x
Bundler:          Vite 4.x
Styling:          Vanilla CSS + Dark Mode
Scripts:          Vanilla JavaScript
```

### Infraestructura
```
OS:               Ubuntu 22.04 LTS
Web Server:       Nginx (reverse proxy)
SSL:              Let's Encrypt (certbot)
Monitoring:       PM2 Plus (opcional)
```

---

## 🏗️ ARQUITECTURA GENERAL

### Flujo de Datos Principal

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Browser)                       │
│  PixiJS Renderer + Vanilla JS + State Management           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Timer 60seg (AUTO)   🔄 Refresh (MANUAL)   ⚡ IA (MANUAL)      │  │
│  │  Indicadores live     Actualizar on-demand  Análisis on-demand │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          ↑↓ HTTPS
      (Datos cada 60seg)  |  (Análisis IA on-demand)
┌─────────────────────────────────────────────────────────────┐
│              BACKEND (Node.js Express)                      │
├──────────────────────────────────────────────────────────────┤
│  Routes → Controllers → Services → Data Access             │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ENDPOINT #1: GET /api/data (AUTOMÁTICO cada 60seg O MANUAL)   │
│  ├─ CoinGecko (OHLC 5 TF para 1 coin seleccionada) → rápido│
│  ├─ Indicadores (RSI, MACD, BB) → local compute             │
│  ├─ Volumen Delta → local compute                           │
│  ├─ CryptoPanic (Sentimiento) → 5min cache                  │
│  ├─ Fear & Greed + históricos (30d) → 10min cache           │
│  ├─ Coinalyze (FR, OI, L/S, Liquidaciones) + históricos     │
│  └─ Históricos en memoria → para análisis LLM               │
│                                                               │
│  ENDPOINT #2: POST /api/analyze (MANUAL - botón usuario)    │
│  ├─ Toma datos actuales (ya cargados)                       │
│  ├─ Envía a Anthropic (IA analysis)                         │
│  └─ Retorna JSON recomendación                              │
│                                                               │
│  + SQLite: Guarda cada análisis IA (histórico)              │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│           EXTERNAL APIs & DATA SOURCES                      │
│  ├─ CoinGecko (prices, OHLC)                                │
│  ├─ CryptoPanic (news, sentiment)                           │
│  ├─ Anthropic API v1 (Claude Sonnet - SOLO bajo demanda)   │
│  └─ (Futuro: Binance WebSocket)                             │
└─────────────────────────────────────────────────────────────┘
```

### Timer Auto-refresh (60 segundos) + Botón Manual

```
CADA 60 SEGUNDOS AUTOMÁTICO (costo $0):
  ├─ GET /api/data?coin=BTC (coin actual seleccionada)
  ├─ Backend procesa en paralelo:
  │  ├─ Fetch OHLC (3 TF × 1 coin = 3 requests) → rápido
  │  ├─ Calcular indicadores (local)
  │  ├─ Calcular Volumen Delta (local)
  │  └─ Fetch Sentimiento (cached 5min)
  ├─ Retorna JSON con datos técnicos + sentimiento
  │
  └─ Frontend:
     ├─ Renderiza gráficos PixiJS (nuevas velas)
     ├─ Actualiza panel indicadores
     ├─ Actualiza sentimiento score
     └─ Mantiene estado de zoom/pan

BOTÓN "🔄 ACTUALIZAR" (MANUAL, on-demand):
  ├─ Usuario clickea botón
  ├─ GET /api/data?coin=BTC (mismo endpoint)
  ├─ Reinicia countdown timer 60 seg
  └─ Usuario puede clickear again sin esperar (no blocking)
```

### Análisis IA On-Demand (Botón Manual)

```
USUARIO CLICKEA "⚡ Analizar" (costo $0.003):
  ├─ Frontend POST /api/analyze
  │  └─ Body: { coin, primary_tf, current_data }
  │
  ├─ Backend:
  │  ├─ Toma datos técnicos YA CALCULADOS
  │  ├─ Toma sentimiento ACTUAL
  │  ├─ Arma prompt estructurado
  │  └─ Envía a Anthropic
  │
  ├─ Antropic responde JSON (recomendación)
  │
  ├─ Backend:
  │  ├─ Parsea respuesta
  │  ├─ Guarda en SQLite (histórico)
  │  └─ Retorna a frontend
  │
  └─ Frontend:
     ├─ Muestra en panel recomendación
     ├─ Renderiza alerts
     └─ Guarda timestamp del análisis
```

---

## 📂 ESTRUCTURA DE CARPETAS

```
cryptoDashboard/                           # Raíz del proyecto
│
├── BLUEPRINT.md                           # ← Este archivo (en raíz, no en docs/)
├── CLAUDE.md                              # Instrucciones para Claude Code
│
├── backend/                               # ✅ Implementado
│   ├── src/
│   │   ├── index.js                      # ✅ Entry point (Express + graceful shutdown)
│   │   │
│   │   ├── config/
│   │   │   ├── env.js                    # ✅ Variables de entorno con getters
│   │   │   ├── db.js                     # ✅ SQLite + WAL + migraciones inline
│   │   │   └── constants.js              # ✅ Constantes de todos los indicadores
│   │   │
│   │   ├── routes/
│   │   │   ├── data.js                   # ✅ GET /api/data (conectado a dataController)
│   │   │   ├── analysis.js               # ✅ POST /api/analyze (conectado a analysisController)
│   │   │   ├── history.js                # ✅ GET /api/history/:coin (conectado a historyController)
│   │   │   └── health.js                 # ✅ GET /health
│   │   │
│   │   ├── controllers/
│   │   │   ├── dataController.js         # ✅ GET /api/data — 11 fuentes paralelas + históricos
│   │   │   ├── analysisController.js     # ✅ POST /api/analyze — fetch+indicators+Anthropic+DB
│   │   │   └── historyController.js      # ✅ GET /api/history/:coin — paginación limit/offset
│   │   │
│   │   ├── services/
│   │   │   ├── cacheService.js           # ✅ In-memory TTL cache
│   │   │   ├── dbService.js              # ✅ CRUD sentiment_cache + analyses
│   │   │   ├── coingeckoService.js       # ✅ OHLC 3TF + precio + BTC dominance + volumen
│   │   │   ├── cryptopanicService.js     # ✅ Sentimiento v2 + fallback SQLite
│   │   │   ├── fearGreedService.js       # ✅ Fear & Greed Index (alternative.me) + históricos
│   │   │   ├── coinalyzeService.js       # ✅ Funding Rate + OI + L/S Ratio + Liq + históricos
│   │   │   ├── historyService.js         # ✅ Gestión de históricos en memoria (7-30 días)
│   │   │   ├── indicatorService.js       # ✅ Orquesta 14 indicadores por TF
│   │   │   └── anthropicService.js       # 🔑 Stub: buildPrompt() ✅, analyzeMarket() pendiente key
│   │   │
│   │   ├── middleware/
│   │   │   ├── errorHandler.js           # ✅ Catch-all + 404
│   │   │   ├── logger.js                 # ✅ Pino + pino-pretty en dev
│   │   │   └── security.js              # ✅ Helmet + CORS + Compression
│   │   │
│   │   └── utils/
│   │       ├── indicators.js             # ✅ 14 indicadores matemáticos puros
│   │       └── errors.js                 # ✅ AppError, ValidationError, ExternalApiError
│   │       # formatters.js               # ⏳ Pendiente
│   │       # validators.js               # ⏳ Pendiente (Joi schemas)
│   │
│   ├── data/                             # ✅ Creado automáticamente
│   │   └── cryptex.db                   # ✅ SQLite (WAL mode)
│   ├── migrations/                       # ⏳ Futuro
│   ├── tests/
│   │   └── indicators.test.js            # ✅ 69 tests — todos verdes
│   ├── package.json                      # ✅ ES modules, Jest, dependencias
│   ├── .env.example                      # ✅ Todas las variables documentadas
│   ├── .env                              # ✅ (gitignored) API keys configuradas
│   └── .gitignore                        # ✅
│
├── frontend/                             # 🔄 En desarrollo (Fases 7 y 9 completas)
│   ├── index.html                        # ✅ Layout completo (header, canvas, sidebar)
│   ├── vite.config.js                    # ✅ Proxy /api → :3000
│   ├── package.json                      # ✅ Vite 4.x + PixiJS 7.4.x
│   └── assets/
│       ├── js/
│       │   ├── app.js                    # ✅ Entry point: init, loadData, eventos, store
│       │   ├── api/
│       │   │   └── client.js             # ✅ fetchData() + postAnalyze()
│       │   ├── state/
│       │   │   └── store.js              # ✅ getState / setState / subscribe
│       │   ├── ui/
│       │   │   └── sidebar.js            # ✅ updateHeader, indicators, sentiment, recommendation
│       │   └── renderer/                 # PixiJS v7.4.x
│       │       ├── pixiRenderer.js       # ✅ PIXI.Application + ResizeObserver
│       │       ├── layers.js             # ✅ 4 capas: grid, candle, overlay, ui
│       │       ├── draw.js               # ✅ createViewport, drawGrid, drawCandles
│       │       ├── interactions.js       # ✅ Drag/pan, zoom anclado al cursor, crosshair, tooltip OHLCV
│       │       └── timer.js              # ✅ Clase Timer: start/stop/reset, countdown header
│       └── css/
│           └── styles.css               # ✅ Dark mode completo (variables, todos los componentes)
│
├── docs/                                 # ⏳ Directorio creado, sin contenido aún
│
├── scripts/                              # ⏳ Directorio creado, sin contenido aún
│   # setup-backend.sh
│   # setup-frontend.sh
│   # setup-vps.sh
│   # backup-db.sh
│   # deploy.sh
│
├── .env                                   # (gitignored) Variables
├── .gitignore
└── docker-compose.yml                     # (Opcional) Dev containers
```

---

## 🔌 ENDPOINTS BACKEND

### Data Endpoint (Automático cada 60seg + Manual)

```
GET /api/data?coin=BTC&tf=4h
├─ Query Parameters:
│  ├─ coin: string (BTC|ETH|SOL - SINGULAR, seleccionada en UI)
│  ├─ tf: string (timeframe principal, DEFAULT: 4h)
│  └─ secondary_tfs: string (15m,1h DEFAULT: 15m,1h)
│
├─ Response: 200 OK
│  └─ {
│       "meta": {...},
│       "data": {
│           "coin": "BTC",
│           "price_current": 95420.50,
│           "price_change_24h_pct": 3.45,
│           "technical": {
│             "rsi": { "value": 64, "signal": "healthy_bullish" },
│             "macd": { "value": 0.001234, "histogram": 0.000344 },
│             "bollinger_bands": {...},
│             "volume_delta": {...}
│           },
│           "multi_timeframe": {...},
│           "sentiment": {
│             "score": 0.82,
│             "bullish_votes": 1240,
│             "latest_news": [...]
│           },
│           "last_analysis": {
│             "timestamp": "2026-04-01T14:30:00Z",
│             "action": "BUY",
│             "confidence": 0.76
│           }
│       }
│     }
│
└─ Cache: 60 seg (timer) | No cache (manual) | Processing: ~1.5 seg (3 TF × 1 coin)
```

### Analysis Endpoint (Manual - Botón Usuario)

```
POST /api/analyze
├─ Body:
│  {
│    "coin": "BTC",
│    "primary_tf": "4h",
│    "secondary_tfs": ["15m", "1h"]
│  }
│
├─ Response: 200 OK
│  └─ {
│       "meta": {...},
│       "coin": "BTC",
│       "recommendation": {
│         "action": "BUY",
│         "confidence": 0.76,
│         "rationale": "Confluencia bullish...",
│         "entry_level": 95000,
│         "exit": {
│           "stop_loss": 93200,
│           "take_profit_1": {...},
│           ...
│         },
│         "alerts": [...]
│       }
│     }
│
├─ Processing: ~3-5 sec (llama a Anthropic)
├─ Cost: $0.003 por análisis
└─ Storage: Guarda en SQLite
```

### Sentiment Endpoint (Rápido)

```
GET /api/sentiment/:coin
├─ Response: 200 OK
│  └─ {
│       "coin": "BTC",
│       "score": 0.82,
│       "bullish": 1240,
│       "bearish": 268,
│       "latest_news": [...],
│       "timestamp": "2026-04-01T14:30:00Z"
│     }
│
└─ Cache: 5 minutos
```

### OHLC Endpoint (Histórico)

```
GET /api/ohlc/:coin?tf=4h&days=30&include_delta=true
├─ Response: 200 OK
│  └─ {
│       "coin": "BTC",
│       "timeframe": "4h",
│       "candles": [
│         {
│           "t": 1712000000000,
│           "o": 95000,
│           "h": 96200,
│           "l": 94800,
│           "c": 95420,
│           "v": 45000,
│           "volume_delta": {
│             "buy_pressure": 68,
│             "type": "bullish"
│           }
│         },
│         ...
│       ]
│     }
│
└─ Cache: 1 minuto
```

### History Endpoint (Análisis previos)

```
GET /api/history/:coin?limit=10&offset=0
├─ Response: 200 OK
│  └─ {
│       "coin": "BTC",
│       "total": 256,
│       "analyses": [
│         {
│           "id": "uuid",
│           "timestamp": "2026-04-01T14:32:00Z",
│           "price": 95420.50,
│           "recommendation": "BUY",
│           "confidence": 0.76
│         },
│         ...
│       ]
│     }
│
└─ Sin cache (datos históricos)
```

### Health Endpoint

```
GET /health
├─ Response: 200 OK
│  └─ {
│       "status": "operational",
│       "timestamp": "2026-04-01T14:30:00Z",
│       "services": {
│         "anthropic": "reachable",
│         "cryptopanic": "reachable",
│         "coingecko": "reachable",
│         "database": "connected"
│       }
│     }
```

---

## 📊 INDICADORES TÉCNICOS

### Indicadores implementados localmente (coste $0, sin API externa)

---

#### RSI — Relative Strength Index (Wilder, período 14)

**Qué mide:** Momentum de precio. Compara la magnitud de ganancias recientes frente a pérdidas recientes para evaluar si un activo está sobrecomprado o sobrevendido.

**Fórmula:**
```
Ganancia/pérdida media = Wilder Smoothing de los últimos N cambios de precio
RSI = 100 - (100 / (1 + avgGain / avgLoss))
```

**Señales:**
- RSI > 70 → sobrecomprado (posible reversión bajista)
- RSI < 30 → sobrevendido (posible reversión alcista)
- En bull markets confirmados: ajustar a 80/40

**Mejora implementada — Detección de divergencias automática:**
- **Divergencia bullish:** precio hace nuevo mínimo pero RSI no → señal de reversión alcista
- **Divergencia bearish:** precio hace nuevo máximo pero RSI no → señal de distribución/caída inminente

---

#### StochRSI — Stochastic RSI (14, 14, 3, 3)

**Qué mide:** Es el RSI del RSI: aplica el oscilador estocástico sobre los valores del RSI. Más sensible y rápido que el RSI estándar, ideal para mercados cripto 24/7.

**Fórmula:**
```
RSI = RSI(close, 14)
StochRSI_raw = (RSI - MIN(RSI, 14)) / (MAX(RSI, 14) - MIN(RSI, 14)) * 100
%K = SMA(StochRSI_raw, 3)
%D = SMA(%K, 3)
```

**Señales:**
- %K > 80 → sobrecomprado
- %K < 20 → sobrevendido
- Cruce de %K sobre %D en zona < 20 → entrada long
- Cruce de %K bajo %D en zona > 80 → entrada short
- En cripto en bull run: ajustar umbrales a 90/10

---

#### MACD — Moving Average Convergence Divergence (12, 26, 9)

**Qué mide:** Tendencia y momentum. Diferencia entre dos EMAs para detectar cambios de dirección.

**Fórmula:**
```
MACD line    = EMA(close, 12) - EMA(close, 26)
Signal line  = EMA(MACD line, 9)
Histogram    = MACD line - Signal line
```

**Mejora implementada — Histograma de 4 colores:**
```
Verde oscuro  → histogram > 0 y creciendo   (momentum alcista acelerando)
Verde claro   → histogram > 0 y decreciendo (momentum alcista perdiendo fuerza)
Rojo oscuro   → histogram < 0 y decreciendo (momentum bajista acelerando)
Rojo claro    → histogram < 0 y subiendo    (momentum bajista perdiendo fuerza)
```

**Señales:**
- Cruce MACD sobre Signal → bullish
- Cruce MACD bajo Signal → bearish
- Histograma verde oscuro en zoom out = tendencia fuerte confirmada

---

#### WaveTrend Oscillator (n1=10, n2=21)

**Qué mide:** El oscilador más popular de TradingView para cripto. Detecta sobrecompra/sobreventa con mejor adaptación a la volatilidad cripto que el RSI estándar. Backtests muestran 58% win rate vs 40% del MACD estándar.

**Fórmula:**
```
ap  = (high + low + close) / 3            (precio típico)
esa = EMA(ap, n1)                         (suavizado)
d   = EMA(|ap - esa|, n1)                 (distancia absoluta)
ci  = (ap - esa) / (0.015 * d)            (canal normalizado)
tci = EMA(ci, n2)
WT1 = tci
WT2 = SMA(WT1, 4)
```

**Señales:**
- WT1 > +60 → sobrecomprado
- WT1 < -60 → sobrevendido
- Cruce WT1 sobre WT2 en zona sobrevendida → long (alta probabilidad)
- Cruce WT1 bajo WT2 en zona sobrecomprada → short

---

#### ADX + DMI — Average Directional Index (período 14)

**Qué mide:** La FUERZA de la tendencia (no la dirección). Imprescindible como "filtro de régimen": indica cuándo usar indicadores trend-following vs mean-reversion.

**Fórmula:**
```
True Range   = MAX(high-low, |high-prev_close|, |low-prev_close|)
+DM          = MAX(high - prev_high, 0) si supera al -DM, si no 0
-DM          = MAX(prev_low - low, 0) si supera al +DM, si no 0
ATR14        = Wilder_Smoothing(TR, 14)
+DI          = 100 * Wilder_Smoothing(+DM, 14) / ATR14
-DI          = 100 * Wilder_Smoothing(-DM, 14) / ATR14
DX           = 100 * |+DI - -DI| / (+DI + -DI)
ADX          = Wilder_Smoothing(DX, 14)
```

**Señales:**
- ADX < 20 → mercado lateral (usar RSI/StochRSI, ignorar MACD/WaveTrend)
- ADX 20-25 → tendencia débil
- ADX > 25 → tendencia fuerte (usar MACD, WaveTrend, SuperTrend)
- ADX > 40 → tendencia muy fuerte, cuidado con sobreextensión
- +DI > -DI → tendencia alcista | -DI > +DI → tendencia bajista

---

#### Bollinger Bands (20, 2) + BB Width + BB %B

**Qué mide:** Volatilidad relativa y posición del precio dentro de su rango estadístico.

**Fórmula:**
```
Middle  = SMA(close, 20)
Upper   = Middle + 2 * StdDev(close, 20)
Lower   = Middle - 2 * StdDev(close, 20)

BB Width = (Upper - Lower) / Middle * 100    ← volatilidad cuantificada
BB %B    = (close - Lower) / (Upper - Lower) ← posición relativa
```

**Señales:**
- %B > 1 → precio sobre banda superior (extremo)
- %B < 0 → precio bajo banda inferior (extremo)
- BB Width en mínimo histórico → squeeze inminente (breakout próximo)
- BB Width expandiéndose con precio fuera de banda → momentum fuerte

---

#### SuperTrend Adaptativo (ATR 14, multiplicador 3.0)

**Qué mide:** Trailing stop dinámico que se adapta a la volatilidad. A diferencia del Parabolic SAR, usa ATR lo que lo hace robusto en la volatilidad cripto.

**Fórmula:**
```
ATR14         = Average True Range(14)
basic_upper   = (high + low) / 2 + multiplier * ATR14
basic_lower   = (high + low) / 2 - multiplier * ATR14

Versión adaptativa:
adaptive_mult = base_mult * (ATR_current / EMA(ATR, 50))
```
Las bandas se ensanchan en volatilidad alta y se contraen en calma sin configuración manual.

**Señales:**
- Precio sobre la línea verde → tendencia UP, la línea es soporte dinámico
- Precio bajo la línea roja → tendencia DOWN, la línea es resistencia dinámica
- Cruce del precio sobre la línea → cambio de tendencia

---

#### Fibonacci Retracements

**Qué mide:** Niveles de soporte/resistencia basados en la secuencia de Fibonacci aplicada al rango high-low del período visible.

**Niveles:** 0% (high), 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100% (low)

**Uso:** El precio tiende a rebotar o encontrar resistencia en estos niveles durante correcciones. El nivel 61.8% ("golden ratio") es el más relevante para cripto.

---

#### Soporte & Resistencia automáticos

**Qué mide:** Identifica zonas de precio donde el mercado ha revertido repetidamente, agrupando highs y lows por proximidad.

**Algoritmo:**
```
1. Recopilar highs y lows de las últimas 50 velas
2. Agrupar niveles con proximidad < 0.5% (tolerancia)
3. Filtrar por mínimo 2 toques
4. Calcular fuerza (1-5) según número de toques
5. Clasificar en supports (< precio actual) y resistances (≥ precio actual)
6. Devolver top 3 de cada tipo
```

---

#### Volume Delta

**Qué mide:** Presión compradora vs vendedora en cada vela, estimada a partir de la posición del cierre dentro del rango high-low.

**Fórmula:**
```
buy_ratio  = (close - low) / (high - low)
buy_vol    = volume * buy_ratio
sell_vol   = volume * (1 - buy_ratio)
```

**Señales:**
- buy_pressure > 70% → presión compradora dominante
- last_candle_type: strong_bullish / bullish / bearish / strong_bearish
- anomaly: true si presión > 90% en un solo sentido

---

#### CVD — Cumulative Volume Delta

**Qué mide:** Suma acumulativa del Volume Delta. Detecta divergencias entre precio y flujo de órdenes de largo plazo.

**Fórmula:**
```
CVD[0] = VolumeDelta[0]
CVD[i] = CVD[i-1] + VolumeDelta[i]
```

**Señales clave:**
- Precio en nuevo ATH pero CVD plano → buyer exhaustion (distribución encubierta)
- Precio en nuevo mínimo pero CVD sube → acumulación institucional (suelo próximo)

---

#### OBV — On-Balance Volume

**Qué mide:** Flujo de volumen acumulativo. Si el precio sube, suma el volumen; si baja, lo resta. Detecta acumulación/distribución institucional silenciosa.

**Fórmula:**
```
Si close > prev_close: OBV = OBV_prev + volume
Si close < prev_close: OBV = OBV_prev - volume
Si close = prev_close: OBV = OBV_prev
```

**Señales:**
- OBV hace nuevos máximos antes que el precio → acumulación institucional (señal alcista anticipada)
- OBV no confirma nuevo máximo de precio → distribución encubierta (señal bajista)

---

#### Market Regime Badge

**Qué mide:** Clasificación automática del régimen de mercado actual combinando ADX y BB Width.

**Lógica:**
```
TRENDING:        ADX > 25 AND BB_Width > percentil_70 histórico
                 → Usar: SuperTrend, MACD, WaveTrend
                 → Ignorar: señales de reversión RSI/StochRSI

RANGING:         ADX < 20 AND BB_Width < percentil_30 histórico
                 → Usar: RSI, StochRSI, BB %B, WaveTrend
                 → Ignorar: cruces MACD, trend-following

HIGH_VOLATILITY: ATR > 2x SMA(ATR, 20)
                 → Señales no confiables, reducir tamaño de posición
```

Este badge se muestra visualmente en el dashboard y se incluye en el prompt de Claude para contextualizar el análisis.

---

### Indicadores de sentimiento externo (APIs)

---

#### Fear & Greed Index (alternative.me)

**Qué mide:** El barómetro de sentimiento más citado del mundo cripto. Rango 0-100. Combina: volatilidad de precio, momentum de mercado, social media, dominancia BTC y tendencias de búsqueda.

**API:** `GET https://api.alternative.me/fng/?limit=1`
- Completamente **gratuita**, sin registro, sin API key
- Rate limit: 60 req/min
- Actualiza cada ~5 minutos
- Cache TTL en CRYPTEX: 10 minutos

**Clasificaciones:**
```
0-24   → Extreme Fear  (históricamente: zona de compra)
25-49  → Fear
50-74  → Greed
75-100 → Extreme Greed (históricamente: zona de peligro/techo)
```

**Uso en IA:** Se incluye en el prompt de Claude con su clasificación e histórico reciente para contextualizar si el mercado está en pánico o euforia.

---

#### Funding Rate — Tasa de financiación perpetuos (Coinalyze)

**Qué mide:** El coste que pagan los traders de contratos perpetuos por mantener su posición. Cuando es muy positivo, los longs pagan a los shorts; cuando es muy negativo, al revés. Es el indicador de "temperatura" de los derivados.

**APIs:**
- `GET /v1/funding-rate` → tasa actual + tendencia 48h (via `/funding-rate-history?interval=6hour`)
- **Gratuita con registro** en Coinalyze
- Datos agregados de Binance, Bybit, OKX, BitMEX
- Cache TTL en CRYPTEX: 30 minutos (actualiza cada 8h en exchanges)
- Histórico: últimas 8 entradas (48h @ interval=6hour) guardadas en `historyService`

**Señales:**
```
Funding > +0.1%  → mercado sobrecargado de longs → riesgo de short squeeze / liquidación masiva
Funding > +0.05% → sesgo alcista moderado
Funding ~0%      → mercado equilibrado
Funding < -0.05% → sesgo bajista, shorts pagando → posible short squeeze alcista
```

**Coins:** BTC, ETH tienen funding rate relevante. SOL tiene perpetuos pero con menor impacto.

---

#### Open Interest (Coinalyze)

**Qué mide:** Total de contratos de derivados abiertos (en USD). Refleja el dinero total apostado en el mercado de futuros/perpetuos.

**APIs:**
- `GET /v1/open-interest` → OI actual + cambio 24h real (via `/open-interest-history?interval=4hour`)
- Cache TTL en CRYPTEX: 5 minutos
- Histórico: últimas 42 entradas (7 días @ interval=4hour) guardadas en `historyService`
- Cambio 24h calculado: (último candle - primer candle) / primer candle * 100

**Señales:**
```
OI sube + precio sube   → tendencia real con dinero nuevo entrando (fuerte)
OI sube + precio lateral → tensión acumulada, breakout inminente
OI baja + precio sube   → short squeeze (posiciones cortas cerrándose forzosamente)
OI baja + precio baja   → liquidaciones, desenrosco de posiciones
```

---

#### Long/Short Ratio (Coinalyze)

**Qué mide:** Porcentaje de posiciones largas vs cortas en exchanges de derivados retail.

**API:** `GET /v1/long-short-ratio-history?symbols=BTCUSDT_PERP.A&interval=1hour&from=T-7d&to=T`
- Cache TTL en CRYPTEX: 5 minutos
- Histórico: últimas 168 entradas (7 días @ interval=1hour) guardadas en `historyService`
- Permite análisis de cambios en posicionamiento y ciclos de positioning

**Señales (indicador contrario en retail):**
```
> 60% longs  → mercado sesgado a compra → cuidado, los longs son la liquidez de los bajistas
< 40% longs  → mercado sesgado a cortos → posible long squeeze alcista
```

**Nota:** El L/S ratio de exchanges retail (Binance) es un indicador contrario — cuando todos son long, el mercado suele girar a la baja.

---

#### Liquidaciones 24h (Coinalyze)

**Qué mide:** Volumen total de posiciones liquidadas forzosamente en las últimas 24 horas. Refleja la violencia del movimiento del precio y cuántos traders apalancados quedaron fuera.

**API:** `GET /v1/liquidation-history?symbols=BTCUSDT_PERP.A&interval=1hour&from=T-86400&to=T`
- Cache TTL en CRYPTEX: 5 minutos
- Histórico: últimas 7 entradas (7 días, 1 suma diaria) guardadas en `historyService`

**Campos:** `longs_usd` (posiciones largas liquidadas) y `shorts_usd` (posiciones cortas liquidadas)

**Señales:**
```
Longs > Shorts × 2    → longs siendo barridos, precio cayendo fuerte, posible capitulación
Shorts > Longs × 2    → short squeeze, precio subiendo, pánico de bajistas
Longs ≈ Shorts       → movimiento equilibrado
Total > $500M en 24h  → movimiento MUY violento, liquidaciones en cascada
```

**Uso:** Detecta pánicos, capitulaciones y squeezes. Liquidaciones de longs en zona de soporte pueden marcar fondos.

---

#### BTC Dominance % (CoinGecko)

**Qué mide:** Porcentaje del market cap total cripto que representa Bitcoin. Crítico para entender rotaciones entre BTC y altcoins (ETH, SOL).

**API:** `GET https://api.coingecko.com/api/v3/global` → campo `bitcoin_dominance_percentage`
- Misma API ya integrada para OHLC, sin coste adicional
- Cache TTL en CRYPTEX: 10 minutos

**Señales:**
```
BTC.D subiendo  → capital rotando hacia BTC (bear para altcoins)
BTC.D bajando de 50% → altseason posible (bull para ETH/SOL)
BTC.D < 45%    → altseason confirmada históricamente
```

**Uso en dashboard:** Widget en el header. Contextualiza por qué ETH o SOL pueden moverse más o menos que BTC en un momento dado.

---

### Uso de todos los indicadores en el prompt de Claude

Cuando el usuario pulsa "⚡ Analizar", Claude recibe un prompt estructurado que incluye **todos** los datos anteriores:

```
RÉGIMEN DE MERCADO: TRENDING (ADX=32, BB_Width en percentil 75)

TÉCNICOS (4H):
  RSI=64 (healthy_bullish), divergencia: ninguna
  StochRSI %K=72 / %D=68 (sobrecomprado moderado)
  MACD=+0.00123, histograma verde oscuro (acelerando)
  WaveTrend WT1=+45 / WT2=+38 (bullish, no extremo)
  ADX=32, +DI=28 > -DI=14 (tendencia alcista fuerte)
  BB %B=0.72, BB Width=1.45% (expandiendo)
  SuperTrend=UP (soporte dinámico en $93.200)
  Volume Delta: 68% buy pressure (strong_bullish)
  CVD: creciendo con el precio (confirmado)
  OBV: en nuevo ATH (acumulación confirmada)

FIBONACCI: 61.8% en $94.820, 38.2% en $97.360
SOPORTE/RESISTENCIA: S1=$93.500 (fuerza 3), R1=$96.800 (fuerza 3)

SENTIMIENTO:
  Fear & Greed: 72 (Greed)
  CryptoPanic: score=0.82 (bullish), 1240 votos bullish vs 268 bearish
  Funding Rate: +0.045% (sesgo alcista moderado, sin sobrecalentamiento)
  Open Interest: +8.5% en 24h (dinero nuevo entrando)
  Long/Short Ratio: 58% longs (sesgo alcista moderado)
  BTC Dominance: 52.3% (estable)

PRECIO ACTUAL: $95.420 (+3.45% 24h)
ÚLTIMO ANÁLISIS: hace 4h, recomendación BUY con 76% confianza
```

---

## 📦 SCHEMAS JSON

### Response de Análisis Completo

```json
{
  "meta": {
    "timestamp": "2026-04-01T14:32:00Z",
    "request_id": "req_abc123def456",
    "processing_time_ms": 3240,
    "version": "1.0"
  },
  
  "coin": "BTC",
  "price_current": 95420.50,
  "price_change_24h_pct": 3.45,
  
  "technical": {
    "trend": "strongly_bullish",
    "rsi": {
      "value": 64,
      "signal": "healthy_bullish",
      "timeframe": "4h"
    },
    "macd": {
      "value": 0.001234,
      "signal": 0.000890,
      "histogram": 0.000344,
      "status": "bullish_momentum"
    },
    "bollinger_bands": {
      "upper": 96200,
      "middle": 94800,
      "lower": 93400,
      "width_pct": 1.45,
      "position": 0.65,
      "status": "expanding"
    },
    "volume_delta": {
      "buy_pressure_pct": 68,
      "sell_pressure_pct": 32,
      "last_candle_type": "strong_bullish",
      "anomaly": false
    }
  },

  "multi_timeframe": {
    "tf_15m": {
      "trend": "bullish",
      "rsi": 71,
      "status": "overbought_short_term",
      "warning": "possible_pullback"
    },
    "tf_1h": {
      "trend": "bullish",
      "rsi": 58,
      "status": "healthy",
      "breakout": { "level": 95500, "strength": "confirmed" }
    },
    "tf_4h": {
      "trend": "strongly_bullish",
      "rsi": 52,
      "status": "accumulation_confirmed",
      "next_resistance": 96800
    }
  },

  "sentiment": {
    "cryptopanic": {
      "score": 0.82,
      "votes": {
        "bullish": 1240,
        "bearish": 268
      },
      "trend": "improving",
      "impact_level": "high"
    },
    "latest_news": [
      {
        "title": "Bitcoin alcanza nuevo máximo histórico",
        "url": "https://cryptopanic.com/...",
        "importance": "high",
        "sentiment": "bullish",
        "votes": 156,
        "created_at": "2026-04-01T14:00:00Z"
      }
    ]
  },

  "support_resistance": {
    "supports": [
      { "price": 93500, "strength": 3, "touches": 5 },
      { "price": 91200, "strength": 2, "touches": 3 }
    ],
    "resistances": [
      { "price": 96800, "strength": 3, "touches": 6 },
      { "price": 98500, "strength": 2, "touches": 2 }
    ]
  },

  "fibonacci": [
    { "level": 0, "price": 100000 },
    { "level": 0.236, "price": 97360 },
    { "level": 0.382, "price": 94820 },
    { "level": 0.5, "price": 92500 },
    { "level": 0.618, "price": 90180 },
    { "level": 0.786, "price": 87860 },
    { "level": 1, "price": 85200 }
  ],

  "recommendation": {
    "action": "BUY",
    "confidence": 0.76,
    "rationale": "Confluencia bullish: 4H en tendencia fuerte, volumen comprador masivo (68%), sentimiento positivo (82%). Próximo objetivo: $96.8k.",
    
    "entry_level": 95000,
    "entry_alternative": 94600,
    
    "exit": {
      "stop_loss": 93200,
      "take_profit_1": { "price": 96500, "pct": 0.33 },
      "take_profit_2": { "price": 98200, "pct": 0.34 },
      "take_profit_3": { "price": 100000, "pct": 0.33 }
    },

    "risk_analysis": {
      "risk_reward_ratio": 2.8,
      "max_risk_pct": 2.3,
      "risk_level": "medium",
      "max_position_size_pct": 4.5
    },

    "duration": "medium_term",
    
    "alerts": [
      {
        "type": "warning",
        "priority": "high",
        "message": "RSI 15m en sobrecompra (71) - potencial pullback corto"
      },
      {
        "type": "watch",
        "priority": "medium",
        "message": "Noticias positivas sobre adopción institucional"
      }
    ]
  },

  "ai_metadata": {
    "model": "claude-sonnet-4-20250514",
    "prompt_version": "v2_sentiment_aware",
    "confidence_factors": [
      "multi_tf_alignment",
      "sentiment_bullish",
      "volume_delta_bullish",
      "technicals_aligned"
    ]
  },

  "history": {
    "fear_greed": [
      { "date": "2026-04-03", "value": 12, "classification": "Extreme Fear", "trend": "improving" },
      { "date": "2026-04-02", "value": 8, "classification": "Extreme Fear", "trend": "worsening" },
      ...
    ],
    "funding_rate": [
      { "t": 1775152800, "o": 0.001234, "h": 0.001456, "l": 0.000890, "c": 0.001100, "trend": "rising" },
      ...
    ],
    "open_interest": [
      { "t": 1775152800, "o": 89000, "h": 89500, "l": 88500, "c": 89200 },
      ...
    ],
    "long_short_ratio": [
      { "t": 1775160000, "long_pct": 65.5, "short_pct": 34.5 },
      ...
    ],
    "liquidations": [
      { "date": "2026-04-03", "longs_usd": 155.53, "shorts_usd": 64.85 },
      { "date": "2026-04-02", "longs_usd": 142.20, "shorts_usd": 58.90 }
    ]
  }
}
```

---

## 💾 BASE DE DATOS

### Tabla: analyses

```sql
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  coin TEXT NOT NULL,
  primary_tf TEXT DEFAULT '4h',
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Datos de mercado
  price_current REAL,
  price_change_24h REAL,
  
  -- Indicadores técnicos
  rsi REAL,
  macd_value REAL,
  macd_signal REAL,
  macd_histogram REAL,
  bb_upper REAL,
  bb_middle REAL,
  bb_lower REAL,
  
  -- Volumen
  volume_buy_pct REAL,
  volume_sell_pct REAL,
  
  -- Sentimiento
  sentiment_score REAL,
  bullish_votes INTEGER,
  bearish_votes INTEGER,
  
  -- Recomendación
  recommendation TEXT,                    -- JSON stringified
  recommendation_action TEXT,             -- BUY, SELL, HOLD
  recommendation_confidence REAL,
  
  -- Respuesta IA completa
  ai_response TEXT,                       -- JSON completo
  
  -- Metadata
  processing_time_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(coin, primary_tf, timestamp)
);

CREATE INDEX idx_coin_timestamp ON analyses(coin, timestamp DESC);
CREATE INDEX idx_recommendation ON analyses(recommendation_action);
```

### Tabla: sentiment_cache

```sql
CREATE TABLE sentiment_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin TEXT UNIQUE NOT NULL,
  score REAL,
  bullish_votes INTEGER,
  bearish_votes INTEGER,
  news_count INTEGER,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabla: candles_cache

```sql
CREATE TABLE candles_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume REAL,
  
  UNIQUE(coin, timeframe, timestamp)
);

CREATE INDEX idx_coin_tf_timestamp ON candles_cache(coin, timeframe, timestamp DESC);
```

---

## 🔄 FLUJOS DE DATOS

### Flujo 1: Usuario abre dashboard

```
1. Frontend carga HTML
2. Selector coin: DEFAULT = BTC
3. PixiJS se inicializa (canvas vacío)
4. Hace GET /api/data?coin=BTC (sin IA)
   └─ Backend inicia 60sec timer interno
5. Backend paralelo (sin IA):
   ├─ Promise.all([
   │  ├─ fetchOHLC(BTC, [15m, 1h, 4h]),  // 1 coin, 3 TF
   │  ├─ calculateIndicators(...),
   │  └─ fetchSentiment(BTC)
   │ ])
6. Backend NO envía a Anthropic en este punto
7. Retorna JSON técnico + sentimiento a frontend (~1.5 seg)
8. Frontend:
   ├─ Renderiza gráficos PixiJS
   ├─ Actualiza panel indicadores (con tooltips/descripciones)
   ├─ Muestra sentimiento score + noticias
   ├─ Panel recomendación: DESHABILITADO (esperando análisis)
   ├─ Botones habilitados: "🔄 Actualizar" + "⚡ Analizar"
   └─ Inicia timer 60 seg
```

### Flujo 2: Auto-refresh cada 60 segundos + Botón Manual

```
TIMER (cada 60 seg automático) - COSTO $0:
  ├─ GET /api/data?coin=BTC (coin seleccionada, sin IA)
  ├─ Backend procesa (3 TF × 1 coin = 3 requests):
  │  ├─ Fetch OHLC paralelo
  │  ├─ Calcular indicadores
  │  ├─ Fetch Sentimiento (cached 5min)
  │  └─ NO llama a Anthropic
  ├─ Frontend:
  │  ├─ Clear gráficos previos
  │  ├─ Renderiza nuevas velas
  │  ├─ Actualiza indicadores
  │  ├─ Actualiza sentimiento
  │  └─ Mantiene estado de zoom/pan
  └─ Nota: Recomendación IA se mantiene (no se borra)

BOTÓN "🔄 ACTUALIZAR" (manual, on-demand) - COSTO $0:
  ├─ User clickea botón
  ├─ GET /api/data?coin=BTC (mismo endpoint, mismo coin)
  ├─ Processing: ~1.5 seg
  ├─ Frontend actualiza gráficos + indicadores
  ├─ Reinicia countdown timer 60 seg
  └─ User puede clickear again sin esperar (no blocking)
```

### Flujo 3: Usuario clickea "⚡ Analizar" - COSTO $0.003

```
USUARIO CLICKEA EN BOTÓN:
  ├─ Frontend POST /api/analyze
  │  └─ Body: { 
  │       coin: "BTC",
  │       primary_tf: "4h",
  │       secondary_tfs: ["15m", "1h"],
  │       current_data: {...}  // datos ya calculados
  │     }
  │
  ├─ Loading state: UI muestra spinner "Analizando..."
  │
  ├─ Backend:
  │  ├─ Recibe datos técnicos + sentimiento ACTUAL
  │  ├─ Arma prompt estructurado (todo junto)
  │  ├─ Envía a Anthropic (AQUÍ se gasta $)
  │  ├─ Recibe JSON recomendación
  │  └─ Guarda en SQLite (histórico)
  │
  ├─ Retorna JSON recomendación a frontend
  │
  └─ Frontend:
     ├─ Hidden → Visible: Panel recomendación
     ├─ Renderiza: Action, Confidence, Entry/Exit, Alerts
     ├─ Con timestamp: "Análisis a las 14:32"
     └─ Botón "⚡ Analizar" sigue activo para nuevos análisis
```

### Flujo 4: Usuario interactúa con gráfico

```
Mouse move en PixiJS:
  ├─ PixiJS event listener detecta posición
  ├─ Calcula índice de vela más cercana
  ├─ Renderiza tooltip con OHLC + Volumen Delta
  └─ Muestra definición del indicador en hover

Drag en gráfico:
  ├─ PixiJS viewport reposiciona
  └─ No hace nueva petición (datos ya cargados)

Scroll/Zoom:
  ├─ PixiJS scale camera
  ├─ Actualiza viewport
  └─ No hace nueva petición

Click en noticia sidebar:
  ├─ Destaca noticia seleccionada
  ├─ Muestra descripción completa
  └─ (Futuro) Podría enviar noticia a IA para contexto extra
```

### Flujo 5: Cambio de moneda (selector dropdown)

```
Usuario cambia selector coin (BTC → ETH):
  ├─ Cancela timer anterior
  ├─ GET /api/data?coin=ETH (nueva moneda singular)
  ├─ Frontend renderiza nuevos datos
  ├─ Panel recomendación se limpia (no había análisis para ETH)
  ├─ Botones habilitados: "🔄 Actualizar" + "⚡ Analizar" (para ETH)
  └─ Reinicia timer 60 seg con coin=ETH
```

---

## 🚀 ROADMAP DE IMPLEMENTACIÓN

### ✅ FASE 1: Setup Inicial — COMPLETADA

- [x] Estructura de carpetas completa (backend + frontend)
- [x] Node.js 18 LTS instalado via nvm
- [x] npm install — 355 dependencias instaladas
- [x] `.env.example` con todas las variables documentadas
- [x] `.gitignore` configurado
- [x] SQLite inicializado con las 3 tablas (analyses, sentiment_cache, candles_cache)
- [x] WAL mode activado para performance

**Outcome:** Backend corriendo, DB connectable ✅

---

### ✅ FASE 2: Backend Skeleton — COMPLETADA

- [x] Express server + graceful shutdown (SIGTERM/SIGINT)
- [x] Routes skeleton: `/health`, `/api/data`, `/api/analyze`, `/api/history`
- [x] Error handling middleware con clases tipadas (AppError, ValidationError, ExternalApiError)
- [x] Logging Pino con pino-pretty en development
- [x] CORS + Helmet + Compression
- [x] Health endpoint responde correctamente

**Outcome:** Backend acepta requests, devuelve 200 ✅

---

### ✅ FASE 3: Indicadores & Cálculos — COMPLETADA (AMPLIADA)

Implementados más indicadores de los planificados originalmente:

- [x] RSI (Wilder, período 14) + detección de divergencias automática
- [x] Stochastic RSI (14, 14, 3, 3) — añadido en revisión
- [x] MACD (12/26/9) con histograma de 4 colores
- [x] WaveTrend Oscillator (n1=10, n2=21) — añadido en revisión
- [x] ADX + DMI (período 14) — añadido en revisión
- [x] Bollinger Bands (20/2) + BB Width + BB %B
- [x] SuperTrend adaptativo (ATR 14, mult 3.0)
- [x] Fibonacci levels automáticos
- [x] Support & Resistance detection
- [x] Volume Delta por vela
- [x] CVD — Cumulative Volume Delta — añadido en revisión
- [x] OBV — On-Balance Volume — añadido en revisión
- [x] ATR helper
- [x] Market Regime Badge (TRENDING/RANGING/HIGH_VOLATILITY)
- [x] **69 tests unitarios — todos verdes**

**Outcome:** 14 indicadores matemáticos implementados y testeados ✅

---

### ✅ FASE 4: Data Services — COMPLETADA (AMPLIADA)

Implementados más servicios de los planificados originalmente:

- [x] `cacheService` — in-memory TTL cache por key
- [x] `dbService` — CRUD sentiment_cache + analyses con pruning automático
- [x] `coingeckoService` — OHLC 3 TF + precio + BTC Dominance + volumen enriquecido
- [x] `cryptopanicService` — API v2, fallback SQLite con flag `stale`
- [x] `fearGreedService` — alternative.me, sin API key, gratuito — añadido en revisión
- [x] `coinalyzeService` — Funding Rate + Open Interest + L/S Ratio — añadido en revisión
- [x] `indicatorService` — orquesta los 14 indicadores por timeframe

**Outcome:** Todos los services conectados con APIs externas ✅

---

### ✅ FASE 5: Data Controller (SIN IA) — COMPLETADA

- [x] `GET /api/data?coin=BTC&tf=4h` — orquestación paralela completa
- [x] `Promise.allSettled` — ningún fallo externo bloquea la respuesta
- [x] Validación de parámetros coin y tf con errores tipados
- [x] Respuesta JSON completa: técnicos 3TF + sentimiento + derivados + BTC dominance
- [x] Tiempo de respuesta real: ~600ms (3 TF × 1 coin en paralelo)
- [x] Degraded mode: servicios opcionales (Coinalyze) devuelven null si no hay key

**Outcome:** `GET /api/data` devuelve todos los indicadores en vivo ✅

---

### ✅ FASE 6: Anthropic Integration (Botón Manual) — COMPLETADA PARCIALMENTE

- [x] `anthropicService.js` — stub con `buildPrompt()` completo y `analyzeMarket()` esqueleto
- [x] Prompt engineering enriquecido con todos los indicadores, sentimiento, derivados y BTC.D
- [x] `analysisController.js` — POST /api/analyze: fetch paralelo + indicators + Anthropic + DB
- [x] `historyController.js` — GET /api/history/:coin con paginación (limit 1-50, offset)
- [x] Persistencia en SQLite via `dbService.saveAnalysis()` con pruning automático
- [x] Manejo de errores: 503 si no hay API key, 501 hasta implementación completa
- [ ] **PENDIENTE ANTHROPIC_API_KEY:** implementar cuerpo de `analyzeMarket()` en anthropicService.js

**Outcome:** Infraestructura completa. Falta activar con la API key real.

---

### ✅ FASE 7: Frontend Setup + PixiJS — COMPLETADA

- [x] HTML structure: header + canvas + sidebar (indicadores, sentimiento, recomendación IA)
- [x] Vite 4.x + build (475 módulos, sin errores)
- [x] PixiJS v7.4.x: Application + ResizeObserver dinámico
- [x] 4 capas de renderizado: grid, candle, overlay, ui
- [x] `draw.js`: sistema viewport, drawGrid (ejes X/Y con etiquetas), drawCandles (bull/bear)
- [x] Datos dummy para verificación visual

**Outcome:** Frontend muestra grid + velas con datos sintéticos ✅

---

### ✅ FASE 8: Interactividad PixiJS — COMPLETADA

- [x] Drag/pan horizontal con setPointerCapture
- [x] Zoom con rueda anclado al cursor (frac sobre chartW, clamp [20, candles.length])
- [x] Crosshair (líneas vertical+horizontal en uiLayer, solo dentro del área del gráfico)
- [x] Tooltip OHLCV: fondo rect + barra accent + pares label/valor; volteo izquierda cerca del borde
- [x] `buildViewport()` recalcula rango de precio + 8% de padding

**Outcome:** Gráfico completamente interactivo ✅

---

### ✅ FASE 9: Frontend Integration — COMPLETADA

- [x] `api/client.js`: fetchData(coin, tf) + postAnalyze(coin, tf) con manejo de errores
- [x] `state/store.js`: getState / setState / subscribe (patrón observable sin framework)
- [x] `ui/sidebar.js`: updateHeader, updateRegimeBadge, updateIndicators (8 indicadores con señales), updateSentiment (Fear&Greed + CryptoPanic + derivados), updateRecommendation (BUY/SELL/HOLD + TP/SL + alertas)
- [x] Conectar PixiJS ↔ data flow: candles reales en el gráfico tras loadData()
- [x] `dataController.js` extendido: incluye `candles` del TF principal en la respuesta
- [x] Botones "Actualizar" y "Analizar" conectados; selector coin y TF buttons funcionales

**Outcome:** Frontend hablando con backend — datos reales en canvas + sidebar ✅

---

### ✅ FASE 10: UI Polish & Sidebar — COMPLETADA

- [x] News feed CryptoPanic: `#news-list` con `.news-item.bullish/bearish/neutral`, link, fuente y tiempo relativo
- [x] Flash animación precio: `@keyframes flash-up/flash-down`, disparado con `void el.offsetWidth`
- [x] Timer visual "soon": `.timer-display.soon { color: var(--bearish) }` cuando quedan ≤10s
- [x] Tooltips indicadores: explicaciones detalladas en todos los `.ind-name` (reescritos con nivel didáctico para nuevos en trading)
- [x] Tooltips sentimiento: mismo estilo y nivel de detalle en Fear & Greed, CryptoPanic, Funding Rate, Open Interest, L/S Ratio
- [x] Icono de ayuda: pseudo-elemento `::after` con punto 5px que se rellena con `var(--accent)` en hover — aplicado a `.ind-name` y `.sent-label[title]`
- [x] Bug fixes: regime badge (string plano), SuperTrend (usar `st.support/st.resistance`), clases `.sent-signal`

**Outcome:** UI profesional y funcional ✅

---

### ✅ FASE 11: Auto-refresh Timer + Botón Manual — COMPLETADA

- [x] Clase `Timer(seconds, onTick, onExpire)` en `timer.js` con `start/stop/reset`, usa `setTimeout` recursivo
- [x] Timer 60s integrado en `app.js`: `timer.reset()` en refresh manual, cambio de TF y cambio de coin
- [x] `btn-refresh` hace GET /api/data y reinicia timer
- [x] Countdown visual en header con estilo "soon" ≤10s

**Outcome:** Dashboard auto-actualiza cada 60 seg + refresh manual ✅

---

### ✅ FASE 12: SQLite Persistence — COMPLETADA (backend)

- [x] Tabla `analyses`: histórico de análisis IA (máx 1000 por coin, pruning automático)
- [x] Tabla `sentiment_cache`: fallback persistente de CryptoPanic por coin
- [x] `dbService.js`: saveAnalysis(), getAnalysisHistory(), getLastAnalysis()
- [x] `GET /api/history/:coin` devuelve histórico paginado
- [ ] Frontend panel de histórico: pendiente (Bloque 5)

**Outcome:** Persistencia backend operativa ✅

---

### ✅ FASE 13: Selector Coin + Timeframes + Persistencia localStorage — COMPLETADA

- [x] Selector dropdown BTC|ETH|SOL conectado en `app.js`
- [x] Timer se reinicia al cambiar coin o TF
- [x] `state/storage.js`: persistencia por coin en localStorage (`cryptex_coin`, `cryptex_state_BTC/ETH/SOL`)
- [x] Cada coin recuerda su TF activo y su última recomendación IA
- [x] Al cambiar de coin se restaura el estado previo (TF + panel recomendación)
- [x] `syncTfButtons(tf)`: sincroniza el botón activo con el estado restaurado
- [x] Timeframes ampliados: **15m, 1h, 4h, 8h, 1D** — botones ordenados de menor a mayor
  - 8h: market_chart hourly agrupado en buckets de 8h (~180 candles, OHLCV real)
  - 1D: endpoint `/ohlc?days=365` (granularidad diaria, ~365 candles)
- [x] Bug 1h corregido: `fetchMarketChartAggregated` usa `prev.close` como `open` de la siguiente vela (evitaba dojis planos open=close)
- [x] `draw.js` → `formatTime`: detecta intervalo entre velas — ≥6h muestra `DD/MM`, <6h muestra `HH:MM`
- [x] WaveTrend sidebar: señal ahora usa `wt.signal` del backend (cross up/down, overbought/oversold) en vez de solo `wt1 > 0`

**Outcome:** Selector dropdown funcional con persistencia completa ✅

---

### ⏳ FASE 14: VPS Deployment (2-3 horas)

- [ ] Nginx reverse proxy setup
- [ ] SSL/TLS (certbot Let's Encrypt)
- [ ] PM2 ecosystem config
- [ ] Systemd socket (auto-restart)
- [ ] Backup automático SQLite
- [ ] Logging centralizado
- [ ] Monitoreo básico
- [ ] Tests: Sistema corriendo en VPS sin errores

**Outcome:** CRYPTEX en producción, accesible privado

---

### ⏳ FASE 15: Testing & Docs (1-2 horas)

- [ ] Unit tests (indicadores)
- [ ] Integration tests (endpoints)
- [ ] E2E tests (UI completa)
- [ ] API docs finales
- [ ] Guía deployment
- [ ] Troubleshooting FAQ

**Outcome:** Proyecto documentado, testeado, listo

---

**TOTAL ESTIMADO: 28-35 horas**

### 📊 Estado actual (2026-04-02)

| Bloque | Fases | Estado |
|--------|-------|--------|
| Bloque 1 — Fundamentos backend | 1, 2, 3 | ✅ Completado |
| Bloque 2 — Datos en vivo | 4, 5 | ✅ Completado |
| Bloque 3 — IA (Anthropic) | 6 | ✅ Completado (pendiente API key) |
| Bloque 4 — Frontend | 7, 8, 9, 10, 11, 13 | ✅ Completado |
| Bloque 4.5 — Históricos para IA | (Transversal) | ✅ Completado |
| Bloque 5 — Cierre | 12 (backend ✅), 14, 15 | ⏳ Pendiente |

**Siguiente acción:** Bloque 5 — panel frontend de histórico IA (Fase 12), deploy VPS (Fase 14), tests de integración (Fase 15). Sistema de históricos (F&G 30d, FR/OI/L/S/Liq 7d) está operativo en `/api/data` para análisis LLM.

---

## ✅ DECISIONES FINALES CONFIRMADAS

| Aspecto | Decisión | Rationale |
|---------|----------|-----------|
| **Backend** | Node.js + Express | Rápido, async, WebSocket ready |
| **Database** | SQLite | Local, sin overhead, perfecto para 1 user |
| **Renderizado** | PixiJS | Drag/Zoom interactivo requerido |
| **Hosting** | VPS propio | Control total, datos privados |
| **Monedas** | BTC, ETH, SOL (selector) | 1 a la vez, TOP 3 criptos |
| **Refresh Automático** | Timer 60seg | OHLC + Indicadores (GRATIS) |
| **Refresh Manual** | Botón "🔄 Actualizar" | On-demand, restarting timer (GRATIS) |
| **Análisis IA** | POST /api/analyze on-demand | Manual (botón usuario, ~$0.003 por click) |
| **Sentimiento** | Fear & Greed (gratis) + CryptoPanic (requiere plan de pago desde 2026) | Barómetro global; CryptoPanic muestra "—" sin suscripción |
| **Derivados** | Coinalyze (gratis) | Funding Rate, OI, L/S Ratio — el 75% del volumen cripto |
| **IA** | Anthropic Claude | Mejor análisis, JSON structured, prompt enriquecido |
| **Persistencia** | SQLite + histórico | Solo análisis IA (datos técnicos no guardados) |
| **Acceso** | Solo usuario (sin auth) | IP privada o localhost |
| **PixiJS** | v7.4.x | v8 sin documentación madura; v7 estable con abundantes ejemplos |

---

## 📝 NOTAS IMPORTANTES

### Costo & Control
- **Timer 60seg:** 100% gratis (cálculos locales + CoinGecko + CryptoPanic + alternative.me + Coinalyze)
- **Botón "⚡ Analizar":** ~$0.003 por análisis (usuario decide cuándo)
- **Objetivo:** Costo mensual < $5 si usuario es moderado (< 100 análisis/mes)
- **alternative.me:** completamente gratis, sin registro, sin API key
- **Coinalyze:** gratis con registro — añadir `COINALYZE_API_KEY` al `.env`

### Flujo de Datos (CRÍTICO)
- Timer 60seg → GET /api/data?coin=X (automático, sin IA)
  - Actualiza: OHLC, indicadores, sentimiento
  - Costo: $0
- Botón "🔄" → GET /api/data?coin=X (manual, sin IA)
  - Mismo endpoint, on-demand
  - Reinicia countdown
  - Costo: $0
- Botón "⚡" → POST /api/analyze (manual, con IA)
  - Recibe datos ya calculados
  - Genera recomendación JSON
  - Costo: $0.003

### Seguridad
- API keys **NUNCA** en frontend
- Usar .env (gitignored) solo en backend
- Anthropic key: SOLO backend, NUNCA frontend
- CryptoPanic token: SOLO backend
- Coinalyze API key: SOLO backend
- alternative.me: no requiere key (API pública)
- SSL/TLS obligatorio si infraestructura pública

### Degraded Mode (APIs opcionales)
- Si `COINALYZE_API_KEY` no está configurada → Funding Rate / OI / L/S Ratio se omiten del dashboard y del prompt IA, sin romper nada
- CryptoPanic requiere plan de pago desde 2026 (~$199/mes). Sin suscripción activa la API devuelve `results: []` y el dashboard muestra "—" en score y barra de votos (comportamiento correcto, no un error)
- Si CryptoPanic falla con datos previos → usar último valor cacheado en SQLite con flag `"stale": true`

### Coinalyze — estructura de respuesta real (verificada 2026-04-03)
**Endpoints actuales (valores reales):**
- `GET /v1/funding-rate` → `[{ symbol, value, update }]` — campo `value` (no `last_funding_rate`)
- `GET /v1/open-interest` → `[{ symbol, value, update }]` — campo `value` (no `open_interest`)
- `GET /v1/long-short-ratio-history` → `[{ symbol, history: [{ t, r, l, s }] }]` — campos `l` (long%) y `s` (short%) en porcentaje directo

**Endpoints para históricos (nuevos):**
- `GET /v1/funding-rate-history?interval=6hour&from=T-48h&to=T` → `[{ symbol, history: [{ t, o, h, l, c, trend }] }]` — últimos 48h @ 6h candles
- `GET /v1/open-interest-history?interval=4hour&from=T-86400&to=T` → `[{ symbol, history: [{ t, o, h, l, c }] }]` — últimas ~26h @ 4h candles (cambio 24h real)
- `GET /v1/long-short-ratio-history?interval=1hour&from=T-7d&to=T` → `[{ symbol, history: [{ t, l, s }] }]` — últimos 7 días @ 1h
- `GET /v1/liquidation-history?interval=1hour&from=T-86400&to=T` → `[{ symbol, history: [{ t, l, s }] }]` — últimas 24h @ 1h, `l`=longs liquidados USD, `s`=shorts liquidados USD

**Degraded modes:**
- Si alternative.me falla → omitir Fear & Greed del ciclo actual, sin romper nada
- Si Coinalyze falla → todas las métricas devuelven null, UI muestra "—"
- Históricos se mantienen en memoria con límites automáticos

### Performance
- Backend paraleliza GET /api/data: 3 TF × 1 coin (Promise.all)
- Processing time: ~1.5 seg (3 requests OHLC en paralelo + caches)
- Cache TTL por fuente:
  - OHLC: 60 segundos
  - CryptoPanic: 5 minutos
  - Fear & Greed: 10 minutos (+ históricos 30 días en memoria)
  - Funding Rate: 30 minutos (exchanges actualizan cada 8h) (+ histórico 48h en memoria)
  - Open Interest: 5 minutos (+ histórico 7 días en memoria)
  - L/S Ratio: 5 minutos (+ histórico 7 días en memoria)
  - Liquidaciones: 5 minutos (+ histórico 7 días en memoria)
  - BTC Dominance: 10 minutos
- PixiJS: 1 gráfico principal + 2 indicadores secundarios
- Frontend: Mantiene state entre updates (zoom/pan no se pierden)
- Timer + botón manual ambos sin bloquear UI

### Escalabilidad (Futuro)
- ✅ Agregar más monedas (solo cambiar config)
- ✅ Agregar más timeframes (solo cambiar constantes)
- ✅ WebSocket Binance (mantener estructura services)
- ✅ Machine learning (análisis históricos ya guardados)
- ✅ Multi-usuario (agregar auth JWT)
- ✅ Caché inteligente (análisis previos reutilizar si precio similar)

### Rate Limits (Importante)
- CoinGecko: 50 calls/min gratis (✅ suficiente)
- CryptoPanic: ~6-10 requests/día gratis (✅ cacheable 5min)
- Anthropic: Pay-as-you-go (✅ usuario controla gastos)

### Indicadores con Tooltips
- Cada indicador tendrá descripción/tooltip
- Usuario entiende qué significa RSI=64, etc
- Sentimiento score con breakdown bullish/bearish

---

## 🎯 SIGUIENTE PASO

**Comenzar FASE 1 → FASE 2 (Backend Skeleton)**

Archivo de referencia: Este BLUEPRINT.md

¿Confirmación para empezar código?
