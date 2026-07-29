import { getDb } from '../config/db.js';
import { MAX_ANALYSES_STORED } from '../config/constants.js';
import {
  wilsonInterval, MIN_DIRECTIONAL_SAMPLE,
  summarizeOpportunity, summarizePathWinRate, summarizeConviction,
} from '../utils/stats.js';
import { countEpisodes } from '../utils/episodes.js';

// ─── Save analysis (4-table transaction) ──────────────────────────────────────

/**
 * Persists a complete analysis in 4 tables atomically.
 *
 * @param {object} data
 *   data.header     — fields for `analyses`
 *   data.tfSnapshots — array of up to 4 objects for `analysis_tf_snapshot`
 *   data.clusters   — array of up to 10 objects for `analysis_liquidation_snapshot`
 *   data.fvgs       — array of up to 40 objects for `analysis_fvg_snapshot` (5 × 2 dir × 4 TFs)
 */
export function saveAnalysis(data) {
  const db = getDb();
  const { header, tfSnapshots = [], clusters = [], fvgs = [] } = data;

  const insertHeader = db.prepare(`
    INSERT INTO analyses (
      id, coin, primary_tf, timestamp, prompt_version,
      price_current, price_change_24h_pct, btc_dominance_pct, market_cap_change_24h_pct,
      fear_greed_value, fear_greed_class, fear_greed_trend_30d, fear_greed_30d_avg,
      macro_regime, dxy_value, dxy_trend_5d, spx_trend_5d, gold_trend_5d,
      btc_dvol_value, btc_dvol_regime, eth_dvol_value,
      mvrv, mvrv_zscore, mvrv_signal, nupl, nupl_signal, sopr, sopr_signal,
      funding_rate_pct, funding_severity, funding_severity_negative, funding_trend,
      predicted_rate_pct, oi_value_usd, oi_value_coins, oi_change_24h_pct, oi_trend_7d,
      long_pct, short_pct, liq_longs_24h_usd, liq_shorts_24h_usd,
      etf_trend_7d, etf_net_inflow_7d_usd, etf_data_freshness,
      ob_imbalance_ratio, ob_imbalance_top5_ratio, ob_imbalance_signal,
      tf_conflict,
      action, confidence, risk_score, conviction, primary_driver,
      has_executable_setup, gating_active, gating_reason, contradictions_found, missing_confirmations,
      contradiction_count, contradiction_codes, deduped_by_veto, contradictions_signal_count,
      score_derivatives, score_structure, score_volume, score_onchain, score_total,
      score_total_backend, score_derivatives_expected, score_volume_expected,
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
      @predicted_rate_pct, @oi_value_usd, @oi_value_coins, @oi_change_24h_pct, @oi_trend_7d,
      @long_pct, @short_pct, @liq_longs_24h_usd, @liq_shorts_24h_usd,
      @etf_trend_7d, @etf_net_inflow_7d_usd, @etf_data_freshness,
      @ob_imbalance_ratio, @ob_imbalance_top5_ratio, @ob_imbalance_signal,
      @tf_conflict,
      @action, @confidence, @risk_score, @conviction, @primary_driver,
      @has_executable_setup, @gating_active, @gating_reason, @contradictions_found, @missing_confirmations,
      @contradiction_count, @contradiction_codes, @deduped_by_veto, @contradictions_signal_count,
      @score_derivatives, @score_structure, @score_volume, @score_onchain, @score_total,
      @score_total_backend, @score_derivatives_expected, @score_volume_expected,
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
      cvd_strength, cvd_delta_vs_volume_pct, cvd_strength_pctile, cvd_strength_cuts,
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
      @cvd_strength, @cvd_delta_vs_volume_pct, @cvd_strength_pctile, @cvd_strength_cuts,
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

  const insertFvg = db.prepare(`
    INSERT INTO analysis_fvg_snapshot (
      analysis_id, tf, fvg_type, fvg_rank, zone_low, zone_high, size_pct,
      mitigation_pct, candles_ago, signal_status, formed_t, distance_pct
    ) VALUES (
      @analysis_id, @tf, @fvg_type, @fvg_rank, @zone_low, @zone_high, @size_pct,
      @mitigation_pct, @candles_ago, @signal_status, @formed_t, @distance_pct
    )
  `);

  const transaction = db.transaction(() => {
    insertHeader.run(header);
    for (const snap of tfSnapshots) insertSnapshot.run(snap);
    for (const cluster of clusters) insertCluster.run(cluster);
    for (const fvg of fvgs) insertFvg.run(fvg);
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

      a.action, a.confidence, a.risk_score, a.conviction,
      a.score_derivatives, a.score_structure, a.score_volume, a.score_onchain, a.score_total,
      a.primary_driver,
      a.has_executable_setup, a.gating_active, a.gating_reason,
      a.contradictions_found, a.contradiction_count, a.contradiction_codes,
      a.deduped_by_veto, a.contradictions_signal_count,
      a.setup_entry_price, a.setup_stop_price, a.setup_tp1_price,

      a.tf_conflict, a.macro_regime,
      a.executive_summary, a.validation_warnings, a.missing_confirmations,

      -- Resultado a posteriori (analysis_outcome), null si aún no evaluado
      o.outcome_1h, o.outcome_24h, o.outcome_7d,
      o.pnl_pct_24h, o.pnl_signed_pct_24h, o.price_24h_later,
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
  // Fase 5 · reintento acotado del recorrido: una fila sin métricas de path se vuelve a
  // seleccionar solo mientras esté dentro de la ventana de 7d + 1 día de gracia. Pasado
  // eso deja de reintentarse aunque siga a NULL — si no, un análisis cuyo ATR no se pudo
  // reconstruir se re-pediría a Binance cada 15 minutos para siempre (el mismo churn que
  // ya se cerró con el `setup_outcome='invalid'`).
  const backfillCutoff = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  return db.prepare(`
    SELECT a.id, a.coin, a.timestamp, a.price_current, a.action, a.primary_tf,
           a.has_executable_setup, a.setup_entry_price, a.setup_stop_price,
           a.setup_tp1_price, a.setup_tp2_price,
           a.setup_validity_candles, a.setup_tf_execution,
           o.price_at_analysis,
           o.price_1h_later, o.price_4h_later, o.price_24h_later, o.price_7d_later,
           o.setup_hit_tp1, o.setup_hit_tp2, o.setup_hit_stop, o.setup_outcome,
           o.atr_pct_at_analysis, o.max_up_pct_7d
    FROM analyses a
    LEFT JOIN analysis_outcome o ON o.analysis_id = a.id
    WHERE a.timestamp <= @cutoff
      AND (o.analysis_id IS NULL
           OR o.price_7d_later IS NULL
           OR (a.has_executable_setup = 1 AND (o.setup_outcome IS NULL OR o.setup_outcome = 'open'))
           OR (o.max_up_pct_7d IS NULL AND a.timestamp >= @backfillCutoff))
    ORDER BY a.timestamp ASC
    LIMIT @limit
  `).all({ cutoff, backfillCutoff, limit });
}

/** Inserta o actualiza (upsert por analysis_id) una fila de analysis_outcome. */
export function upsertOutcome(o) {
  const db = getDb();
  db.prepare(`
    INSERT INTO analysis_outcome (
      analysis_id, price_at_analysis,
      price_1h_later, price_4h_later, price_24h_later, price_7d_later,
      outcome_1h, outcome_24h, outcome_7d,
      setup_hit_tp1, setup_hit_tp2, setup_hit_stop, setup_outcome, pnl_pct_24h,
      pnl_signed_pct_24h,
      atr_pct_at_analysis, max_up_pct_24h, max_down_pct_24h,
      max_up_pct_7d, max_down_pct_7d, t_max_up_h, t_max_down_h, path_first_passage
    ) VALUES (
      @analysis_id, @price_at_analysis,
      @price_1h_later, @price_4h_later, @price_24h_later, @price_7d_later,
      @outcome_1h, @outcome_24h, @outcome_7d,
      @setup_hit_tp1, @setup_hit_tp2, @setup_hit_stop, @setup_outcome, @pnl_pct_24h,
      @pnl_signed_pct_24h,
      @atr_pct_at_analysis, @max_up_pct_24h, @max_down_pct_24h,
      @max_up_pct_7d, @max_down_pct_7d, @t_max_up_h, @t_max_down_h, @path_first_passage
    )
    ON CONFLICT(analysis_id) DO UPDATE SET
      price_at_analysis = excluded.price_at_analysis,
      price_1h_later = excluded.price_1h_later, price_4h_later = excluded.price_4h_later,
      price_24h_later = excluded.price_24h_later, price_7d_later = excluded.price_7d_later,
      outcome_1h = excluded.outcome_1h, outcome_24h = excluded.outcome_24h, outcome_7d = excluded.outcome_7d,
      setup_hit_tp1 = excluded.setup_hit_tp1, setup_hit_tp2 = excluded.setup_hit_tp2,
      setup_hit_stop = excluded.setup_hit_stop, setup_outcome = excluded.setup_outcome,
      pnl_pct_24h = excluded.pnl_pct_24h,
      pnl_signed_pct_24h = excluded.pnl_signed_pct_24h,
      -- Fase 5: COALESCE porque el recorrido se calcula sobre las velas ya vencidas y un
      -- ciclo con fallo transitorio de klines no debe borrar lo ya medido.
      atr_pct_at_analysis = COALESCE(excluded.atr_pct_at_analysis, atr_pct_at_analysis),
      max_up_pct_24h  = COALESCE(excluded.max_up_pct_24h,  max_up_pct_24h),
      max_down_pct_24h= COALESCE(excluded.max_down_pct_24h,max_down_pct_24h),
      max_up_pct_7d   = COALESCE(excluded.max_up_pct_7d,   max_up_pct_7d),
      max_down_pct_7d = COALESCE(excluded.max_down_pct_7d, max_down_pct_7d),
      t_max_up_h      = COALESCE(excluded.t_max_up_h,      t_max_up_h),
      t_max_down_h    = COALESCE(excluded.t_max_down_h,    t_max_down_h),
      path_first_passage = COALESCE(excluded.path_first_passage, path_first_passage)
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
    pnl_pct_24h:        o.pnl_pct_24h ?? null,
    pnl_signed_pct_24h: o.pnl_signed_pct_24h ?? null,
    atr_pct_at_analysis: o.atr_pct_at_analysis ?? null,
    max_up_pct_24h:     o.max_up_pct_24h ?? null,
    max_down_pct_24h:   o.max_down_pct_24h ?? null,
    max_up_pct_7d:      o.max_up_pct_7d ?? null,
    max_down_pct_7d:    o.max_down_pct_7d ?? null,
    t_max_up_h:         o.t_max_up_h ?? null,
    t_max_down_h:       o.t_max_down_h ?? null,
    path_first_passage: o.path_first_passage != null ? JSON.stringify(o.path_first_passage) : null,
  });
}

