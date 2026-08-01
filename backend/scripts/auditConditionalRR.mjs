/**
 * auditConditionalRR.mjs — ¿mide algo el umbral `conditional_low_rr` (<1)?
 *
 * POR QUÉ. `analysisValidator` avisa cuando un `conditional_setup` tiene R:R < 1. Ese 1 es
 * una constante de corte que nunca se midió, y la regla del proyecto es que ninguna se
 * escribe sin ver antes la distribución de la magnitud que bucketiza. La 8ª medición
 * (2026-08-01) trajo un condicional con R:R **exactamente 1,00** — pasó sin marca justo en
 * el borde—, así que la pregunta dejó de ser teórica.
 *
 * QUÉ PREGUNTA. No "¿cuánto vale un R:R alto?" (trivial: más recompensa por unidad de
 * riesgo) sino la que el aviso presupone: **¿existe un R:R por debajo del cual la geometría
 * rinde peor?** Si la expectativa es plana en R:R, el aviso no informa del resultado — solo
 * describe la forma, y para eso ya está `breakeven_win_rate_pct`.
 *
 * PREDICCIÓN DECLARADA ANTES DE EJECUTAR (para que el resultado pueda refutarla):
 *   Sobre un paseo casi sin deriva, P(tocar TP antes que stop) ≈ riesgo/(riesgo+recompensa),
 *   así que el acierto CAE exactamente lo que sube el premio y la **expectativa sale ≈ 0 a
 *   cualquier R:R**. `auditShadowBaseline` ya midió +0,004R para las 7 formas reales, que es
 *   coherente. Si esto se confirma, el corte en 1 no separa geometrías buenas de malas: no
 *   hay nada que separar, y el número que sí varía —y de forma conocida— es el equilibrio,
 *   1/(1+R:R). Lo que REFUTARÍA la predicción: una expectativa monótona en R:R con IC que
 *   no se solapen, o un desplome por debajo de algún valor.
 *
 * CÓMO. Mismo arnés que `auditShadowBaseline.mjs`: geometrías sintéticas aplicadas en cada
 * anclaje de 4h del histórico y evaluadas con `evaluateShadowTrade` + `summarizeShadowTrades`
 * — las funciones REALES, para que el número sea comparable con el de producción.
 *
 * DOS BARRIDOS, porque "R:R" es un cociente y se puede mover por arriba o por abajo:
 *   A · riesgo FIJO (stop a 1×ATR) y objetivo variable  → R:R por el numerador
 *   B · objetivo FIJO (2×ATR) y stop variable           → R:R por el denominador
 * Si los dos dan la misma curva, lo que manda es el cociente. Si discrepan, lo que manda es
 * la DISTANCIA absoluta a las barreras y "R:R" sería la variable equivocada.
 *
 * Todo en múltiplos de ATR (no en %) para que las tres monedas sean comparables y para no
 * introducir una constante de escala nueva. Entrada a distancia fija —la mediana de los
 * condicionales reales— porque con la entrada en el precio todo se llenaría al instante y
 * el trigger dejaría de parecerse al de producción.
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditConditionalRR.mjs
 *       COINS=SOL,BTC,ETH DAYS=90 node scripts/auditConditionalRR.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';
import { summarizeShadowTrades } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const ATR_WINDOW = 19;              // = ATR_PERIOD+5, igual que `atr_pct_at_analysis`
const H4_MS = 4 * 3600 * 1000;
const VIGENCIA = 6;                 // velas 4h = 24h, la vigencia dominante en producción

/**
 * Distancia de la ENTRADA al precio, en múltiplos de ATR, medida sobre los 8 condicionales
 * reales del periodo (mediana ≈ 0,75×ATR en contra del sentido del trade). Se fija en vez
 * de barrerla porque aquí la variable de interés es el R:R: mover dos cosas a la vez haría
 * imposible atribuir el efecto.
 */
const ENTRY_K = process.env.ENTRY_K != null ? Number(process.env.ENTRY_K) : 0.75;

const BARRIDOS = [
  { id: 'A · riesgo fijo (stop 1×ATR)', pares: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map((rr) => ({ rr, sK: 1, tK: rr })) },
  { id: 'B · objetivo fijo (tp 2×ATR)', pares: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map((rr) => ({ rr, sK: 2 / rr, tK: 2 })) },
];

async function klines(coin, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${coin} ${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
  }));
}

