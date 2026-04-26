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

  // APIs de datos de mercado
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',

  // APIs de derivados (opcional — degraded mode si no está configurado)
  coinalyzeApiKey: process.env.COINALYZE_API_KEY || '',
  get hasDerivativesData() { return Boolean(this.coinalyzeApiKey); },

  // On-chain data (bitcoin-data.com / BGeometrics) — flag para apagar si la fuente cae
  onchainEnabled: (process.env.ONCHAIN_DATA_ENABLED ?? 'true').toLowerCase() !== 'false',

  // Base de datos
  dbPath: process.env.DB_PATH || './data/cryptex.db',

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
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

export default env;
