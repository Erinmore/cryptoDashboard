import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import env from './env.js';
import logger from '../middleware/logger.js';

let db;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb() {
  mkdirSync(dirname(env.dbPath), { recursive: true });

  db = new Database(env.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info({ path: env.dbPath }, 'SQLite connected');
  return db;
}

function runMigrations(db) {
  // Drop old schema (incompatible with new 4-table design)
  db.exec(`
    DROP TABLE IF EXISTS analyses;
    DROP TABLE IF EXISTS analysis_tf_snapshot;
    DROP TABLE IF EXISTS analysis_outcome;
    DROP TABLE IF EXISTS analysis_liquidation_snapshot;
  `);

  db.exec(`
    -- ── Table 1: analyses (one row per analysis) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      coin TEXT NOT NULL,
      primary_tf TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      prompt_version TEXT,

      -- Price & market
      price_current REAL,
      price_change_24h_pct REAL,
      btc_dominance_pct REAL,
      market_cap_change_24h_pct REAL,

      -- Sentiment
      fear_greed_value INTEGER,
      fear_greed_class TEXT,
      fear_greed_trend_30d TEXT,
      fear_greed_30d_avg REAL,

      -- Macro
      macro_regime TEXT,
      dxy_value REAL,
      dxy_trend_5d TEXT,
      spx_trend_5d TEXT,
      gold_trend_5d TEXT,

      -- Implied volatility
      btc_dvol_value REAL,
      btc_dvol_regime TEXT,
      eth_dvol_value REAL,

      -- On-chain
      mvrv REAL,
      mvrv_zscore REAL,
      mvrv_signal TEXT,
      nupl REAL,
      nupl_signal TEXT,
      sopr REAL,
      sopr_signal TEXT,

      -- Derivatives
      funding_rate_pct REAL,
      funding_severity TEXT,
      funding_severity_negative TEXT,
      funding_trend TEXT,
      predicted_rate_pct REAL,
      oi_value_usd REAL,
      oi_change_24h_pct REAL,
      oi_trend_7d TEXT,
      long_pct REAL,
      short_pct REAL,
      liq_longs_24h_usd REAL,
      liq_shorts_24h_usd REAL,

      -- ETF flows
      etf_trend_7d TEXT,
      etf_net_inflow_7d_usd REAL,
      etf_data_freshness TEXT,

      -- Order book
      ob_imbalance_ratio REAL,
      ob_imbalance_top5_ratio REAL,
      ob_imbalance_signal TEXT,

      -- Timeframe conflict
      tf_conflict TEXT,

      -- LLM decision
      action TEXT,
      confidence TEXT,
      risk_score INTEGER,
      conviction REAL,
      primary_driver TEXT,
      has_executable_setup INTEGER,
      gating_active INTEGER,
      gating_reason TEXT,
      contradictions_found INTEGER,

      -- LLM internal scores
      score_derivatives INTEGER,
      score_structure INTEGER,
      score_volume INTEGER,
      score_onchain INTEGER,
      score_total REAL,

      -- Tactical setup (nullable)
      setup_entry_price REAL,
      setup_stop_price REAL,
      setup_tp1_price REAL,
      setup_tp2_price REAL,
      setup_validity_candles INTEGER,
      setup_tf_execution TEXT,

      -- LLM text
      executive_summary TEXT,
      ai_response_full TEXT,

      -- Technical metadata
      processing_time_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      model_used TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_analyses_coin_ts
      ON analyses(coin, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_analyses_action
      ON analyses(action);

    CREATE INDEX IF NOT EXISTS idx_analyses_coin_action
      ON analyses(coin, action);

    -- ── Table 2: analysis_tf_snapshot (4 rows per analysis, one per TF) ───────
    CREATE TABLE IF NOT EXISTS analysis_tf_snapshot (
      analysis_id TEXT NOT NULL,
      tf TEXT NOT NULL,

      -- Structure
      trend TEXT,
      momentum_alignment INTEGER,
      regime TEXT,

      -- Key indicators
      rsi_value REAL,
      rsi_signal TEXT,
      rsi_divergence TEXT,
      stochrsi_k REAL,
      stochrsi_d REAL,
      stochrsi_signal TEXT,
      macd_histogram REAL,
      macd_momentum_state TEXT,
      adx_value REAL,
      adx_trend_direction TEXT,
      adx_regime TEXT,
      supertrend_direction TEXT,
      wave_trend_signal TEXT,
      bb_position REAL,
      bb_width_pct REAL,

      -- Volume
      volume_delta_buy_pct REAL,
      cvd_trend TEXT,
      cvd_divergence TEXT,
      vwap_trend TEXT,
      vwap_divergence TEXT,

      -- SMC
      bos_direction TEXT,
      bos_valid INTEGER,
      choch_direction TEXT,
      fvg_bullish_count INTEGER,
      fvg_bearish_count INTEGER,

      -- S/R distances
      nearest_support_pct REAL,
      nearest_resistance_pct REAL,

      -- Volume Profile
      vp_poc_distance_pct REAL,
      vp_valid INTEGER,

      PRIMARY KEY (analysis_id, tf)
    );

    CREATE INDEX IF NOT EXISTS idx_tf_snapshot_analysis
      ON analysis_tf_snapshot(analysis_id);

    -- ── Table 3: analysis_outcome (filled later by a separate job) ────────────
    CREATE TABLE IF NOT EXISTS analysis_outcome (
      analysis_id TEXT PRIMARY KEY,

      price_at_analysis REAL,
      price_1h_later REAL,
      price_4h_later REAL,
      price_24h_later REAL,
      price_7d_later REAL,

      outcome_1h TEXT,
      outcome_24h TEXT,
      outcome_7d TEXT,

      setup_hit_tp1 INTEGER,
      setup_hit_tp2 INTEGER,
      setup_hit_stop INTEGER,
      setup_outcome TEXT,

      pnl_pct_24h REAL
    );

    -- ── Table 4: analysis_liquidation_snapshot (up to 10 rows per analysis) ───
    CREATE TABLE IF NOT EXISTS analysis_liquidation_snapshot (
      analysis_id TEXT NOT NULL,
      cluster_type TEXT NOT NULL,
      cluster_rank INTEGER NOT NULL,
      price REAL,
      total_usd REAL,
      distance_pct REAL,

      PRIMARY KEY (analysis_id, cluster_type, cluster_rank)
    );

    CREATE INDEX IF NOT EXISTS idx_liq_snapshot_analysis
      ON analysis_liquidation_snapshot(analysis_id);

    -- ── candles_cache (reserved, not used yet) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS candles_cache (
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

    CREATE INDEX IF NOT EXISTS idx_coin_tf_timestamp
      ON candles_cache(coin, timeframe, timestamp DESC);

    -- ── history_series (persisted time-series for LLM context + backtesting) ──
    -- No se dropea nunca: acumula históricos entre reinicios. CVD/VWAP viven aquí
    -- porque no tienen fuente externa de histórico; el resto de métricas se persisten
    -- para acumular más allá de la ventana que sus APIs re-fetchean en cada poll.
    CREATE TABLE IF NOT EXISTS history_series (
      coin TEXT NOT NULL,        -- 'BTC'/'ETH'/'SOL' o 'GLOBAL' (fear_greed)
      metric TEXT NOT NULL,      -- funding_rate|open_interest|long_short_ratio|liquidations|cvd|vwap|fear_greed
      ts_key INTEGER NOT NULL,   -- epoch seg; métricas por fecha usan medianoche UTC
      payload TEXT NOT NULL,     -- JSON del entry original
      PRIMARY KEY (coin, metric, ts_key)
    );

    CREATE INDEX IF NOT EXISTS idx_history_series_lookup
      ON history_series(coin, metric, ts_key DESC);
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