// Muestra mínima para reportar un win-rate como no-ruido (auditoría C5). Definida en
// utils/stats.js para que el win-rate clásico y el path-aware compartan el MISMO gate.

// Columnas de agregación de outcome (sin el SELECT ni el FROM — reutilizables para
// consultas globales y segmentadas por TF/modelo).
const OUTCOME_AGG_COLS = `
    COUNT(*)                                                    AS total_evaluated,
    SUM(CASE WHEN o.outcome_24h = 'win'  THEN 1 ELSE 0 END)     AS win_24h,
    SUM(CASE WHEN o.outcome_24h = 'loss' THEN 1 ELSE 0 END)     AS loss_24h,
    SUM(CASE WHEN o.outcome_24h = 'flat' THEN 1 ELSE 0 END)     AS flat_24h,
    -- PnL de la estrategia: firmado por dirección y SOLO direccionales. El promedio del
    -- pnl crudo sobre todas las acciones era la deriva del mercado, no rendimiento.
    ROUND(AVG(CASE WHEN a.action IN ('Comprar','Vender')
      THEN o.pnl_signed_pct_24h END), 2)                        AS avg_pnl_signed_pct_24h,
    SUM(CASE WHEN o.setup_outcome IN ('tp1','tp2') THEN 1 ELSE 0 END) AS setup_tp,
    SUM(CASE WHEN o.setup_outcome = 'stop' THEN 1 ELSE 0 END)   AS setup_stop,
    SUM(CASE WHEN o.setup_outcome = 'open' THEN 1 ELSE 0 END)   AS setup_open,
    SUM(CASE WHEN o.setup_outcome IN ('tp1','tp2','stop','expired') THEN 1 ELSE 0 END) AS setup_filled,
    SUM(CASE WHEN o.setup_outcome = 'not_triggered' THEN 1 ELSE 0 END) AS setup_not_triggered,
    SUM(CASE WHEN o.setup_outcome = 'invalid' THEN 1 ELSE 0 END) AS setup_invalid
`;
const OUTCOME_FROM = `FROM analysis_outcome o JOIN analyses a ON a.id = o.analysis_id`;

