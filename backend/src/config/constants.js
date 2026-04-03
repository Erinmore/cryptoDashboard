export const COINS = ['BTC', 'ETH', 'SOL'];
export const TIMEFRAMES = ['1h', '4h', '1D', '1W'];

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
// Ajuste en bull market confirmado
export const RSI_OVERBOUGHT_BULL = 80;
export const RSI_OVERSOLD_BULL = 40;

// ─── Stochastic RSI ───────────────────────────────────────────
export const STOCH_RSI_RSI_PERIOD = 14;
export const STOCH_RSI_STOCH_PERIOD = 14;
export const STOCH_RSI_SMOOTH_K = 3;
export const STOCH_RSI_SMOOTH_D = 3;
export const STOCH_RSI_OVERBOUGHT = 80;
export const STOCH_RSI_OVERSOLD = 20;

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
export const ADX_STRONG_TREND = 40;
export const ADX_RANGING_THRESHOLD = 20;

// ─── Bollinger Bands ──────────────────────────────────────────
export const BB_PERIOD = 20;
export const BB_STD_DEV = 2;

// ─── SuperTrend ───────────────────────────────────────────────
export const SUPERTREND_ATR_PERIOD = 14;
export const SUPERTREND_MULTIPLIER = 3.0;
export const SUPERTREND_ADAPTIVE_EMA = 50; // EMA del ATR para multiplicador adaptativo

// ─── Volume Delta / CVD / OBV ─────────────────────────────────
export const VOLUME_DELTA_LOOKBACK = 20; // velas para calcular presión agregada

// ─── Support/Resistance ───────────────────────────────────────
export const SR_LOOKBACK = 50;
export const SR_MIN_TOUCHES = 2;
export const SR_TOLERANCE_PCT = 0.005; // 0.5%

// ─── Fibonacci ────────────────────────────────────────────────
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

// ─── Market Regime ────────────────────────────────────────────
export const REGIME_BB_WIDTH_PERCENTILE_HIGH = 70;
export const REGIME_BB_WIDTH_PERCENTILE_LOW = 30;
export const REGIME_ATR_MULTIPLIER = 2; // ATR > 2x SMA(ATR) = HIGH_VOLATILITY

// ─── Fear & Greed ─────────────────────────────────────────────
export const FEAR_GREED_EXTREME_FEAR = 24;
export const FEAR_GREED_FEAR = 49;
export const FEAR_GREED_GREED = 74;
// > 74 = Extreme Greed

// ─── Funding Rate ─────────────────────────────────────────────
export const FUNDING_RATE_HIGH = 0.001;   // 0.1% — sobrecargado de longs
export const FUNDING_RATE_LOW = -0.0005;  // -0.05% — sobrecargado de shorts

// ─── History ──────────────────────────────────────────────────
export const MAX_ANALYSES_STORED = 1000;
