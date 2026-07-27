#!/usr/bin/env node
/**
 * backfillHistorySeries.mjs — reconstruye CVD y VWAP hacia atrás desde klines de Binance.
 *
 * CORRIGE UNA PREMISA FALSA. La documentación sostenía que CVD/VWAP «no tienen fuente
 * externa de histórico y no se pueden reconstruir retroactivamente», y de ahí salía la
 * regla de que la Pi no podía apagarse. Es falso: `historyPoller` los calcula con
 * `computeIndicators` sobre las 90 velas diarias de Binance, o sea que son función PURA de
 * datos públicos y permanentes. Para cualquier fecha pasada se recalcula lo mismo.
 *
 * Lo único que hacía falta era que `fetchHistoricalKlines` arrastrase `taker_buy_base`
 * (Binance lo devuelve también para fechas pasadas). Sin ese campo el CVD cae al proxy
 * heurístico, que da un resultado DISTINTO —sobre el mismo día de SOL, delta −7.566 con
 * taker real y +542.289 con heurística, signo opuesto— y mezclaría filas incompatibles en
 * la misma serie sin marca que las distinga.
 *
 * Usos:
 *   1. Recuperarse de un apagado (huecos en la serie).
 *   2. **Sembrar** la serie tras un punto cero: en vez de acumular un día cada 24h, el LLM
 *      arranca con la ventana de 30 días llena desde el primer análisis.
 *
 * Idempotente: `persist()` hace ON CONFLICT DO UPDATE, así que re-ejecutarlo reescribe el
 * mismo valor. Por defecto NO pisa lo ya guardado (--force para recalcular).
 *
 * Uso (desde backend/):
 *   node scripts/backfillHistorySeries.mjs                  # 3 monedas, 90 días
 *   COINS=SOL DAYS=30 node scripts/backfillHistorySeries.mjs
 *   node scripts/backfillHistorySeries.mjs --force          # recalcula existentes
 *   node scripts/backfillHistorySeries.mjs --dry-run        # no escribe, solo informa
 */

import { fetchHistoricalKlines } from '../src/services/coingeckoService.js';
import { computeIndicators } from '../src/services/indicatorService.js';
import { getDb, initDb, closeDb } from '../src/config/db.js';

const DAY_MS = 86400 * 1000;
const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const DAYS = Number(process.env.DAYS ?? 90);
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');

// Ventana que `computeIndicators` necesita para que CVD/VWAP sean comparables con lo que
// calcula el poller en vivo (fetchOHLC 1D pide 90 velas).
const WINDOW = 90;

const tsKey = (dateStr) => Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);

function existingKeys(db, coin, metric) {
  return new Set(db.prepare(
    'SELECT ts_key FROM history_series WHERE coin = ? AND metric = ?',
  ).all(coin, metric).map((r) => r.ts_key));
}

async function backfillCoin(db, coin) {
  const now = Date.now();
  // Se pide la ventana completa una sola vez y se recorre: para el día D se usan las velas
  // <= D, igual que vería el poller ese día. Ojo: la vela del día EN CURSO está abierta,
  // así que el día de hoy se deja al poller (su snapshot es parcial por diseño).
  const from = now - (DAYS + WINDOW + 2) * DAY_MS;
  const klines = await fetchHistoricalKlines(coin, '1d', from, now, 1000);
  if (klines.length < WINDOW + 1) {
    console.log(`  ${coin}: histórico insuficiente (${klines.length} velas)`);
    return { cvd: 0, vwap: 0, skipped: 0 };
  }

  const haveCvd = existingKeys(db, coin, 'cvd');
  const haveVwap = existingKeys(db, coin, 'vwap');
  const todayKey = tsKey(new Date(now).toISOString().split('T')[0]);

  const stmt = db.prepare(
    `INSERT INTO history_series (coin, metric, ts_key, payload) VALUES (?, ?, ?, ?)
     ON CONFLICT(coin, metric, ts_key) DO UPDATE SET payload = excluded.payload`,
  );

  let nCvd = 0, nVwap = 0, skipped = 0;
  for (let i = WINDOW; i < klines.length; i++) {
    const candle = klines[i];
    const date = new Date(candle.t).toISOString().split('T')[0];
    const key = tsKey(date);
    if (key === todayKey) continue;              // vela abierta: la escribe el poller
    if (now - candle.t > (DAYS + 1) * DAY_MS) continue;

    const window = klines.slice(i - WINDOW + 1, i + 1);
    const ind = computeIndicators(window, '1D');
    if (!ind) continue;

    if (ind.cvd?.value != null && (FORCE || !haveCvd.has(key))) {
      const payload = {
        date, value: ind.cvd.value, delta: ind.cvd.last_candle_delta ?? null,
        trend: ind.cvd.trend, divergence: ind.cvd.divergence,
      };
      // Guarda de integridad: si por lo que sea el CVD saliera heurístico, se ABORTA en vez
      // de mezclarlo con las filas taker_real del poller. Una serie con dos definiciones
      // distintas y sin marca es peor que una serie con huecos.
      if (ind.cvd.source !== 'taker_real') {
        throw new Error(
          `${coin} ${date}: CVD source="${ind.cvd.source}" (se esperaba taker_real). `
          + '¿fetchHistoricalKlines dejó de arrastrar taker_buy_base?',
        );
      }
      if (!DRY) stmt.run(coin, 'cvd', key, JSON.stringify(payload));
      nCvd++;
    } else if (ind.cvd?.value != null) skipped++;

    if (ind.vwap?.value != null && (FORCE || !haveVwap.has(key))) {
      const payload = {
        date, value: ind.vwap.value, trend: ind.vwap.trend, divergence: ind.vwap.divergence,
      };
      if (!DRY) stmt.run(coin, 'vwap', key, JSON.stringify(payload));
      nVwap++;
    }
  }
  return { cvd: nCvd, vwap: nVwap, skipped };
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log('BACKFILL history_series — CVD/VWAP desde klines históricas de Binance');
console.log(`Monedas: ${COINS.join(', ')} · ${DAYS} días · ventana ${WINDOW} velas`
  + `${FORCE ? ' · FORCE (recalcula existentes)' : ''}${DRY ? ' · DRY-RUN' : ''}`);

initDb();
const db = getDb();
try {
  for (const coin of COINS) {
    try {
      const r = await backfillCoin(db, coin);
      console.log(`  ${coin.padEnd(4)} cvd +${r.cvd}  vwap +${r.vwap}`
        + `${r.skipped ? `  (${r.skipped} ya existían, usa --force para recalcular)` : ''}`);
    } catch (e) {
      console.log(`  ${coin.padEnd(4)} ERROR: ${e.message}`);
    }
  }
  const total = db.prepare(
    "SELECT metric, COUNT(*) n, MIN(ts_key) desde, MAX(ts_key) hasta FROM history_series "
    + "WHERE metric IN ('cvd','vwap') GROUP BY metric",
  ).all();
  console.log('\nEstado final:');
  for (const t of total) {
    const d = (k) => new Date(k * 1000).toISOString().split('T')[0];
    console.log(`  ${t.metric.padEnd(5)} ${String(t.n).padStart(4)} filas · ${d(t.desde)} → ${d(t.hasta)}`);
  }
} finally {
  closeDb();
}