/**
 * Enriquece una fila de agregados con win-rate + IC de Wilson + fill-rate.
 * Aplica el gate de muestra mínima: sin n suficiente, win_rate_24h=null e insuficiente=true.
 */
function decorateOutcomeRow(row) {
  const wins = row.win_24h ?? 0;
  const directional = wins + (row.loss_24h ?? 0);
  const ci = wilsonInterval(wins, directional);
  const insufficient = directional < MIN_DIRECTIONAL_SAMPLE;

  // Fill-rate del setup (H6): los 'not_triggered' (entradas alucinadas que nunca se
  // llenaron) cuentan en el denominador en vez de evaporarse de las stats.
  const filled = row.setup_filled ?? 0;
  const notTriggered = row.setup_not_triggered ?? 0;
  const fillDenom = filled + notTriggered;

  return {
    ...row,
    directional_n: directional,
    sample_insufficient: insufficient,
    win_rate_24h: insufficient ? null : ci.point,
    win_rate_ci_low: insufficient ? null : ci.low,
    win_rate_ci_high: insufficient ? null : ci.high,
    setup_fill_rate: fillDenom > 0 ? parseFloat(((filled / fillDenom) * 100).toFixed(1)) : null,
  };
}

/**
 * Estadísticas agregadas de backtesting a partir de analysis_outcome.
 * Incluye IC de Wilson, gate de muestra mínima, fill-rate y segmentación por TF y modelo.
 * @param {string|null} coin - Filtra por moneda, o null para todas.
 */
