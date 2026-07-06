import { getDb } from '../config/db.js';
import { MAX_ANALYSES_STORED } from '../config/constants.js';

// ─── Save analysis (4-table transaction) ──────────────────────────────────────

/**
 * Persists a complete analysis in 4 tables atomically.
 *
 * @param {object} data
 *   data.header     — fields for `analyses`
 *   data.tfSnapshots — array of up to 4 objects for `analysis_tf_snapshot`
 *   data.clusters   — array of up to 10 objects for `analysis_liquidation_snapshot`
 */
export function saveAnalysis(data) {
  const db = getDb();
  const { header, tfSnapshots = [], clusters = [] } = data;

  const insertHeader = db.prepare(`
    INSERT INTO analyses (
      id, coin, primary_tf, timestamp, prompt_version,
      price_current, price_change_24h_pct, btc_dominance_pct, market_cap_change_24h_pct,
      fear_greed_value, fear_greed_class, fear_greed_trend_30d, fear_greed_30d_avg,
      macro_regime, dxy_value, dxy_trend_5d, spx_trend_5d, gold_trend_5d,
      btc_dvol_value, btc_dvol_regime, eth_dvol_value,
      mvrv, mvrv_zscore, mvrv_signal, nupl, nupl_signal, sopr, sopr_signal,
      funding_rate_pct, funding_severity, funding_severity_negative, funding_trend,
      predicted_rate_pct, oi_value_usd, oi_change_24h_pct, oi_trend_7d,
      long_pct, short_pct, liq_longs_24h_usd, liq_shorts_24h_usd,
      etf_trend_7d, etf_net_inflow_7d_usd, etf_data_freshness,
      ob_imbalance_ratio, ob_imbalance_top5_ratio, ob_imbalance_signal,
      tf_conflict,
      action, confidence, risk_score, conviction, primary_driver,
      has_executable_setup, gating_active, gating_reason, contradictions_found, missing_confirmations,
      contradiction_count, contradiction_codes,
      score_derivatives, score_structure, score_volume, score_onchain, score_total,
      setup_entry_price, setup_stop_price, setup_tp1_price, setup_tp2_price,
      setup_validity_candles, setup_tf_execution,
      executive_summary, ai_response_full, validation_warnings,
      processing_time_ms, input_tokens, output_tokens, model_used
    ) VALUES (
      @id, @coin, @primary_tf, @timestamp, @prompt_version,
      @price_current, @price_change_24h_pct, @btc_dominance_pct, @market_cap_change_24h_pct,
      @fear_greed_value, @fear_greed_class, @fear_greed_trend_30d, @fear_greed_30d_avg,
      @macro_regime, @dxy_value, @dxy_trend_5d, @spx_trend_5d, @gold_trend_5d,
      @btc_dvol_value, @btc_dvol_regime, @eth_dvol_value,
      @mvrv, @mvrv_zscore, @mvrv_signal, @nupl, @nupl_signal, @sopr, @sopr_signal,
      @funding_rate_pct, @funding_severity, @funding_severity_negative, @funding_trend,
      @predicted_rate_pct, @oi_value_usd, @oi_change_24h_pct, @oi_trend_7d,
      @long_pct, @short_pct, @liq_longs_24h_usd, @liq_shorts_24h_usd,
      @etf_trend_7d, @etf_net_inflow_7d_usd, @etf_data_freshness,
      @ob_imbalance_ratio, @ob_imbalance_top5_ratio, @ob_imbalance_signal,
      @tf_conflict,
      @action, @confidence, @risk_score, @conviction, @primary_driver,
      @has_executable_setup, @gating_active, @gating_reason, @contradictions_found, @missing_confirmations,
      @contradiction_count, @contradiction_codes,
      @score_derivatives, @score_structure, @score_volume, @score_onchain, @score_total,
      @setup_entry_price, @setup_stop_price, @setup_tp1_price, @setup_tp2_price,
      @setup_validity_candles, @setup_tf_execution,
      @executive_summary, @ai_response_full, @validation_warnings,
      @processing_time_ms, @input_tokens, @output_tokens, @model_used
    )
  `);

  const insertSnapshot = db.prepare(`
    INSERT INTO analysis_tf_snapshot (
      analysis_id, tf,
      trend, momentum_alignment, regime,
      rsi_value, rsi_signal, rsi_divergence,
      stochrsi_k, stochrsi_d, stochrsi_signal,
      macd_histogram, macd_momentum_state,
      adx_value, adx_trend_direction, adx_regime,
      supertrend_direction, supertrend_level, wave_trend_signal,
      bb_position, bb_width_pct,
      volume_delta_buy_pct, cvd_trend, cvd_divergence,
      vwap_trend, vwap_divergence,
      bos_direction, bos_valid, choch_direction,
      fvg_bullish_count, fvg_bearish_count,
      nearest_support_pct, nearest_resistance_pct,
      nearest_support_strength, nearest_resistance_strength,
      vp_poc_distance_pct, vp_valid
    ) VALUES (
      @analysis_id, @tf,
      @trend, @momentum_alignment, @regime,
      @rsi_value, @rsi_signal, @rsi_divergence,
      @stochrsi_k, @stochrsi_d, @stochrsi_signal,
      @macd_histogram, @macd_momentum_state,
      @adx_value, @adx_trend_direction, @adx_regime,
      @supertrend_direction, @supertrend_level, @wave_trend_signal,
      @bb_position, @bb_width_pct,
      @volume_delta_buy_pct, @cvd_trend, @cvd_divergence,
      @vwap_trend, @vwap_divergence,
      @bos_direction, @bos_valid, @choch_direction,
      @fvg_bullish_count, @fvg_bearish_count,
      @nearest_support_pct, @nearest_resistance_pct,
      @nearest_support_strength, @nearest_resistance_strength,
      @vp_poc_distance_pct, @vp_valid
    )
  `);

  const insertCluster = db.prepare(`
    INSERT INTO analysis_liquidation_snapshot (
      analysis_id, cluster_type, cluster_rank, price, total_usd, distance_pct
    ) VALUES (
      @analysis_id, @cluster_type, @cluster_rank, @price, @total_usd, @distance_pct
    )
  `);

  const transaction = db.transaction(() => {
    insertHeader.run(header);
    for (const snap of tfSnapshots) insertSnapshot.run(snap);
    for (const cluster of clusters) insertCluster.run(cluster);
  });

  transaction();
  pruneOldAnalyses(header.coin);
}

