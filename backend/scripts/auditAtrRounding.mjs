/**
 * auditAtrRounding.mjs — ¿importa que `calculateATR` redondee a 2 decimales?
 *
 * EL PROBLEMA. `calculateATR` hace `toFixed(2)` sobre el ATR en unidades de PRECIO
 * ([indicators.js:270](../src/utils/indicators.js#L270)). El error absoluto es siempre
 * ≤0,005, pero el error RELATIVO depende de lo que valga la moneda: en BTC (ATR ~900) es
 * ruido invisible; en SOL (ATR ~0,75) es tres órdenes de magnitud mayor; y en un activo de
 * céntimos sería catastrófico. Como el ATR es el DENOMINADOR de casi todos los umbrales
 * —banda del eje OI×precio, `dynamicNearLevelPct`, banda de `priceSide`, listón de
 * oportunidad, distancia normalizada del gatillo— conviene saber cuánto vale ese error
 * AHORA, y no en el activo hipotético.
 *
 * Y hay una segunda pregunta que el redondeo destapa: la "normalización por ATR" tiene
 * TOPES ABSOLUTOS. `dynamicNearLevelPct` aplica `max(0,5 %, min(techo_por_TF, 1,5×ATR%))`.
 * Cuando el suelo o el techo muerden, el umbral **deja de estar normalizado** y vuelve a ser
 * una constante — que es exactamente el fallo T5. Con el ATR% en el percentil 0-3 de su
 * propia ventana (medido en producción el 2026-08-01), la pregunta no es teórica.
 *
 * ANCLAS, fijadas antes de ejecutar:
 *
 *  A1 · ERROR RELATIVO DEL REDONDEO = 0,005 / ATR. Predicción cerrada por aritmética: BTC
 *       ~0,0006 %, ETH ~0,02 %, SOL ~0,7 %. Se comprueba que sale eso (si no, hay otra
 *       fuente de error) y, sobre todo, **cuánto mueve la BANDA del eje OI×precio en puntos
 *       porcentuales** — que es la unidad en la que se decide. Criterio: si mueve menos que
 *       el margen típico con el que se resuelve una celda, es irrelevante.
 *
 *  A2 · ¿CAMBIA ALGUNA DECISIÓN? Se recalcula `oiPriceCell` con el ATR redondeado y con el
 *       exacto, sobre los mismos anclajes, y se cuentan las celdas que DIFIEREN. Es la única
 *       pregunta que importa: un error que no cambia ninguna celda no es un bug, es ruido.
 *
 *  A3 · ¿MUERDEN LOS TOPES ABSOLUTOS de `dynamicNearLevelPct`? Frecuencia con la que el
 *       suelo (0,5 %) o el techo por TF recortan el valor ATR-normalizado, GLOBAL y en el
 *       decil más tranquilo. Si el suelo muerde a menudo en calma, el umbral de "cerca de un
 *       nivel" deja de normalizar justo en el régimen en que está produciendo el sistema.
 *
 * SOLO LECTURA. No abre la BBDD, no toca producción, Binance público.
 *
 * Uso: node scripts/auditAtrRounding.mjs
 */

import { calculateATR, calculateATRSeries } from '../src/utils/indicators.js';
import { priceBandPct, oiPriceCell } from '../src/utils/derivativesScore.js';
import { dynamicNearLevelPct } from '../src/utils/gating.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TFS = (process.env.TFS ?? '1h,4h,1D,1W').split(',');
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };
const ATR_PERIOD = 14;
const LOOKBACK = 6;                // 24h en velas de 4h, para el cambio de precio

async function klines(symbol, interval, limit = 1000) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
  }));
}

const fmt = (x, d = 4) => (x == null ? '  —  ' : x.toFixed(d));
const median = (xs) => { const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };

console.log('¿IMPORTA EL REDONDEO A 2 DECIMALES DE `calculateATR`?');
console.log('El error absoluto es ≤0,005 SIEMPRE; el RELATIVO depende del precio del activo.\n');

console.log('A1 · ERROR RELATIVO Y SU EFECTO EN LA BANDA DEL EJE OI×PRECIO');
console.log(`  ${'moneda/TF'.padEnd(12)}${'ATR'.padStart(12)}${'err.rel'.padStart(10)}`
  + `${'banda red.'.padStart(12)}${'banda exacta'.padStart(14)}${'Δ banda (pp)'.padStart(14)}`);

const cellDiff = { total: 0, differ: 0 };
const floorHit = {};

