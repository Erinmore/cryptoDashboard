/**
 * auditDvolRegime.mjs — ¿informa el DVOL de BTC sobre el activo analizado?
 *
 * MOTIVACIÓN (2026-07-29). La auditoría previa al despliegue de v9_0 encontró que en un
 * análisis de SOL viajaban `volatility.btc_dvol` y `eth_dvol` al modelo mientras la sección F3
 * del prompt estaba EXCLUIDA — dato huérfano, sin ninguna regla que lo interprete. Se podó,
 * con la nota de que darle regla exigía medir primero su distribución. Esto lo mide.
 *
 * LA PREGUNTA, en tres partes:
 *
 *  1. ¿Discriminan los cuatro buckets de `classifyDvol` (panic >80 / elevated 60-80 /
 *     normal 40-60 / complacent <40), o hay ramas muertas? Es el mismo control que destapó el
 *     F&G inerte al 87,8 % y el `cvd_strength=strong` al 0 %.
 *  2. ¿Sigue el DVOL de BTC a la volatilidad REALIZADA del activo? Si la implícita de BTC no
 *     se relaciona con el ATR% de SOL, no hay mecanismo y no hay regla que escribir.
 *  3. ¿Cambia la TASA DE OPORTUNIDAD del activo según el régimen de DVOL? Esta es la que
 *     decide: si un instante en `panic` ofrece movimiento operable con la misma frecuencia que
 *     uno en `complacent`, el DVOL no informa la decisión y debe seguir podado.
 *
 * MÉTODO. Anclajes cada vela de 4h (el TF de producción) sobre 365 días. Para cada uno se
 * toma el régimen de DVOL de ESE día (dato del cierre anterior, sin lookahead) y se mide el
 * recorrido de las 24h siguientes con el par ya calibrado en `auditOpportunityThresholds.mjs`:
 * OFRECE oportunidad si alcanza 2×ATR en algún sentido ANTES de 1×ATR en contra. Si TP y stop
 * caen en la misma vela, gana el adverso (convención conservadora de `evaluateSetupBarrier`).
 *
 * SOLO LECTURA: Binance y Deribit públicos, sin auth. No toca BBDD ni producción.
 *
 * Uso:  node scripts/auditDvolRegime.mjs            # SOL, ETH y BTC
 *       COINS=SOL DAYS=365 node scripts/auditDvolRegime.mjs
 */

