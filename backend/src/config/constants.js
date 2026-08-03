// ─── PODA DE CONSTANTES HUÉRFANAS (2026-08-03) ────────────────────────────────
//
// Se retiraron 13 constantes que NO importaba nadie y que además CONTRADECÍAN las reglas
// vivas. No eran sólo código muerto: eran una trampa. Todas pertenecían a la familia de
// números redondos escritos a ojo que la auditoría de umbrales (T1-T6) sustituyó por
// terciles y percentiles de la propia serie — quien abriera este fichero leería que el ADX
// fuerte está en 40 o que el F&G codicioso empieza en 74, cortes retirados precisamente por
// estar mal calibrados. Mismo defecto que `liquidations` junto a `liquidations_1h`.
//
// Retiradas: RSI_OVERBOUGHT_BULL · RSI_OVERSOLD_BULL · STOCH_RSI_OVERBOUGHT ·
// STOCH_RSI_OVERSOLD · ADX_STRONG_TREND · VOLUME_DELTA_LOOKBACK ·
// REGIME_BB_WIDTH_PERCENTILE_HIGH/LOW · FEAR_GREED_EXTREME_FEAR/FEAR/GREED ·
// FUNDING_RATE_HIGH/LOW.
//
// Verificado con control positivo antes de borrar (constantes vivas del mismo fichero
// devolviendo usos > 0), porque la primera pasada del chequeo buscaba en rutas inexistentes
// y daba "0 usos" para TODO — incluidas las vivas. Un escaneo de código muerto sin control
// positivo no distingue "no se usa" de "no he mirado".
//
// La severidad de F&G y del funding NO desaparece del sistema: vive donde se calcula
// (`fearGreedService`, `coinalyzeService.severity/severity_negative`), con un solo dueño.

export const COINS = ['BTC', 'ETH', 'SOL'];
export const TIMEFRAMES = ['1h', '4h', '1D', '1W'];

// Duración de una vela por TF, en minutos — usado para convertir ventanas
// expresadas en nº de velas (p. ej. divergence_window_candles) a unidades de
// tiempo comparables entre TFs.
export const TIMEFRAME_MINUTES = {
  '1h': 60,
  '4h': 240,
  '1D': 1440,
  '1W': 10080,
};

// ─── DUEÑO ÚNICO de "cuánto dura una vela" (B3, 2026-08-03) ────────────────────
//
// Había SEIS copias de esta tabla repartidas por el código: `TIMEFRAME_MINUTES` aquí,
// `TF_DURATION_MS` en utils/outcome.js, `TF_MS` en utils/episodes.js, `TF_HOURS` en
// utils/derivativesScore.js, `TF_HOURS_STATS` en utils/stats.js y otra `TF_MS` en
// utils/conditionalPlan.js. Medidas el 2026-08-03: las seis coincidían, o sea que NO había
// bug — había superficie de bug. Seis sitios donde escribir 1W y equivocarse.
//
// Síntoma revelador: `TF_DURATION_MS` estaba EXPORTADA y no la importaba nadie. Alguien la
// hizo pública para que fuera el dueño y los demás siguieron escribiendo la suya.
//
// Se DERIVAN de `TIMEFRAME_MINUTES` en vez de escribirse aparte: un solo juego de números,
// así que no pueden discrepar ni aunque alguien edite solo una.
export const TF_DURATION_MS = Object.fromEntries(
  Object.entries(TIMEFRAME_MINUTES).map(([tf, min]) => [tf, min * 60_000]),
);
export const TF_DURATION_HOURS = Object.fromEntries(
  Object.entries(TIMEFRAME_MINUTES).map(([tf, min]) => [tf, min / 60]),
);

export const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
};

// Symbols para Coinalyze (perpetuos agregados multi-exchange)
export const COINALYZE_SYMBOLS = {
  BTC: 'BTCUSDT_PERP.A',
  ETH: 'ETHUSDT_PERP.A',
  SOL: 'SOLUSDT_PERP.A',
};

// ─── RSI ──────────────────────────────────────────────────────
export const RSI_PERIOD = 14;
export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