for (const coin of COINS) {
  for (const tf of TFS) {
    const cs = await klines(coin, BINANCE_TF[tf], 500);
    if (cs.length < ATR_PERIOD + LOOKBACK + 5) continue;
    const series = calculateATRSeries(cs, ATR_PERIOD);
    const byIdx = new Map(series.map((e) => [e.idx, e.atr]));

    const errs = [], dBand = [];
    floorHit[tf] ??= { n: 0, floor: 0, ceil: 0, calmN: 0, calmFloor: 0 };
    const atrPctAll = [];

    for (let i = ATR_PERIOD + LOOKBACK + 1; i < cs.length; i++) {
      const exact = byIdx.get(i);
      const close = cs[i].close;
      if (!Number.isFinite(exact) || !(close > 0)) continue;
      const rounded = parseFloat(exact.toFixed(2));       // lo que devuelve `calculateATR`
      errs.push(Math.abs(exact - rounded) / exact * 100);

      const pctR = (rounded / close) * 100;
      const pctE = (exact / close) * 100;
      atrPctAll.push(pctE);
      const bR = priceBandPct(pctR, tf), bE = priceBandPct(pctE, tf);
      if (bR != null && bE != null) dBand.push(Math.abs(bR - bE));

      // A2 — ¿cambia la celda? Sólo tiene sentido en el TF primario del protocolo.
      if (tf === '4h') {
        const prev = cs[i - LOOKBACK]?.close;
        if (prev > 0) {
          const chg = ((close - prev) / prev) * 100;
          // El OI no está disponible aquí; se prueban los dos signos posibles del eje, que
          // es lo que decide junto con el precio. Lo que se compara es SÓLO el efecto del
          // redondeo sobre el lado del precio.
          for (const oi of [+5, -5]) {
            const a = oiPriceCell({ oiChange24hPct: oi, priceChange24hPct: chg, atrPct: pctR, primaryTf: tf });
            const b = oiPriceCell({ oiChange24hPct: oi, priceChange24hPct: chg, atrPct: pctE, primaryTf: tf });
            cellDiff.total++;
            if (a.cell !== b.cell) cellDiff.differ++;
          }
        }
      }

      // A3 — ¿muerden los topes absolutos? Se compara el valor CRUDO contra los límites,
      // NO contra lo que devuelve `dynamicNearLevelPct`: esa función redondea a 2 decimales
      // al final, así que su salida difiere del crudo casi siempre y contar esa diferencia
      // como "recorte" daría un 100 % espurio (lo daba: 55+45, 45+55, 43+57…).
      const raw = 1.5 * pctE;
      const maxPct = { '1h': 2, '4h': 4, '1D': 10, '1W': 25 }[tf] ?? 3;
      floorHit[tf].n++;
      if (raw < 0.5) floorHit[tf].floor++;
      if (raw > maxPct) floorHit[tf].ceil++;
    }

    const calmCut = [...atrPctAll].sort((a, b) => a - b)[Math.floor(atrPctAll.length * 0.1)];
    for (const p of atrPctAll) {
      if (p <= calmCut) {
        floorHit[tf].calmN++;
        if (1.5 * p < 0.5) floorHit[tf].calmFloor++;
      }
    }

    const lastAtr = byIdx.get(cs.length - 1) ?? median([...byIdx.values()]);
    console.log(`  ${`${coin}/${tf}`.padEnd(12)}${fmt(lastAtr, 2).padStart(12)}`
      + `${`${fmt(median(errs), 4)}%`.padStart(10)}`
      + `${fmt(priceBandPct((parseFloat(lastAtr.toFixed(2)) / cs.at(-1).close) * 100, tf), 4).padStart(12)}`
      + `${fmt(priceBandPct((lastAtr / cs.at(-1).close) * 100, tf), 4).padStart(14)}`
      + `${fmt(median(dBand), 5).padStart(14)}`);
  }
}

console.log(`\nA2 · ¿CAMBIA ALGUNA CELDA del eje OI×precio? (TF 4h, ambos signos del OI)`);
console.log(`  ${cellDiff.differ} de ${cellDiff.total} evaluaciones difieren `
  + `= ${(cellDiff.differ / cellDiff.total * 100).toFixed(3)} %`);

console.log('\nA3 · ¿MUERDEN LOS TOPES ABSOLUTOS de `dynamicNearLevelPct` (suelo 0,5 % / techo por TF)?');
console.log(`  ${'TF'.padEnd(6)}${'n'.padStart(7)}${'suelo'.padStart(10)}${'techo'.padStart(10)}`
  + `${'suelo en el decil MÁS TRANQUILO'.padStart(34)}`);
for (const [tf, f] of Object.entries(floorHit)) {
  console.log(`  ${tf.padEnd(6)}${String(f.n).padStart(7)}`
    + `${`${(f.floor / f.n * 100).toFixed(1)}%`.padStart(10)}`
    + `${`${(f.ceil / f.n * 100).toFixed(1)}%`.padStart(10)}`
    + `${`${f.calmN ? (f.calmFloor / f.calmN * 100).toFixed(1) : '—'}%  (n=${f.calmN})`.padStart(34)}`);
}
