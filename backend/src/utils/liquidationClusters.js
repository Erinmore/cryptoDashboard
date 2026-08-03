/**
 * liquidationClusters.js — núcleo PURO de la inferencia de "magnetic zones".
 *
 * Extraído de `services/liquidationClustersService.js` el 2026-08-02, sin cambiar una sola
 * regla: el servicio se queda con el I/O (Coinalyze + Binance + cache) y aquí vive el
 * cálculo. El motivo es el de siempre en este proyecto — `scripts/backfillLiquidationClusters.mjs`
 * necesita reconstruir clusters de análisis pasados, y una segunda copia del algoritmo
 * dejaría de casar con lo que produce producción en cuanto una de las dos se tocara.
 * Mismo patrón que `utils/shadowTrade.js` reutilizando `evaluateSetupBarrier`.
 *
 * IMPORTANTE (heredado del servicio): esto es una APROXIMACIÓN, no datos tipo CoinGlass.
 * Coinalyze expone los USD liquidados por bucket horario SIN precio asociado; el precio se
 * infiere cruzando cada bucket con la vela 1h del mismo timestamp (longs → el `low` de la
 * vela, shorts → el `high`).
 */

const BINS = 50;
const TOP_N = 5;

/**
 * Distancia porcentual CON SIGNO de un nivel al precio de referencia.
 * Negativo = el nivel está por debajo del precio; positivo = por encima.
 *
 * Dueño ÚNICO de la fórmula: la consumen `computeLiquidationClusters` (para
 * `nearest_*_cluster_pct`, que alimenta los flags magnéticos que lee el prompt) y
 * `buildClusterRows` (para persistir la distancia de cada cluster). Dos copias de esto es
 * como se desincroniza lo que decide de lo que se audita.
 *
 * @returns {number|null}
 */
export function clusterDistancePct(referencePrice, price) {
  if (referencePrice == null || price == null || !referencePrice) return null;
  return parseFloat(((price - referencePrice) / referencePrice * 100).toFixed(2));
}

/**
 * Agrupa liquidaciones en clusters de precio y deriva las zonas magnéticas.
 *
 * @param {Array<{t:number, l?:number, s?:number}>} buckets - liquidation-history 1h (Coinalyze),
 *        `t` en SEGUNDOS, `l`/`s` en USD.
 * @param {Array<{t:number, high:number, low:number, close:number}>} candles - klines 1h de
 *        Binance, `t` en MILISEGUNDOS. La última vela fija el precio de referencia.
 * @returns {object|null} misma forma que devolvía el servicio, o `null` si no hay con qué
 *          calcular (sin buckets, sin velas, o sin rango de precio utilizable).
 */
export function computeLiquidationClusters(buckets, candles) {
  if (!buckets?.length || !candles?.length) return null;

  // Indexar candles por timestamp en segundos (Binance entrega ms)
  const candleByT = new Map();
  for (const c of candles) {
    const tSec = Math.floor(c.t / 1000);
    candleByT.set(tSec, c);
  }

  // Determinar rango de precio del periodo (sólo velas que tengan match con un bucket)
  let rangeLow = Infinity;
  let rangeHigh = -Infinity;
  for (const b of buckets) {
    const c = candleByT.get(b.t);
    if (!c) continue;
    if (c.low  < rangeLow)  rangeLow  = c.low;
    if (c.high > rangeHigh) rangeHigh = c.high;
  }
  if (!isFinite(rangeLow) || !isFinite(rangeHigh) || rangeHigh <= rangeLow) return null;

  const binSize = (rangeHigh - rangeLow) / BINS;
  const longBins  = new Array(BINS).fill(null).map(() => ({ usd: 0, count: 0 }));
  const shortBins = new Array(BINS).fill(null).map(() => ({ usd: 0, count: 0 }));

  for (const b of buckets) {
    const c = candleByT.get(b.t);
    if (!c) continue;
    const longsUsd  = b.l ?? 0;
    const shortsUsd = b.s ?? 0;

    if (longsUsd > 0) {
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((c.low - rangeLow) / binSize)));
      longBins[idx].usd += longsUsd;
      longBins[idx].count++;
    }
    if (shortsUsd > 0) {
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((c.high - rangeLow) / binSize)));
      shortBins[idx].usd += shortsUsd;
      shortBins[idx].count++;
    }
  }

  const binCenter = (idx) => parseFloat((rangeLow + binSize * (idx + 0.5)).toFixed(2));

  // Formato legible para el LLM: "182.74M" / "45.20K" / "850"
  const fmtUsd = (n) => {
    if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`;
    return `${n.toFixed(0)}`;
  };

  const toClusters = (bins) => bins
    .map((b, i) => ({
      price: binCenter(i),
      total_usd: parseFloat(b.usd.toFixed(2)),
      total_usd_display: fmtUsd(b.usd),
      unit: 'usd',
      count: b.count,
    }))
    .filter(x => x.total_usd > 0)
    .sort((a, b) => b.total_usd - a.total_usd)
    .slice(0, TOP_N);

  const long_clusters  = toClusters(longBins);
  const short_clusters = toClusters(shortBins);

  // Distancia al cluster más cercano respecto al precio actual
  const lastCandle = candles[candles.length - 1];
  const currentPrice = lastCandle?.close ?? null;

  let nearest_long_cluster_pct = null;
  let nearest_short_cluster_pct = null;
  if (currentPrice) {
    // Long clusters: buscar el más cercano POR DEBAJO del precio actual
    const longsBelow = long_clusters.filter(c => c.price < currentPrice);
    if (longsBelow.length) {
      const closest = longsBelow.reduce((a, b) => (currentPrice - a.price) < (currentPrice - b.price) ? a : b);
      nearest_long_cluster_pct = clusterDistancePct(currentPrice, closest.price);
    }
    // Short clusters: buscar el más cercano POR ENCIMA del precio actual
    const shortsAbove = short_clusters.filter(c => c.price > currentPrice);
    if (shortsAbove.length) {
      const closest = shortsAbove.reduce((a, b) => (a.price - currentPrice) < (b.price - currentPrice) ? a : b);
      nearest_short_cluster_pct = clusterDistancePct(currentPrice, closest.price);
    }
  }

  // Zona magnética activa: cluster en la banda 1%-3% del precio (regla F5 del prompt,
  // precalculada para que el LLM lea el flag en vez de comparar rangos a ojo).
  const inBand = (pct, lo, hi) => pct != null && pct >= lo && pct <= hi;
  return {
    long_clusters,
    short_clusters,
    nearest_long_cluster_pct,
    nearest_short_cluster_pct,
    // longs en riesgo (imán bajista): cluster long a -1%..-3% por debajo del precio.
    magnetic_long_zone_active: inBand(nearest_long_cluster_pct, -3, -1),
    // shorts en riesgo (imán alcista): cluster short a +1%..+3% por encima del precio.
    magnetic_short_zone_active: inBand(nearest_short_cluster_pct, 1, 3),
    source: 'coinalyze_inferred',
  };
}