// ─── History ──────────────────────────────────────────────────────────────────

export function getAnalysisHistory(coin, limit = 10, offset = 0) {
  const db = getDb();

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM analyses WHERE coin = ?'
  ).get(coin.toUpperCase()).count;

  const rows = db.prepare(`
    SELECT
      a.id, a.timestamp, a.primary_tf, a.model_used,
      a.price_current, a.price_change_24h_pct,
      a.btc_dominance_pct,

      a.fear_greed_value, a.fear_greed_class,

      a.btc_dvol_regime,

      a.funding_rate_pct, a.predicted_rate_pct,
      a.funding_severity, a.funding_severity_negative,
      a.oi_change_24h_pct,
      a.etf_trend_7d,

      a.mvrv_signal,

      a.action, a.confidence, a.risk_score,
      a.score_derivatives, a.score_structure, a.score_volume, a.score_onchain, a.score_total,
      a.primary_driver,
      a.has_executable_setup, a.gating_active, a.gating_reason,
      a.contradictions_found, a.contradiction_count,
      a.setup_entry_price, a.setup_stop_price, a.setup_tp1_price,

      a.tf_conflict, a.macro_regime,
      a.executive_summary, a.validation_warnings, a.missing_confirmations,

      -- Resultado a posteriori (analysis_outcome), null si aún no evaluado
      o.outcome_1h, o.outcome_24h, o.outcome_7d,
      o.pnl_pct_24h, o.price_24h_later,
      o.setup_outcome, o.setup_hit_tp1, o.setup_hit_tp2, o.setup_hit_stop
    FROM analyses a
    LEFT JOIN analysis_outcome o ON o.analysis_id = a.id
    WHERE a.coin = ?
    ORDER BY a.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(coin.toUpperCase(), limit, offset);

  return { total, analyses: rows };
}

// ─── Last analysis (used by GET /api/data to show last recommendation) ────────

export function getLastAnalysis(coin) {
  const db = getDb();
  return db.prepare(`
    SELECT
      id, timestamp, action, confidence,
      executive_summary, ai_response_full,
      risk_score, score_total
    FROM analyses
    WHERE coin = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(coin.toUpperCase()) ?? null;
}

// ─── Outcome / backtesting (analysis_outcome) ─────────────────────────────────

/**
 * Devuelve análisis con outcome incompleto y suficientemente antiguos (>= olderThanMs).
 * Incluye los campos del análisis + las columnas de outcome ya rellenadas (para no
 * refetchear lo que ya está). Un análisis "necesita" outcome si no tiene fila, o le
 * falta el precio a 7d, o su setup sigue sin resolver ('open'/null).
 * @param {number} olderThanMs - Solo análisis con timestamp <= esta marca (epoch ms).
 * @param {number} [limit=100]
 */
export function getAnalysesNeedingOutcome(olderThanMs, limit = 100) {
  const db = getDb();
  const cutoff = new Date(olderThanMs).toISOString();
  return db.prepare(`
    SELECT a.id, a.coin, a.timestamp, a.price_current, a.action,
           a.has_executable_setup, a.setup_entry_price, a.setup_stop_price,
           a.setup_tp1_price, a.setup_tp2_price,
           o.price_1h_later, o.price_4h_later, o.price_24h_later, o.price_7d_later,
           o.setup_hit_tp1, o.setup_hit_tp2, o.setup_hit_stop, o.setup_outcome
    FROM analyses a
    LEFT JOIN analysis_outcome o ON o.analysis_id = a.id
    WHERE a.timestamp <= ?
      AND (o.analysis_id IS NULL
           OR o.price_7d_later IS NULL
           OR (a.has_executable_setup = 1 AND (o.setup_outcome IS NULL OR o.setup_outcome = 'open')))
    ORDER BY a.timestamp ASC
    LIMIT ?
  `).all(cutoff, limit);
}

