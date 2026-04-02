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
  db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      coin TEXT NOT NULL,
      primary_tf TEXT DEFAULT '4h',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,

      price_current REAL,
      price_change_24h REAL,

      rsi REAL,
      macd_value REAL,
      macd_signal REAL,
      macd_histogram REAL,
      bb_upper REAL,
      bb_middle REAL,
      bb_lower REAL,

      volume_buy_pct REAL,
      volume_sell_pct REAL,

      sentiment_score REAL,
      bullish_votes INTEGER,
      bearish_votes INTEGER,

      recommendation TEXT,
      recommendation_action TEXT,
      recommendation_confidence REAL,

      ai_response TEXT,
      processing_time_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_coin_timestamp
      ON analyses(coin, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_recommendation
      ON analyses(recommendation_action);

    CREATE TABLE IF NOT EXISTS sentiment_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT UNIQUE NOT NULL,
      score REAL,
      bullish_votes INTEGER,
      bearish_votes INTEGER,
      news_count INTEGER,
      raw_data TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