// ─── Stochastic RSI ───────────────────────────────────────────
export const STOCH_RSI_RSI_PERIOD = 14;
export const STOCH_RSI_STOCH_PERIOD = 14;
export const STOCH_RSI_SMOOTH_K = 3;
export const STOCH_RSI_SMOOTH_D = 3;
// ⚠️ Los cortes 80/20 del `signal` de StochRSI viven HARDCODEADOS en `calculateStochRSI`
// (indicators.js). Aquí existían como constantes que nadie importaba: dos dueños, uno muerto.
// Se retiró el muerto; mover el vivo a este fichero es ruta de decisión y va con su medición.

// ─── MACD ─────────────────────────────────────────────────────
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;

// ─── WaveTrend ────────────────────────────────────────────────
export const WT_N1 = 10;
export const WT_N2 = 21;
export const WT_OVERBOUGHT = 60;
export const WT_OVERSOLD = -60;

// ─── ADX + DMI ────────────────────────────────────────────────
export const ADX_PERIOD = 14;
export const ADX_TRENDING_THRESHOLD = 25;
export const ADX_RANGING_THRESHOLD = 20;

// ─── Bollinger Bands ──────────────────────────────────────────
export const BB_PERIOD = 20;
export const BB_STD_DEV = 2;

// ─── SuperTrend ───────────────────────────────────────────────
export const SUPERTREND_ATR_PERIOD = 14;
export const SUPERTREND_MULTIPLIER = 3.0;
export const SUPERTREND_ADAPTIVE_EMA = 50; // EMA del ATR para multiplicador adaptativo

// ─── Support/Resistance ───────────────────────────────────────
// Ventana de S/R. Subida de 50 a 100 en la auditoría de umbrales (T4): al pasar el generador
// de "todos los extremos" a "solo pivotes fractales", los candidatos caen de ~100 a ~13 por
// ventana y con lookback 50 quedaban solo ~2,7 niveles con historial — insuficiente para los
// 3 soportes + 3 resistencias que devuelve la función. Con 100 vuelven a ~17 niveles/ventana,
// comparable a antes pero con toques que significan rechazos reales.
// `slice(-lookback)` degrada solo si el TF tiene menos velas (1D=90, 1W=52): usa las que haya.
export const SR_LOOKBACK = 100;
// Bajado de 2 a 1 junto con el cambio a pivotes (T4). Con el generador viejo —que metía los
// extremos de todas las velas— exigir 2 toques era un filtro anti-ruido imprescindible. Con
// pivotes fractales, UN toque ya es un rechazo local real y merece figurar como nivel; medido,
// exigir 2 dejaba el 1W en 0,4 niveles por ventana (el bloque S/R semanal se quedaba vacío).
// La calidad la lleva ahora `touches`/`strength`, no la pertenencia a la lista: con minTouches=1
// el filtro de "nivel fuerte" del veto (>=3) selecciona el 18,8 % en 4h, frente al 89,1 % de antes.
export const SR_MIN_TOUCHES = 1;
export const SR_TOLERANCE_PCT = 0.005; // 0.5%

// ─── Fibonacci ────────────────────────────────────────────────
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

// ─── Volume Profile ───────────────────────────────────────────
// Umbral de validez del POC (poc_distance_pct) calibrado por TF: el rango de
// precio cubierto por el Volume Profile crece con la TF (1h ≈ 7 días, 1W ≈ 1
// año), así que un único 5% fijo invalidaba casi siempre las TFs altas.
export const VOLUME_PROFILE_VALID_THRESHOLD_PCT = {
  '1h': 5,
  '4h': 8,
  '1D': 12,
  '1W': 20,
};

// ─── Market Regime ────────────────────────────────────────────
// REGIME_ATR_MULTIPLIER (=2) retirado el 2026-08-03: era la 14ª huérfana y se coló en la
// primera poda porque el escaneo contaba menciones en COMENTARIOS como usos. T1 lo sustituyó
// por el percentil del ATR% (`high_volatility` salía al 0,0 % en las 12 combinaciones: el ATR
// de Wilder está autocorrelacionado con su propia SMA y el cociente no despega de 1). El
// comentario que lo explica sigue en `detectMarketRegime` — es lo que impide reintroducirlo.

