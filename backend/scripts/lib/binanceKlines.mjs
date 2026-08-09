/**
 * binanceKlines.mjs — fetch de klines de Binance para scripts de auditoría, con
 * `taker_buy_base` incluido (necesario para CVD/VolumeDelta reales) + reflexión LOCAL.
 *
 * POR QUÉ EXISTE. Cada script de auditoría de este proyecto reimplementaba la misma función
 * de ~15 líneas para paginar `/api/v3/klines` hacia atrás — diez copias del mismo fetch son
 * diez oportunidades de que una diverja (olvide `taker_buy_base`, pagine mal el intervalo),
 * la misma clase de bug que el proyecto lleva sprints eliminando (`backfillContradictionBlocks`
 * importa `CONTRADICTION_BLOCK` de `gating.js` en vez de copiarlo). Los scripts anteriores a
 * este módulo (`auditBearishContinuationPower.mjs` y otros) NO se tocan retroactivamente — no
 * son producción y ya están verificados con su propia copia; los scripts del Bloque B
 * (SESSION_STATE.md §10) lo importan desde el principio.
 *
 * `mirrorCandles` reproduce el patrón ya establecido en `auditBearishContinuationPower.mjs`:
 * reflexión LOCAL (alrededor de un ancla propia), nunca global sobre la serie completa — un
 * ancla lejana en el tiempo tiene un precio absoluto muy distinto del inicio de la serie
 * (cripto se mueve >10x en años), y reflejar con un punto de anclaje global fijo produce
 * valores absurdos o negativos. Solo conserva los cambios PORCENTUALES si el ancla de
 * reflexión está cerca del tramo que se refleja.
 *
 * SOLO LECTURA: Binance público, sin API key.
 */

const INTERVAL_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3, '1w': 7 * 86400e3 };

/**
 * @param {string} coin - 'SOL' | 'BTC' | 'ETH' (sin sufijo USDT)
 * @param {number} days - histórico objetivo, en días
 * @param {string} interval - '1h' | '4h' | '1d' | '1w'
 * @returns {Promise<Array<{t:number, open:number, high:number, low:number, close:number, volume:number, taker_buy_base:number}>>}
 */
export async function fetchKlines(coin, days, interval = '4h') {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`interval no soportado: ${interval}`);
  const out = [];
  let end = Date.now();
  for (let g = 0; g < 40; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=${interval}&limit=1000&endTime=${end}`);
    if (!r.ok) throw new Error(`Binance ${coin}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
      volume: +x[5], taker_buy_base: +x[9],
    }));
    if (!b.length) break;
    out.unshift(...b);
    if (b.length < 1000) break; // llegamos al origen del listado de Binance
    end = b[0].t - 1;
    // `days` es DÍAS, no velas — dividir por `intervalMs` medía nº de velas y hacía que
    // DAYS=1000 parase tras ~2 páginas en TFs cortos (bug cazado el 2026-08-09, B1: la
    // primera corrida de auditMacdCrossSignal.mjs se detuvo a 333 días con DAYS=1000).
    if ((out.at(-1).t - out[0].t) / 86400e3 >= days) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Reflexión LOCAL del camino (precio y agresor) alrededor de `anchorClose` (por defecto el
 * primer cierre del tramo pasado). `p' = 2A - p`; el agresor se complementa
 * (`taker_buy_base' = volume - taker_buy_base`), igual que en `auditComputeTrend.mjs` y
 * `auditBearishContinuationPower.mjs` — bajo esta reflexión RSI'=100-RSI, MACD'=-MACD,
 * DI+↔DI-, StochRSI'=100-StochRSI (demostrado al 100% en `auditComputeTrend.mjs`).
 */
export function mirrorCandles(candles, anchorClose = candles[0].close) {
  const A = anchorClose;
  return candles.map((c) => ({
    t: c.t, open: 2 * A - c.open, close: 2 * A - c.close,
    high: 2 * A - c.low, low: 2 * A - c.high, volume: c.volume,
    taker_buy_base: c.volume - c.taker_buy_base,
  }));
}