/** Inserta o actualiza (upsert por analysis_id) una fila de analysis_outcome. */
export function upsertOutcome(o) {
  const db = getDb();
  db.prepare(`
    INSERT INTO analysis_outcome (
      analysis_id, price_at_analysis,
      price_1h_later, price_4h_later, price_24h_later, price_7d_later,
      outcome_1h, outcome_24h, outcome_7d,
      setup_hit_tp1, setup_hit_tp2, setup_hit_stop, setup_outcome, pnl_pct_24h
    ) VALUES (
      @analysis_id, @price_at_analysis,
      @price_1h_later, @price_4h_later, @price_24h_later, @price_7d_later,
      @outcome_1h, @outcome_24h, @outcome_7d,
      @setup_hit_tp1, @setup_hit_tp2, @setup_hit_stop, @setup_outcome, @pnl_pct_24h
    )
    ON CONFLICT(analysis_id) DO UPDATE SET
      price_at_analysis = excluded.price_at_analysis,
      price_1h_later = excluded.price_1h_later, price_4h_later = excluded.price_4h_later,
      price_24h_later = excluded.price_24h_later, price_7d_later = excluded.price_7d_later,
      outcome_1h = excluded.outcome_1h, outcome_24h = excluded.outcome_24h, outcome_7d = excluded.outcome_7d,
      setup_hit_tp1 = excluded.setup_hit_tp1, setup_hit_tp2 = excluded.setup_hit_tp2,
      setup_hit_stop = excluded.setup_hit_stop, setup_outcome = excluded.setup_outcome,
      pnl_pct_24h = excluded.pnl_pct_24h
  `).run({
    analysis_id:       o.analysis_id,
    price_at_analysis: o.price_at_analysis ?? null,
    price_1h_later:    o.price_1h_later ?? null,
    price_4h_later:    o.price_4h_later ?? null,
    price_24h_later:   o.price_24h_later ?? null,
    price_7d_later:    o.price_7d_later ?? null,
    outcome_1h:        o.outcome_1h ?? null,
    outcome_24h:       o.outcome_24h ?? null,
    outcome_7d:        o.outcome_7d ?? null,
    setup_hit_tp1:     o.setup_hit_tp1 ?? null,
    setup_hit_tp2:     o.setup_hit_tp2 ?? null,
    setup_hit_stop:    o.setup_hit_stop ?? null,
    setup_outcome:     o.setup_outcome ?? null,
    pnl_pct_24h:       o.pnl_pct_24h ?? null,
  });
}

/**
 * Estadísticas agregadas de backtesting a partir de analysis_outcome.
 * @param {string|null} coin - Filtra por moneda, o null para todas.
 */
export function getOutcomeStats(coin = null) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                    AS total_evaluated,
      SUM(CASE WHEN o.outcome_24h = 'win'  THEN 1 ELSE 0 END)     AS win_24h,
      SUM(CASE WHEN o.outcome_24h = 'loss' THEN 1 ELSE 0 END)     AS loss_24h,
      SUM(CASE WHEN o.outcome_24h = 'flat' THEN 1 ELSE 0 END)     AS flat_24h,
      ROUND(AVG(o.pnl_pct_24h), 2)                                AS avg_pnl_pct_24h,
      SUM(CASE WHEN o.setup_outcome IN ('tp1','tp2') THEN 1 ELSE 0 END) AS setup_tp,
      SUM(CASE WHEN o.setup_outcome = 'stop' THEN 1 ELSE 0 END)   AS setup_stop,
      SUM(CASE WHEN o.setup_outcome = 'open' THEN 1 ELSE 0 END)   AS setup_open
    FROM analysis_outcome o
    JOIN analyses a ON a.id = o.analysis_id
    WHERE (@coin IS NULL OR a.coin = @coin)
  `).get({ coin: coin ? coin.toUpperCase() : null });

  const directional = (row.win_24h ?? 0) + (row.loss_24h ?? 0);
  return {
    ...row,
    win_rate_24h: directional > 0 ? parseFloat(((row.win_24h / directional) * 100).toFixed(1)) : null,
  };
}

// ─── Prune ────────────────────────────────────────────────────────────────────

function pruneOldAnalyses(coin) {
  const db = getDb();
  const count = db.prepare(
    'SELECT COUNT(*) as count FROM analyses WHERE coin = ?'
  ).get(coin.toUpperCase()).count;

  if (count > MAX_ANALYSES_STORED) {
    const toDelete = count - MAX_ANALYSES_STORED;
    // Get IDs of oldest rows to prune related tables too
    const ids = db.prepare(`
      SELECT id FROM analyses WHERE coin = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(coin.toUpperCase(), toDelete).map(r => r.id);

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM analysis_tf_snapshot WHERE analysis_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM analysis_liquidation_snapshot WHERE analysis_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM analysis_outcome WHERE analysis_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM analyses WHERE id IN (${placeholders})`).run(...ids);
  }
}