// ─── History ──────────────────────────────────────────────────
export const MAX_ANALYSES_STORED = 1000;

// ─── Modelos de análisis IA (seleccionables desde el frontend) ──
// Whitelist: POST /api/analyze sólo acepta uno de estos ids; si viene otro o
// ninguno, se usa DEFAULT_ANALYSIS_MODEL. `cost` es orientativo (~25k in / ~3k out).
// `disableThinking`: sólo Sonnet 5 lo necesita — omitir `thinking` en Sonnet 5
// activa adaptive thinking (gasta tokens y puede truncar el JSON). Opus/Haiku van
// sin `thinking` (off por defecto al omitirlo).
export const ANALYSIS_MODELS = [
  { id: 'claude-opus-4-8',  label: 'Opus 4.8',  cost: '~$0.20', disableThinking: false },
  { id: 'claude-sonnet-5',  label: 'Sonnet 5',  cost: '~$0.09', disableThinking: true  },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', cost: '~$0.04', disableThinking: false },
];
export const DEFAULT_ANALYSIS_MODEL = 'claude-opus-4-8';

// ─── Motivo de la muestra (2026-08-03) ─────────────────────────────────────────
//
// POR QUÉ. Con tres monedas conviven dos regímenes de muestreo: el FIJO (cron, 2/día por
// moneda, homogéneo) y el OPORTUNISTA (dirigido por evento, sesgado hacia el estado que lo
// dispara). Mezclarlos en un mismo denominador infla la distribución hacia justo el caso que
// el disparador selecciona. Hasta hoy el motivo iba al LOG y no a la fila, así que no se podían
// separar a posteriori — se dependía de una convención horaria, que funciona pero se rompe con
// un lanzamiento manual a deshora.
//
// El valor puede llevar detalle tras dos puntos (`opportunistic:veto_long+oi_expandiendo`); lo
// que se valida es el PREFIJO. Ausente ⇒ `unknown`, nunca un valor por defecto inventado: un
// dato que no llegó no es un dato que se supone.
// `adhoc` es para lo INFERIDO a posteriori: "fuera de la ventana planificada, origen exacto no
// registrado". La heurística horaria no puede separar un oportunista de un lanzamiento manual,
// y etiquetarlo `opportunistic` afirmaría más de lo que se sabe.
export const SAMPLE_REASONS = ['fixed', 'opportunistic', 'ui', 'manual', 'adhoc', 'unknown'];

// ─── Versionado por fila (A3, 2026-08-03) ──────────────────────────────────────
//
// POR QUÉ. `prompt_version` ya se persistía, pero el prompt es sólo UNA de las cosas que
// deciden la salida: las puertas, la rúbrica de derivados y las features (ventanas, cortes,
// normalizadores) cambian por separado y hasta hoy sólo dejaban rastro en el historial de
// git. Comparar dos periodos exigía arqueología de commits — con esto es una consulta SQL.
//
// LO QUE HABILITA, y por eso va ANTES del rediseño y no después:
//   · Atribuir un cambio de comportamiento al componente que lo causó, en vez de al lote.
//   · Retirar valores de enum (`Preparar`) sin romper las filas viejas: se versiona, no se
//     borra. Una fila declara con qué reglas se produjo, así que sigue siendo interpretable.
//   · Separar, en el mismo punto cero, los cambios de OUTPUT de los cambios de UMBRAL —
//     que es la disciplina sin la cual el periodo siguiente no puede atribuir nada.
//
// REGLA DE MANTENIMIENTO: se sube la versión del componente que cambia, no todas a la vez.
// Un lote que toque los tres sube los tres; uno que sólo mueva un corte sube `FEATURE`.
export const GATE_VERSION    = 'g2_no_prepare_gate';   // puertas direccionales + fail-safe
export const RUBRIC_VERSION  = 'r1_oi_price_2026_07_29'; // rúbrica de derivados (measured_at)
export const FEATURE_VERSION = 'f1_atr180_band050';    // ventanas/cortes/normalizadores
