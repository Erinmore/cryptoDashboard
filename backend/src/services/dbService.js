import { getDb } from '../config/db.js';
import { MAX_ANALYSES_STORED } from '../config/constants.js';

// ─── Sentiment cache ──────────────────────────────────────────────────────────

export function getSentimentCache(coin) {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM sentiment_cache WHERE coin = ?'
  ).get(coin.toUpperCase());

  if (!row) return null;

  return {
    coin: row.coin,
    score: row.score,
    bullish_votes: row.bullish_votes,
    bearish_votes: row.bearish_votes,
    news_count: row.news_count,
    raw_data: row.raw_data ? JSON.parse(row.raw_data) : null,
    last_updated: row.last_updated,
    stale: true,
  };
}

export function setSentimentCache(coin, data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sentiment_cache (coin, score, bullish_votes, bearish_votes, news_count, raw_data, last_updated)
    VALUES (@coin, @score, @bullish_votes, @bearish_votes, @news_count, @raw_data, CURRENT_TIMESTAMP)
    ON CONFLICT(coin) DO UPDATE SET
      score = excluded.score,
      bullish_votes = excluded.bullish_votes,
      bearish_votes = excluded.bearish_votes,
      news_count = excluded.news_count,
      raw_data = excluded.raw_data,
      last_updated = CURRENT_TIMESTAMP
  `).run({
    coin: coin.toUpperCase(),
    score: data.score,
    bullish_votes: data.bullish_votes,
    bearish_votes: data.bearish_votes,
    news_count: data.news_count ?? 0,
    raw_data: JSON.stringify(data),
  });
}

// ─── Analyses ─────────────────────────────────────────────────────────────────

export function saveAnalysis(data) {
  const db = getDb();

  db.prepare(`
    INSERT INTO analyses (
      id, coin, primary_tf, price_current, price_change_24h,
      rsi, macd_value, macd_signal, macd_histogram,
      bb_upper, bb_middle, bb_lower,
      volume_buy_pct, volume_sell_pct,
      sentiment_score, bullish_votes, bearish_votes,
      recommendation, recommendation_action, recommendation_confidence,
      ai_response, processing_time_ms
    ) VALUES (
      @id, @coin, @primary_tf, @price_current, @price_change_24h,
      @rsi, @macd_value, @macd_signal, @macd_histogram,
      @bb_upper, @bb_middle, @bb_lower,
      @volume_buy_pct, @volume_sell_pct,
      @sentiment_score, @bullish_votes, @bearish_votes,
      @recommendation, @recommendation_action, @recommendation_confidence,
      @ai_response, @processing_time_ms
    )
  `).run(data);

  pruneOldAnalyses(data.coin);
}

export function getAnalysisHistory(coin, limit = 10, offset = 0) {
  const db = getDb();

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM analyses WHERE coin = ?'
  ).get(coin.toUpperCase()).count;

  const rows = db.prepare(`
    SELECT id, timestamp, price_current, recommendation_action, recommendation_confidence
    FROM analyses
    WHERE coin = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(coin.toUpperCase(), limit, offset);

  return { total, analyses: rows };
}

export function getLastAnalysis(coin) {
  const db = getDb();
  return db.prepare(`
    SELECT id, timestamp, recommendation_action, recommendation_confidence, ai_response
    FROM analyses
    WHERE coin = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(coin.toUpperCase()) ?? null;
}

function pruneOldAnalyses(coin) {
  const db = getDb();
  const count = db.prepare(
    'SELECT COUNT(*) as count FROM analyses WHERE coin = ?'
  ).get(coin.toUpperCase()).count;

  if (count > MAX_ANALYSES_STORED) {
    db.prepare(`
      DELETE FROM analyses WHERE id IN (
        SELECT id FROM analyses WHERE coin = ?
        ORDER BY timestamp ASC
        LIMIT ?
      )
    `).run(coin.toUpperCase(), count - MAX_ANALYSES_STORED);
  }
}
