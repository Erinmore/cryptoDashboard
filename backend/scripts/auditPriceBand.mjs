/**
 * auditPriceBand.mjs — ¿es la banda muerta de precio del eje OI×precio la que está
 * silenciando el Derivatives Score?
 *
 * MOTIVACIÓN (2026-07-30, revisión temprana del punto cero 5). Los dos primeros análisis de
 * `v9_0` salieron con `oi_price_cell: "no_signal"`. El segundo es el interesante: el OI se
 * expandió un 1,68 % —fuera de su banda muerta, o sea eje vivo— pero el precio solo se movió
 * un 0,81 % en 24h, DENTRO de la banda de precio (0,5 × ATR% × √6 ≈ 1,6 %). Con `volume=-1` y
 * `structure=-1` ya puestos, el sistema quedó a UNA celda de su primer `Vender`.
 *
 * LA PREGUNTA. La banda está medida (deja fuera el ~59 % de los anclajes, consistente en las
 * tres monedas), así que no es degenerada. Pero eso solo dice que discrimina, no que el corte
 * esté en el sitio correcto. Lo que hay que ver es la CURVA: al aflojarla se gana cobertura
 * —eso es trivial— y la pregunta real es si el efecto que justificaba las celdas SOBREVIVE.
 *
 * TRAMPA QUE ESTE SCRIPT EVITA. Medir solo cobertura llevaría a aflojar hasta que el score
 * dispare "lo bastante", que es optimizar la métrica en vez del criterio. Por eso cada
 * candidato se evalúa con el CONTROL DE MOMENTUM que ya corrigió la calibración original: el
 * lift de cada celda se mide contra la tasa base DEL GRUPO con el mismo signo de precio, no
 * contra la global. Si al aflojar la banda el lift se derrumba, el corte ancho está metiendo
 * ruido aunque las cifras de cobertura mejoren.
 *
 * Ojo con la circularidad: al cambiar la banda cambian también los grupos (el grupo "precio↑"
 * lo define la propia banda). Es lo correcto — la pregunta es si el efecto del OI se sostiene
 * cuando el umbral de precio es más laxo, y eso exige redefinir el grupo en cada candidato.
 *
 * SOLO LECTURA: Binance y Coinalyze, sin tocar BBDD ni producción. NO propone aplicar nada.
 *
 * Uso:  node scripts/auditPriceBand.mjs
 *       COINS=SOL node scripts/auditPriceBand.mjs
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateATRSeries } from '../src/utils/indicators.js';
import { wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const DAYS = 90;                 // límite de Coinalyze para el OI
const LOOKBACK = 6;              // 24h en velas de 4h
const SQRTW = Math.sqrt(LOOKBACK);
const OI_BAND = 1.0;             // ±1 %, en producción (gating.js)
const FWD_BAND = 0.5;            // banda del movimiento FUTURO, fija en todos los candidatos
const CANDIDATES = [0.25, 0.35, 0.50, 0.75, 1.00];
// Por debajo de esto la celda NO se reporta como evidencia. Sin la guarda, la fila de 1,00×
// salía con n=3-4 y su lift (+17,0 / -20,8 = 1 de 4 y 0 de 3) se leía junto a filas de n=42
// como si fueran comparables. Es el error que este script vino a evitar en el prompt.
const MIN_N = 15;

const here = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = readFileSync(path.join(here, '../../.env'), 'utf8').match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();
const pct = (n, t) => (t === 0 ? '  —  ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);

async function coinalyzeOi(coin) {
  const to = Math.floor(Date.now() / 1000), from = to - DAYS * 86400;
  const url = `https://api.coinalyze.net/v1/open-interest-history?symbols=${coin}USDT_PERP.A`
    + `&interval=4hour&from=${from}&to=${to}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Coinalyze OI: HTTP ${r.status}`);
  return (await r.json())?.[0]?.history ?? [];
}

async function klines(coin) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=4h&limit=1000`);
  if (!r.ok) throw new Error(`Binance: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: Math.floor(x[0] / 1000), high: +x[2], low: +x[3], close: +x[4],
  }));
}

async function auditCoin(coin) {
  console.log(`\n${'═'.repeat(78)}\n${coin} — ${DAYS} días\n${'═'.repeat(78)}`);
  const [k, oiHist] = await Promise.all([klines(coin), coinalyzeOi(coin)]);
  const atrByIdx = new Map((calculateATRSeries(k, 14) ?? []).map((e) => [e.idx, e.atr]));
  const closeByT = new Map(k.map((c) => [c.t, c.close]));
  const atrPctByT = new Map();
  k.forEach((c, i) => {
    const a = atrByIdx.get(i);
    if (Number.isFinite(a) && c.close > 0) atrPctByT.set(c.t, (a / c.close) * 100);
  });

  // Anclajes sin lookahead: OI y precio de las 24h PASADAS, movimiento de las 24h SIGUIENTES.
  const rows = [];
  for (let i = LOOKBACK; i < oiHist.length; i++) {
    const t = oiHist[i].t, tPrev = oiHist[i - LOOKBACK].t;
    const oiPrev = oiHist[i - LOOKBACK].c, oiNow = oiHist[i].c;
    const pxNow = closeByT.get(t), pxPrev = closeByT.get(tPrev), atrPct = atrPctByT.get(t);
    if (!(oiPrev > 0) || !Number.isFinite(pxNow) || !Number.isFinite(pxPrev) || !(atrPct > 0)) continue;
    const pxFwd = closeByT.get(t + LOOKBACK * 4 * 3600);
    rows.push({
      oiChange: ((oiNow - oiPrev) / oiPrev) * 100,
      pxAtr:    ((pxNow - pxPrev) / pxPrev) * 100 / (atrPct * SQRTW),
      fwdAtr:   Number.isFinite(pxFwd) ? ((pxFwd - pxNow) / pxNow) * 100 / (atrPct * SQRTW) : null,
    });
  }
  const n = rows.length;
  const withFwd = rows.filter((r) => Number.isFinite(r.fwdAtr));
  const oiLive = rows.filter((r) => Math.abs(r.oiChange) > OI_BAND).length;

  console.log(`\n  n=${n} anclajes · eje de OI vivo (|ΔOI|>${OI_BAND}%): ${pct(oiLive, n)}\n`);
  // Dos cifras distintas: el eje silenciado y la señal REALMENTE perdida. Si el precio
  // saliera de banda, solo DOS de las cuatro celdas puntúan (OI↑px↑ y OI↓px↑), así que
  // "silencia el 55 %" exagera la pérdida — la señal perdida es la que habría CAÍDO EN UNA
  // CELDA QUE PUNTÚA, y se estima con la proporción observada de px↑ entre los que sí salen.
  console.log('  ── FUGA de la banda de precio ──\n');
  console.log('    banda   eje vivo silenciado   señal que habría puntuado');
  for (const b of CANDIDATES) {
    const live = rows.filter((r) => Math.abs(r.oiChange) > OI_BAND);
    const lost = live.filter((r) => Math.abs(r.pxAtr) <= b);
    const out = live.filter((r) => Math.abs(r.pxAtr) > b);
    // De los que SÍ salen de banda, ¿qué fracción cae en una celda que puntúa? (px↑, ambos OI)
    const scoreShare = out.length ? out.filter((r) => r.pxAtr > b).length / out.length : 0;
    console.log(`    ${b.toFixed(2)}×      ${pct(lost.length, live.length)}`
      + `              ~${(lost.length * scoreShare / live.length * 100).toFixed(1)}%`);
  }

  console.log('\n  ── ¿SOBREVIVE EL EFECTO? lift vs la base DEL GRUPO de precio ──\n');
  console.log('   banda   celda            n     cobertura   continúa   lift');
  const out = { coin, n };
  for (const b of CANDIDATES) {
    const grp = (sign) => withFwd.filter((r) => (sign > 0 ? r.pxAtr > b : r.pxAtr < -b));
    for (const [label, oSign, pSign, dir] of [
      ['OI↑ px↑ (+1)', 1, 1, 1],
      ['OI↓ px↑ (-1)', -1, 1, -1],
    ]) {
      const g = grp(pSign);
      if (g.length < 10) { console.log(`   ${b.toFixed(2)}×   ${label}   grupo n=${g.length}: insuficiente`); continue; }
      const gHit = g.filter((r) => (dir > 0 ? r.fwdAtr > FWD_BAND : r.fwdAtr < -FWD_BAND)).length;
      const base = (gHit / g.length) * 100;
      const sel = g.filter((r) => (oSign > 0 ? r.oiChange > OI_BAND : r.oiChange < -OI_BAND));
      if (!sel.length) { console.log(`   ${b.toFixed(2)}×   ${label}   celda vacía`); continue; }
      const hit = sel.filter((r) => (dir > 0 ? r.fwdAtr > FWD_BAND : r.fwdAtr < -FWD_BAND)).length;
      const rate = (hit / sel.length) * 100;
      const ci = wilsonInterval(hit, sel.length);
      const thin = sel.length < MIN_N;
      console.log(`   ${b.toFixed(2)}×   ${label} ${String(sel.length).padStart(4)}   ${pct(sel.length, withFwd.length)}`
        + `     ${rate.toFixed(1).padStart(5)}%   ${sig(rate - base)}`
        + `   IC[${String(ci.low).padStart(4)}-${String(ci.high).padStart(4)}]`
        + (thin ? `  ⚠ n<${MIN_N}: NO es evidencia` : ''));
      out[`${b}|${oSign}`] = { lift: rate - base, cov: (sel.length / withFwd.length) * 100, n: sel.length, thin };
    }
    console.log('');
  }
  return out;
}

if (!API_KEY) { console.error('Falta COINALYZE_API_KEY.'); process.exit(1); }
console.log('\nBANDA DE PRECIO DEL EJE OI×PRECIO — ¿está el corte en su sitio?');
console.log('Aflojar SIEMPRE gana cobertura. La pregunta es si el lift sobrevive.');

const res = [];
for (const c of COINS) {
  try { const r = await auditCoin(c); if (r) res.push(r); }
  catch (e) { console.log(`  ${c}: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n${'═'.repeat(78)}\nRESUMEN — lift de cada celda por banda (puntos sobre la base del grupo)\n${'═'.repeat(78)}`);
console.log('  banda    ' + res.map((r) => `${r.coin} OI↑ / OI↓`).join('   '));
for (const b of CANDIDATES) {
  const cells = res.map((r) => {
    const a = r[`${b}|1`], d = r[`${b}|-1`];
    const f = (c) => (!c ? '   —  ' : c.thin ? '  n<15' : sig(c.lift));
    return `${f(a)} /${f(d)}`;
  });
  console.log(`  ${b.toFixed(2)}×   ` + cells.join('  '));
}
console.log('\n  Producción usa 0.50×. Aflojar solo se justifica si el lift AGUANTA y el efecto');
console.log('  sigue replicando entre monedas. Si se derrumba, el corte ancho mete ruido.\n');