/** Evalúa una geometría (en múltiplos de ATR) sobre todos los anclajes de una moneda. */
function replicar({ k4, k1, lastT, coin }, { sK, tK }) {
  const rows = [];
  for (let i = ATR_WINDOW - 1; i < k4.length; i++) {
    const w = k4.slice(i - ATR_WINDOW + 1, i + 1);
    const atr = calculateATR(w, 14);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const price = k4[i].close;
    const atrPct = parseFloat((atr / price * 100).toFixed(2));
    const tMs = k4[i].t + H4_MS;              // el "análisis" ocurre al cierre de la vela
    if (tMs + VIGENCIA * H4_MS > lastT) continue;   // vigencia que no cabe en los datos
    const candles = k1.filter((c) => c.t >= tMs && c.t <= tMs + 8 * 24 * 3600e3);
    if (!candles.length) continue;

    // Las DOS direcciones en cada anclaje: la deriva del periodo favorece a una de ellas
    // (medido en `auditPathWinRate`: la asimetría cambia de signo con la deriva), y
    // agregando las dos se cancela en vez de colarse como si fuera efecto del R:R.
    for (const dir of ['long', 'short']) {
      const sg = dir === 'long' ? 1 : -1;
      const entry = price - sg * ENTRY_K * atr;   // el gatillo está en contra del trade
      const cs = {
        direction: dir,
        entry_price: entry,
        stop_price: entry - sg * sK * atr,
        tp1_price: entry + sg * tK * atr,
        validity_candles: VIGENCIA,
        tf_execution: '4h',
      };
      const ev = evaluateShadowTrade({
        conditionalSetup: cs, candles, tMs, primaryTf: '4h', now: Date.now(),
      });
      if (!ev || ev.preserve) continue;
      rows.push({
        id: `${coin}-${i}-${dir}`, coin, primary_tf: '4h',
        timestamp: new Date(tMs).toISOString(), price_current: price,
        atr_pct_at_analysis: atrPct, conditional_setup: JSON.stringify(cs),
        cond_outcome: ev.outcome, cond_filled: ev.filled, cond_exit_price: ev.exit_price,
      });
    }
  }
  return rows;
}

// ── datos ────────────────────────────────────────────────────────────────────
const datos = [];
for (const coin of COINS) {
  const k4 = await klines(coin, '4h', 560);
  const k1raw = [];
  for (const end of [Date.now() - 2000 * 3600e3, Date.now() - 1000 * 3600e3, Date.now()]) {
    k1raw.push(...await klines(coin, '1h', 1000, end));
  }
  const k1 = k1raw.sort((a, b) => a.t - b.t).filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
  datos.push({ coin, k4, k1, lastT: k1.at(-1).t });
}

// ── reporte ──────────────────────────────────────────────────────────────────
const f = (x, d = 3) => (x == null ? '   —  ' : (x > 0 ? '+' : '') + x.toFixed(d));
console.log(`\n${'═'.repeat(94)}`);
console.log('¿MIDE ALGO EL UMBRAL `conditional_low_rr` (<1)? — expectativa por R:R');
console.log(`${COINS.join('+')} · velas 4h · vigencia ${VIGENCIA} velas (24h) · entrada a ${ENTRY_K}×ATR`);
console.log('PREDICCIÓN: expectativa PLANA y ≈0; el acierto cae lo que sube el premio.');
console.log('═'.repeat(94));

for (const barrido of BARRIDOS) {
  console.log(`\n  ${barrido.id}`);
  console.log(`  ${'R:R'.padEnd(6)}${'stop'.padEnd(7)}${'tp'.padEnd(7)}${'n'.padEnd(7)}`
    + `${'disparó'.padEnd(9)}${'acierto'.padEnd(9)}${'equil.'.padEnd(8)}${'caduc.'.padEnd(8)}EXPECTATIVA (IC95)`);
  console.log(`  ${'─'.repeat(90)}`);
  for (const p of barrido.pares) {
    const rows = datos.flatMap((d) => replicar(d, p));
    const s = summarizeShadowTrades(rows);
    const e = s.expectancy_r;
    console.log(`  ${p.rr.toFixed(2).padEnd(6)}${p.sK.toFixed(2).padEnd(7)}${p.tK.toFixed(2).padEnd(7)}`
      + `${String(e.n).padEnd(7)}${`${s.trigger_rate_pct}%`.padEnd(9)}`
      + `${(s.win_rate == null ? '—' : `${s.win_rate}%`).padEnd(9)}`
      + `${`${s.breakeven_win_rate_pct}%`.padEnd(8)}`
      + `${`${s.expired}`.padEnd(8)}`
      + `${f(e.point)}R  [${f(e.ci_low)}, ${f(e.ci_high)}]`);
  }
}

console.log(`\n  Lectura: si la columna EXPECTATIVA es plana y sus IC se solapan entre sí y con 0,`);
console.log('  el corte en R:R=1 no separa geometrías buenas de malas — la única magnitud que');
console.log('  cambia de verdad es el equilibrio, y ése ya se reporta. Si en cambio la');
console.log('  expectativa se desploma por debajo de algún R:R, ahí está el umbral MEDIDO.\n');