import { calculateATRSeries } from '../src/utils/indicators.js';
import { wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,ETH,BTC').split(',').map((s) => s.trim());
const DAYS = Number(process.env.DAYS) || 365;
const TARGET_K = 2;    // múltiplos ya calibrados para el horizonte de 24h
const ADVERSE_K = 1;
const FWD_CANDLES = 6; // 24h en velas de 4h

const pct = (n, t) => (t === 0 ? '   —  ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const verdict = (p) => (p < 5 ? ' ← RAMA MUERTA' : p >= 45 && p <= 55 ? ' ← MONEDA AL AIRE' : '');

/** Réplica de `classifyDvol` (deribitService). Se copia para poder aplicarla a un histórico. */
const classifyDvol = (v) => (v > 80 ? 'panic' : v > 60 ? 'elevated' : v > 40 ? 'normal' : 'complacent');

/** Klines 4h paginadas: Binance sirve 1000 por llamada (~166 días en 4h). */
async function klines4h(coin, days) {
  const out = [];
  let start = Date.now() - days * 86400000;
  for (let page = 0; page < 8; page++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=4h`
      + `&startTime=${Math.floor(start)}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance ${coin}: HTTP ${r.status}`);
    const j = await r.json();
    if (!j.length) break;
    for (const x of j) out.push({ t: x[0], high: +x[2], low: +x[3], close: +x[4] });
    if (j.length < 1000) break;
    start = j.at(-1)[0] + 1;
    await new Promise((res) => setTimeout(res, 250));
  }
  return out;
}

/** DVOL diario de BTC. Clave: fecha YYYY-MM-DD del cierre de ese día. */
async function dvolDaily(days) {
  const now = Date.now();
  const url = 'https://www.deribit.com/api/v2/public/get_volatility_index_data'
    + `?currency=BTC&start_timestamp=${now - days * 86400000}&end_timestamp=${now}&resolution=86400`;
  const r = await fetch(url);
  const j = await r.json();
  const map = new Map();
  for (const row of j?.result?.data ?? []) {
    // row = [timestamp, open, high, low, close]
    map.set(new Date(row[0]).toISOString().slice(0, 10), row[4]);
  }
  return map;
}

/**
 * ¿Ofreció el mercado un movimiento operable en las 24h siguientes al ancla?
 * Devuelve 'up' | 'down' | null. Sin dirección propia: solo si HUBO algo que operar.
 */
function offered(candles, i, atrPct) {
  const entry = candles[i].close;
  if (!(atrPct > 0) || !(entry > 0)) return null;
  const tgt = (TARGET_K * atrPct) / 100 * entry;
  const adv = (ADVERSE_K * atrPct) / 100 * entry;
  for (let k = i + 1; k <= i + FWD_CANDLES && k < candles.length; k++) {
    const { high, low } = candles[k];
    const upHit = high - entry >= tgt, dnHit = entry - low >= tgt;
    const upAdv = entry - low >= adv, dnAdv = high - entry >= adv;
    // Convención conservadora: si el objetivo y el adverso caen en la MISMA vela, gana el
    // adverso (no es resoluble con velas de 4h y así no se inventa un acierto).
    if (upHit && !upAdv) return 'up';
    if (dnHit && !dnAdv) return 'down';
    if (upAdv && dnAdv) return null;   // barrida en ambos sentidos: latigazo, no oportunidad
    if (upAdv) return null;            // el adverso del alza llegó antes
    if (dnAdv) return null;
  }
  return null;
}

async function auditCoin(coin, dvol) {
  console.log(`\n${'═'.repeat(78)}\n${coin} — ${DAYS} días\n${'═'.repeat(78)}`);
  const k = await klines4h(coin, DAYS);
  const atrByIdx = new Map((calculateATRSeries(k, 14) ?? []).map((e) => [e.idx, e.atr]));

  const rows = [];
  for (let i = 14; i < k.length - FWD_CANDLES; i++) {
    const atr = atrByIdx.get(i);
    if (!Number.isFinite(atr) || !(k[i].close > 0)) continue;
    const atrPct = (atr / k[i].close) * 100;
    // Régimen del DÍA ANTERIOR al ancla: el DVOL del día en curso no está cerrado.
    const day = new Date(k[i].t - 86400000).toISOString().slice(0, 10);
    const v = dvol.get(day);
    if (!Number.isFinite(v)) continue;
    rows.push({ atrPct, regime: classifyDvol(v), dvol: v, off: offered(k, i, atrPct) });
  }
  if (!rows.length) { console.log('  sin anclajes'); return null; }
  const n = rows.length;

  console.log(`\n  n=${n} anclajes de 4h con DVOL disponible\n`);
  console.log('  régimen        n     %      ATR% medio   ofrece oport.   IC95        lift');
  const baseOff = rows.filter((r) => r.off).length / n * 100;
  const out = { coin, n, baseOff };
  for (const g of ['complacent', 'normal', 'elevated', 'panic']) {
    const sel = rows.filter((r) => r.regime === g);
    if (!sel.length) { console.log(`  ${g.padEnd(12)}   0   ${pct(0, n)}        —            —`); continue; }
    const share = (sel.length / n) * 100;
    const atrAvg = sel.reduce((a, r) => a + r.atrPct, 0) / sel.length;
    const offN = sel.filter((r) => r.off).length;
    const offPct = (offN / sel.length) * 100;
    // IC sobre anclajes NO solapados (1 de cada 6): la ventana futura de 24h se pisa.
    const indep = sel.filter((_, idx) => idx % FWD_CANDLES === 0);
    const ci = wilsonInterval(indep.filter((r) => r.off).length, indep.length);
    console.log(`  ${g.padEnd(12)} ${String(sel.length).padStart(4)}  ${pct(sel.length, n)}`
      + `      ${atrAvg.toFixed(2).padStart(5)}      ${offPct.toFixed(1).padStart(5)}%`
      + `      [${String(ci.low).padStart(4)}-${String(ci.high).padStart(4)}]`
      + `   ${((offPct - baseOff) >= 0 ? '+' : '') + (offPct - baseOff).toFixed(1).padStart(5)}`
      + verdict(share));
    out[g] = { share, atrAvg, offPct, lift: offPct - baseOff, n: sel.length };
  }
  console.log(`\n  tasa base del activo: ${baseOff.toFixed(1)}% ofrece oportunidad`);
  const dv = rows.map((r) => r.dvol).sort((a, b) => a - b);
  const q = (p) => dv[Math.floor(p * (dv.length - 1))].toFixed(1);
  console.log(`  DVOL BTC: min ${q(0)} · p25 ${q(0.25)} · mediana ${q(0.5)} · p75 ${q(0.75)} · max ${q(1)}`);
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(`\nDVOL DE BTC COMO CONTEXTO DE MERCADO — ¿informa, o es dato huérfano?`);
console.log('Regla: ninguna regla nueva sin ver antes la distribución y el efecto.');

const dvol = await dvolDaily(DAYS);
console.log(`\nDVOL diario de BTC: ${dvol.size} días`);

const res = [];
for (const c of COINS) {
  try { const r = await auditCoin(c, dvol); if (r) res.push(r); }
  catch (e) { console.log(`  ${c}: ${e.message}`); }
}

console.log(`\n${'═'.repeat(78)}\nRESUMEN — lift de la tasa de oportunidad por régimen (puntos)\n${'═'.repeat(78)}`);
console.log('  moneda   base    complacent   normal   elevated   panic');
for (const r of res) {
  const f = (g) => (r[g] ? `${(r[g].lift >= 0 ? '+' : '') + r[g].lift.toFixed(1)}`.padStart(8) : '     —  ');
  console.log(`  ${r.coin.padEnd(7)} ${r.baseOff.toFixed(1).padStart(5)}%${f('complacent')}${f('normal')}${f('elevated')}${f('panic')}`);
}
console.log('\n  Para que merezca una regla: buckets no muertos, lift consistente entre monedas,');
console.log('  y una lectura mecánica que explique el signo. Si no, se queda podado.\n');
