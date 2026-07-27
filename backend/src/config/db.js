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

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function columnExists(db, table, column) {
  // table es siempre una constante interna (sin input de usuario) → seguro interpolar.
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/** Migración aditiva idempotente: añade la columna si aún no existe (no destruye datos). */
function ensureColumn(db, table, column, definition) {
  if (tableExists(db, table) && !columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info({ table, column }, 'Migración: columna añadida');
  }
}

function runMigrations(db) {
  // Schema idempotente: CREATE TABLE IF NOT EXISTS crea las tablas en una BBDD nueva
  // y no toca las existentes. Los análisis persisten entre reinicios (antes se dropeaban
  // las 4 tablas en cada arranque). Los cambios de schema van como migraciones aditivas
  // (ver ensureColumn al final) — nunca se destruyen datos.
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
      missing_confirmations TEXT,
      -- Contradicciones deterministas del backend (utils/gating.js), separadas del
      -- booleano contradictions_found del LLM → permite comparar backend vs LLM.
      contradiction_count INTEGER,
      contradiction_codes TEXT,

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

      -- Validación determinista del output (Fase 1: log + flag) — JSON array o null
      validation_warnings TEXT,

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
      supertrend_level REAL,
      wave_trend_signal TEXT,
      bb_position REAL,
      bb_width_pct REAL,

      -- Volume
      volume_delta_buy_pct REAL,
      cvd_trend TEXT,
      cvd_divergence TEXT,
      -- Fuerza del desequilibrio del CVD. cvd_strength es la etiqueta que consumen el veto,
      -- la contradicción de volumen y (vía prompt) el Volume Flow Score: con "marginal" el
      -- score de volumen se anula y las puertas Comprar/Vender quedan cerradas. Sin este par
      -- no se puede separar a posteriori un "el modelo eligió Esperar" de un "no se le
      -- permitió otra cosa". Se guarda también el ratio crudo para poder recalibrar los
      -- cortes (2 %/8 %) contra la distribución real sin re-fetchear klines.
      cvd_strength TEXT,
      cvd_delta_vs_volume_pct REAL,
      -- Trazabilidad de la calibración: desde v7_0 los cortes salen de la propia serie y por
      -- tanto VARÍAN en cada análisis. Sin guardarlos no se puede explicar a posteriori por qué
      -- un mismo 1,3 % fue "moderate" un día y "marginal" otro — justo lo que hay que auditar.
      cvd_strength_pctile REAL,
      cvd_strength_cuts TEXT,
      vwap_trend TEXT,
      vwap_divergence TEXT,

      -- SMC
      bos_direction TEXT,
      bos_valid INTEGER,
      choch_direction TEXT,
      fvg_bullish_count INTEGER,
      fvg_bearish_count INTEGER,

      -- S/R distances + strength (del nivel más cercano; strength = min(floor(touches/2),5))
      nearest_support_pct REAL,
      nearest_resistance_pct REAL,
      nearest_support_strength INTEGER,
      nearest_resistance_strength INTEGER,

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

      pnl_pct_24h REAL,        -- movimiento crudo del precio (drift, sin dirección)
      pnl_signed_pct_24h REAL  -- PnL de la estrategia (× dir); solo Comprar/Vender
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

    -- ── Table 5: analysis_fvg_snapshot (hasta 5 FVGs × 2 direcciones × 4 TFs) ──
    -- Cierra la última deuda §6. La tabla analysis_tf_snapshot ya guardaba el CONTEO de FVGs
    -- (fvg_bullish_count/fvg_bearish_count) pero no su geometría, así que no se podía
    -- responder a posteriori "¿el precio llegó a rellenar el gap?" — que es justo lo que
    -- valida (o refuta) la tesis de los FVGs como imanes de precio.
    -- distance_pct: distancia con signo del precio al borde más cercano de la zona
    -- (negativo = zona por debajo, positivo = por encima, 0 = precio dentro).
    CREATE TABLE IF NOT EXISTS analysis_fvg_snapshot (
      analysis_id TEXT NOT NULL,
      tf TEXT NOT NULL,              -- '1h' | '4h' | '1D' | '1W'
      fvg_type TEXT NOT NULL,        -- 'bullish' | 'bearish'
      fvg_rank INTEGER NOT NULL,     -- 0 = más reciente
      zone_low REAL,
      zone_high REAL,
      size_pct REAL,
      mitigation_pct REAL,
      candles_ago INTEGER,
      signal_status TEXT,            -- active | context | expired
      formed_t INTEGER,              -- timestamp de la 3ª vela del patrón (t_right)
      distance_pct REAL,

      PRIMARY KEY (analysis_id, tf, fvg_type, fvg_rank)
    );

    CREATE INDEX IF NOT EXISTS idx_fvg_snapshot_analysis
      ON analysis_fvg_snapshot(analysis_id);

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

  // ── Migraciones aditivas idempotentes ──────────────────────────────────────
  // Para BBDD creadas antes de que existiera una columna: CREATE TABLE IF NOT EXISTS
  // no la añade a una tabla ya existente, así que la incorporamos con ALTER TABLE.
  // Las BBDD nuevas ya la traen del CREATE de arriba (el ensureColumn es no-op).
  ensureColumn(db, 'analyses', 'validation_warnings', 'TEXT');
  // missing_confirmations: array JSON de confirmaciones ausentes (por qué no se opera).
  ensureColumn(db, 'analyses', 'missing_confirmations', 'TEXT');
  // Contradicciones deterministas del backend (conteo + códigos JSON) — telemetría
  // vs el contradictions_found booleano que reporta el LLM.
  ensureColumn(db, 'analyses', 'contradiction_count', 'INTEGER');
  ensureColumn(db, 'analyses', 'contradiction_codes', 'TEXT');
  // Telemetría del dedupe (revisión 2026-07-26, M1). `contradiction_codes` guarda la lista
  // POST-dedupe: cuando un veto se activa, los códigos que lo construyeron desaparecen de ahí
  // y se perdía el rastro justo en el caso raro que interesa observar. `deduped_by_veto` los
  // conserva, y `contradictions_signal_count` da el conteo crudo (sin dedupe de ningún tipo)
  // que hace medible cuánto descuenta el dedupe por bloque.
  ensureColumn(db, 'analyses', 'deduped_by_veto', 'TEXT');
  ensureColumn(db, 'analyses', 'contradictions_signal_count', 'INTEGER');
  // S/R strength del nivel más cercano (antes solo se persistía la distancia %).
  ensureColumn(db, 'analysis_tf_snapshot', 'nearest_support_strength', 'INTEGER');
  ensureColumn(db, 'analysis_tf_snapshot', 'nearest_resistance_strength', 'INTEGER');
  // SuperTrend: nivel numérico (banda de soporte/resistencia), antes solo la dirección.
  ensureColumn(db, 'analysis_tf_snapshot', 'supertrend_level', 'REAL');
  // CVD: fuerza + ratio crudo. Se persistían `trend` y `divergence` pero NO la fuerza, que es
  // justo la variable que abre o cierra la puerta de Comprar/Vender (revisión 2026-07-26, C3).
  ensureColumn(db, 'analysis_tf_snapshot', 'cvd_strength', 'TEXT');
  ensureColumn(db, 'analysis_tf_snapshot', 'cvd_delta_vs_volume_pct', 'REAL');
  ensureColumn(db, 'analysis_tf_snapshot', 'cvd_strength_pctile', 'REAL');
  ensureColumn(db, 'analysis_tf_snapshot', 'cvd_strength_cuts', 'TEXT');
  // Auditoría B2/C2: total reproducible del backend + scores esperados (guardia de
  // divergencia) — telemetría LLM vs backend, no reemplazan los scores del LLM.
  ensureColumn(db, 'analyses', 'score_total_backend', 'REAL');
  ensureColumn(db, 'analyses', 'score_derivatives_expected', 'INTEGER');
  ensureColumn(db, 'analyses', 'score_volume_expected', 'INTEGER');
  // Auditoría #2, hallazgo 3: PnL firmado por dirección (pnl_pct_24h era el movimiento
  // crudo del precio — un Vender ganador aportaba negativo al promedio). Filas viejas →
  // NULL; el job las rellena al reprocesar (mientras price_7d_later siga pendiente).
  ensureColumn(db, 'analysis_outcome', 'pnl_signed_pct_24h', 'REAL');
  // Auditoría #2, hallazgo 4: el OI de Coinalyze viene en monedas base, no USD. La
  // medida canónica se persiste en oi_value_coins; oi_value_usd pasa a guardar el USD
  // real DERIVADO (coins × spot). Filas viejas: oi_value_usd contiene monedas
  // mal etiquetadas (pre-fix) — distinguibles por oi_value_coins NULL.
  ensureColumn(db, 'analyses', 'oi_value_coins', 'REAL');
  // ── Fase 5 · métricas de RECORRIDO del precio (backtest falsable) ───────────
  // `classifyOutcome` compara precio-del-análisis contra precio-al-horizonte, así que
  // solo clasifica direccionales: con `Esperar` como salida dominante el win-rate tiene
  // denominador estructuralmente 0. Estas columnas miden lo que sí se puede medir para
  // un `Esperar` — si el mercado ofreció un movimiento operable, cuánto y cuándo.
  // Se persisten HECHOS del recorrido, no una interpretación: la definición de "coste de
  // oportunidad" vive en stats.js y se puede cambiar sin volver a pedir datos a Binance.
  // Filas viejas → NULL; el job las rellena retroactivamente al reprocesar.
  ensureColumn(db, 'analysis_outcome', 'atr_pct_at_analysis', 'REAL');
  ensureColumn(db, 'analysis_outcome', 'max_up_pct_24h', 'REAL');
  ensureColumn(db, 'analysis_outcome', 'max_down_pct_24h', 'REAL');
  ensureColumn(db, 'analysis_outcome', 'max_up_pct_7d', 'REAL');
  ensureColumn(db, 'analysis_outcome', 'max_down_pct_7d', 'REAL');
  ensureColumn(db, 'analysis_outcome', 't_max_up_h', 'REAL');
  ensureColumn(db, 'analysis_outcome', 't_max_down_h', 'REAL');
  // Horas hasta el primer cruce de cada múltiplo de ATR, al alza y a la baja (JSON).
  // Ventana ÚNICA de 7d: el horizonte de 24h se obtiene filtrando por hora en lectura,
  // no duplicando columnas. Los máximos sí necesitan su versión de 24h — un máximo a 7d
  // no acota el de 24h.
  ensureColumn(db, 'analysis_outcome', 'path_first_passage', 'TEXT');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
