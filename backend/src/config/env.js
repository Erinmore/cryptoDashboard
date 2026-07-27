import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (parent of backend/)
const envPath = join(__dirname, '../../../.env');
config({ path: envPath });

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // APIs de IA
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // Temperatura del análisis LLM. Los modelos de ANALYSIS_MODELS (Opus 4.8, Sonnet 5,
  // Haiku 4.5 — generación Claude 5) DEPRECAN el parámetro `temperature`: la Messages
  // API responde 400 `temperature is deprecated for this model` si se envía. Por eso el
  // default es `null` → NO se manda temperature (el modelo usa su comportamiento fijo).
  // Solo se envía si ANALYSIS_TEMPERATURE se define explícitamente (escape hatch para un
  // modelo futuro que sí lo acepte); buildLlmRequest omite el campo cuando es null.
  analysisTemperature: (() => {
    const t = parseFloat(process.env.ANALYSIS_TEMPERATURE);
    return Number.isFinite(t) && t >= 0 && t <= 1 ? t : null;
  })(),

  // APIs de datos de mercado
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',

  // APIs de derivados (opcional — degraded mode si no está configurado)
  coinalyzeApiKey: process.env.COINALYZE_API_KEY || '',
  get hasDerivativesData() { return Boolean(this.coinalyzeApiKey); },

  // On-chain data (bitcoin-data.com / BGeometrics) — flag para apagar si la fuente cae
  onchainEnabled: (process.env.ONCHAIN_DATA_ENABLED ?? 'true').toLowerCase() !== 'false',

  // Fail-safe del validador determinista (§6.4 Fase 2): ante violación SEVERA de las
  // reglas duras del prompt, degrada la acción a "Esperar". Activo por defecto; se puede
  // apagar (ANALYSIS_FAILSAFE_ENABLED=false) para observar el output crudo del LLM.
  analysisFailsafeEnabled: (process.env.ANALYSIS_FAILSAFE_ENABLED ?? 'true').toLowerCase() !== 'false',

  // Fail-closed del gating (auditoría H2): si faltan los inputs críticos del veto
  // (CVD 1D u Open Interest), bloquear trades direccionales (degradar a Esperar) en vez
  // de dejarlos pasar a ciegas. Es un hard gate del backend, independiente del fail-safe.
  gatingFailClosedOnMissing: (process.env.GATING_FAIL_CLOSED_ON_MISSING ?? 'true').toLowerCase() !== 'false',

  // Poller de fondo de históricos: persiste history_series de TODAS las monedas
  // (no solo la visualizada en el frontend), clave para CVD/VWAP —sin backfill externo—
  // y para cobertura continua de backtesting. Activo por defecto.
  historyPollerEnabled: (process.env.HISTORY_POLLER_ENABLED ?? 'true').toLowerCase() !== 'false',
  historyPollerIntervalSec: parseInt(process.env.HISTORY_POLLER_INTERVAL_SEC, 10) || 300,

  // Job de backtesting (analysis_outcome): rellena precios/outcomes a 1h/4h/24h/7d
  // post-análisis. Activo por defecto; corre cada OUTCOME_JOB_INTERVAL_SEC (15 min).
  outcomeJobEnabled: (process.env.OUTCOME_JOB_ENABLED ?? 'true').toLowerCase() !== 'false',
  outcomeJobIntervalSec: parseInt(process.env.OUTCOME_JOB_INTERVAL_SEC, 10) || 900,

  // Base de datos
  dbPath: process.env.DB_PATH || './data/cryptex.db',
  // Estado de la recogida que escribe scripts/checkCollection.sh y sirve /health. Sin valor
  // se deduce de $HOME; se puede fijar si el layout de la Pi cambia.
  collectionHealthFile: process.env.COLLECTION_HEALTH_FILE || null,

  // Cache TTL (segundos)
  cache: {
    ohlcTtl:          parseInt(process.env.CACHE_OHLC_TTL, 10)          || 60,
    fearGreedTtl:     parseInt(process.env.CACHE_FEAR_GREED_TTL, 10)    || 600,
    fundingRateTtl:   parseInt(process.env.CACHE_FUNDING_RATE_TTL, 10)  || 1800,
    openInterestTtl:  parseInt(process.env.CACHE_OPEN_INTEREST_TTL, 10) || 300,
    longShortTtl:     parseInt(process.env.CACHE_LONG_SHORT_TTL, 10)    || 300,
    liquidationsTtl:  parseInt(process.env.CACHE_LIQUIDATIONS_TTL, 10)  || 300,
    btcDominanceTtl:  parseInt(process.env.CACHE_BTC_DOMINANCE_TTL, 10) || 600,
    liquidationClustersTtl: parseInt(process.env.CACHE_LIQUIDATION_CLUSTERS_TTL, 10) || 600,
    // 12h: bitcoin-data.com publica MVRV/NUPL/SOPR una vez al día (cierre UTC).
    // Refrescar más a menudo gasta cuota free (15 req/día) sin nuevos datos.
    onchainTtl:       parseInt(process.env.CACHE_ONCHAIN_TTL, 10)        || 43200,
    // Cache negativo cuando el fetch entero falla (evita martillear ante 429/outage)
    onchainNegativeTtl: parseInt(process.env.CACHE_ONCHAIN_NEGATIVE_TTL, 10) || 1800,
    // SoSoValue ETF flows: publican una vez al día tras cierre US market
    etfFlowsTtl:         parseInt(process.env.CACHE_ETF_FLOWS_TTL, 10)          || 3600,
    etfFlowsNegativeTtl: parseInt(process.env.CACHE_ETF_FLOWS_NEGATIVE_TTL, 10) || 1800,
    // Macro (Yahoo Finance): cierre diario, intradía cambia poco entre llamadas
    macroTtl:         parseInt(process.env.CACHE_MACRO_TTL, 10)          || 1800,
    macroNegativeTtl: parseInt(process.env.CACHE_MACRO_NEGATIVE_TTL, 10) || 600,
    // Deribit DVOL: actualizado en tiempo real, cache corto para no martillear
    deribitDvolTtl:   parseInt(process.env.CACHE_DERIBIT_DVOL_TTL, 10)   || 300,
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

export default env;
