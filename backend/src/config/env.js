import 'dotenv/config';

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // APIs de IA
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // APIs de datos de mercado
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',
  cryptopanicToken: process.env.CRYPTOPANIC_TOKEN || '',

  // APIs de derivados (opcional — degraded mode si no está configurado)
  coinalyzeApiKey: process.env.COINALYZE_API_KEY || '',
  get hasDerivativesData() { return Boolean(this.coinalyzeApiKey); },

  // Base de datos
  dbPath: process.env.DB_PATH || './data/cryptex.db',

  // Cache TTL (segundos)
  cache: {
    ohlcTtl:          parseInt(process.env.CACHE_OHLC_TTL, 10)          || 60,
    sentimentTtl:     parseInt(process.env.CACHE_SENTIMENT_TTL, 10)     || 300,
    fearGreedTtl:     parseInt(process.env.CACHE_FEAR_GREED_TTL, 10)    || 600,
    fundingRateTtl:   parseInt(process.env.CACHE_FUNDING_RATE_TTL, 10)  || 1800,
    openInterestTtl:  parseInt(process.env.CACHE_OPEN_INTEREST_TTL, 10) || 300,
    longShortTtl:     parseInt(process.env.CACHE_LONG_SHORT_TTL, 10)    || 300,
    liquidationsTtl:  parseInt(process.env.CACHE_LIQUIDATIONS_TTL, 10)  || 300,
    btcDominanceTtl:  parseInt(process.env.CACHE_BTC_DOMINANCE_TTL, 10) || 600,
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

export default env;