export function getOutcomeStats(coin = null) {
  const db = getDb();
  const coinArg = coin ? coin.toUpperCase() : null;
  const overall = db.prepare(
    `SELECT ${OUTCOME_AGG_COLS} ${OUTCOME_FROM} WHERE (@coin IS NULL OR a.coin = @coin)`,
  ).get({ coin: coinArg });

  // field ∈ {'primary_tf','model_used'} — nombres controlados internamente (no user input).
  const byField = (field) => db.prepare(
    `SELECT a.${field} AS key, ${OUTCOME_AGG_COLS} ${OUTCOME_FROM}
     WHERE (@coin IS NULL OR a.coin = @coin) AND a.${field} IS NOT NULL
     GROUP BY a.${field} ORDER BY a.${field}`,
  ).all({ coin: coinArg }).map((r) => decorateOutcomeRow(r));

  // ── Fase 5 · bloques falsables ────────────────────────────────────────────
  // Se traen las filas (no solo agregados) porque el recorrido vive en un JSON y la
  // de-dup por episodio es lógica de agregación, no SQL. La muestra está acotada a
  // MAX_ANALYSES_STORED por moneda, así que cabe en memoria sin problema.
  const rows = db.prepare(`
    SELECT a.id, a.coin, a.timestamp, a.primary_tf, a.action, a.conviction,
           o.atr_pct_at_analysis,
           o.max_up_pct_24h, o.max_down_pct_24h, o.max_up_pct_7d, o.max_down_pct_7d,
           o.path_first_passage
    ${OUTCOME_FROM}
    WHERE (@coin IS NULL OR a.coin = @coin)
    ORDER BY a.timestamp ASC
  `).all({ coin: coinArg });

  // El coste de oportunidad se mide sobre las ABSTENCIONES: es la salida dominante del
  // sistema y la única que el win-rate direccional no puede evaluar.
  const waits = rows.filter((r) => r.action === 'Esperar' || r.action === 'Preparar');

  return {
    ...decorateOutcomeRow(overall),
    min_directional_sample: MIN_DIRECTIONAL_SAMPLE,
    by_primary_tf: byField('primary_tf'),
    by_model: byField('model_used'),
    opportunity_cost: {
      '24h': summarizeOpportunity(waits, { horizonH: 24 }),
      '7d': summarizeOpportunity(waits, { horizonH: null }),
    },
    path_win_rate: summarizePathWinRate(rows),
    conviction_calibration: summarizeConviction(rows),
    // n de análisis vs n de episodios: la diferencia es la autocorrelación de la muestra.
    episodes: { analyses_n: rows.length, episodes_n: countEpisodes(rows) },
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
    db.prepare(`DELETE FROM analysis_fvg_snapshot WHERE analysis_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM analysis_outcome WHERE analysis_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM analyses WHERE id IN (${placeholders})`).run(...ids);
  }
}
