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
      has_executable_setup, gating_active, gating_reason, contradictions_found,
      score_derivatives, score_structure, score_volume, score_onchain, score_total,
      setup_entry_price, setup_stop_price, setup_tp1_price, setup_tp2_price,
      setup_validity_candles, setup_tf_execution,
      executive_summary, ai_response_full,
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
      @has_executable_setup, @gating_active, @gating_reason, @contradictions_found,
      @score_derivatives, @score_structure, @score_volume, @score_onchain, @score_total,
      @setup_entry_price, @setup_stop_price, @setup_tp1_price, @setup_tp2_price,
      @setup_validity_candles, @setup_tf_execution,
      @executive_summary, @ai_response_full,
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
      supertrend_direction, wave_trend_signal,
      bb_position, bb_width_pct,
      volume_delta_buy_pct, cvd_trend, cvd_divergence,
      vwap_trend, vwap_divergence,
      bos_direction, bos_valid, choch_direction,
      fvg_bullish_count, fvg_bearish_count,
      nearest_support_pct, nearest_resistance_pct,
      vp_poc_distance_pct, vp_valid
    ) VALUES (
      @analysis_id, @tf,
      @trend, @momentum_alignment, @regime,
      @rsi_value, @rsi_signal, @rsi_divergence,
      @stochrsi_k, @stochrsi_d, @stochrsi_signal,
      @macd_histogram, @macd_momentum_state,
      @adx_value, @adx_trend_direction, @adx_regime,
      @supertrend_direction, @wave_trend_signal,
      @bb_position, @bb_width_pct,
      @volume_delta_buy_pct, @cvd_trend, @cvd_divergence,
      @vwap_trend, @vwap_divergence,
      @bos_direction, @bos_valid, @choch_direction,
      @fvg_bullish_count, @fvg_bearish_count,
      @nearest_support_pct, @nearest_resistance_pct,
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
      id, timestamp, primary_tf,
      price_current, price_change_24h_pct,
      btc_dominance_pct,

      fear_greed_value, fear_greed_class,

      btc_dvol_regime,

      funding_rate_pct, predicted_rate_pct,
      funding_severity, funding_severity_negative,
      oi_change_24h_pct,
      etf_trend_7d,

      mvrv_signal,

      action, confidence, risk_score,
      score_derivatives, score_structure, score_volume, score_onchain, score_total,
      primary_driver,
      has_executable_setup, gating_active, gating_reason,
      setup_entry_price, setup_stop_price, setup_tp1_price,

      tf_conflict, macro_regime,
      executive_summary
    FROM analyses
    WHERE coin = ?
    ORDER BY timestamp DESC
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
