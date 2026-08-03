#!/usr/bin/env node
/**
 * auditSrTolerance.mjs — U2: ¿es coherente agrupar niveles S/R con un % ABSOLUTO?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA SOSPECHA, Y POR QUÉ ES DISTINTA DE "no está medido"
 *
 * `SR_TOLERANCE_PCT = 0.005` decide qué pivotes se agrupan en un mismo nivel:
 *     |ancla − precio| / ancla <= 0,005
 * Es un porcentaje ABSOLUTO, igual para BTC que para SOL.
 *
 * Pero `dynamicNearLevelPct` —el umbral que decide si el precio está CERCA de un nivel— se
 * normalizó por ATR en T5, precisamente porque un % fijo no vale entre activos ni entre TFs.
 * O sea que hoy **los niveles se CONSTRUYEN con un criterio absoluto y luego su cercanía se
 * JUZGA con uno normalizado**: las dos mitades del mismo razonamiento con reglas distintas.
 *
 * Y no es telemetría: esos niveles entran en la pata S/R del **VETO** (`computeVetos`, que
 * degrada a `Esperar` sin apelación) y en la contradicción `price_near_key_level`. Es el único
 * de los cinco umbrales de indicador sin medir que **decide algo**.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIÓN FIRMADA ANTES DE EJECUTAR
 *
 * En unidades de ATR, la tolerancia vale `0,5 / ATR%`. Con ATR% ≈ 1,1 en SOL y ≈ 0,5 en BTC,
 * eso son ~0,45 ATR contra ~1,0 ATR: **BTC agrupa el doble de agresivamente en unidades de
 * volatilidad**. Consecuencias esperadas, en este orden:
 *
 *   P1 · La tolerancia EN ATR difiere sistemáticamente entre monedas (es aritmética: se
 *        cumplirá salvo que los ATR% coincidan).
 *   P2 · BTC debería dar MENOS niveles y con MÁS toques cada uno; SOL más y más débiles.
 *   P3 · Y por tanto la fracción que pasa el filtro del veto (`touches >= 3`) debería diferir
 *        entre monedas — que es donde el problema deja de ser estético.
 *
 * **Si P3 no se cumple, el umbral se cierra como "absoluto pero inocuo"** y se deja en paz,
 * igual que se cerraron el redondeo del ATR y los topes de `dynamicNearLevelPct`.
 *
 * CONTRAFACTUAL: la misma función REAL con la tolerancia normalizada (`k × ATR%`). No se
 * reimplementa `calculateSupportResistance` — ya acepta `tolerancePct` como 4º argumento.
 * `k = 0,5` es el equivalente aproximado del 0,5 % actual con un ATR% típico de ~1 %.
 *
 * SOLO LECTURA. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditSrTolerance.mjs
 *       COINS=SOL TFS=4h DAYS=180 node scripts/auditSrTolerance.mjs
 */

import { calculateATR, calculateSupportResistance } from '../src/utils/indicators.js';
import { SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT } from '../src/config/constants.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const TFS = (process.env.TFS ?? '1h,4h,1D').split(',').map((s) => s.trim());
const DAYS = Number(process.env.DAYS ?? 180);
const PASO = 6;                       // una ventana de cada 6 velas: menos solape entre ventanas
const KS = [0.25, 0.5, 0.75, 1.0];    // tolerancia normalizada = k × ATR%
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d' };
const VELAS = { '1h': 168, '4h': 180, '1D': 90 };   // ventanas de producción (TF_LIMIT)

async function klines(coin, interval, dias) {
  const out = [];
  let end = Date.now();
  for (let g = 0; g < 12; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=${interval}&limit=1000&endTime=${end}`);
    if (!r.ok) throw new Error(`Binance ${coin}/${interval}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
    }));
    if (!b.length) break;
    out.unshift(...b);
    if (b.length < 1000) break;
    end = b[0].t - 1;
    const span = (out.at(-1).t - out[0].t) / 86400e3;
    if (span >= dias) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

const media = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f1 = (x) => (x == null ? '  — ' : x.toFixed(1));
const f2 = (x) => (x == null ? '  — ' : x.toFixed(2));

console.log('═'.repeat(96));
console.log('U2 · TOLERANCIA DE AGRUPAMIENTO S/R — ¿un % absoluto es coherente entre activos?');
console.log(`${DAYS} d · TFs ${TFS.join('/')} · actual SR_TOLERANCE_PCT=${SR_TOLERANCE_PCT}`
  + ` · lookback ${SR_LOOKBACK} · minTouches ${SR_MIN_TOUCHES}`);
console.log('PREDICCIÓN: P1 la tolerancia en ATR difiere · P2 BTC menos niveles y más fuertes ·');
console.log('            P3 la fracción con touches>=3 (la que usa el VETO) difiere entre monedas.');
console.log('            Si P3 NO se cumple → "absoluto pero inocuo", se cierra y no se toca.');
console.log('═'.repeat(96));

const resumen = [];

for (const tf of TFS) {
  console.log(`\n${'─'.repeat(96)}\nTF ${tf}`);
  console.log('  moneda   ATR%   tol/ATR   niveles   touches medios   %(touches>=3) ← filtro del VETO');
  for (const coin of COINS) {
    let k4;
    try { k4 = await klines(coin, BINANCE_TF[tf], DAYS + 30); } catch (e) { console.log(`  ${coin}: ${e.message}`); continue; }
    const win = VELAS[tf];
    if (k4.length < win + 20) { console.log(`  ${coin}: sin velas suficientes`); continue; }

    const acc = { atrPct: [], tolAtr: [], n: [], touches: [], fuertes: [], total: [] };
    const alt = Object.fromEntries(KS.map((k) => [k, { n: [], fuertes: [], total: [] }]));

    for (let i = win; i < k4.length; i += PASO) {
      const w = k4.slice(i - win, i);
      const price = w.at(-1).close;
      const atr = calculateATR(w);
      if (!Number.isFinite(atr) || !(price > 0)) continue;
      const atrPct = (atr / price) * 100;
      acc.atrPct.push(atrPct);
      // La tolerancia, expresada en unidades de ATR: es la comparación que importa.
      acc.tolAtr.push((SR_TOLERANCE_PCT * 100) / atrPct);

      const sr = calculateSupportResistance(w);
      const niveles = [...(sr?.supports ?? []), ...(sr?.resistances ?? [])];
      acc.n.push(niveles.length);
      for (const l of niveles) acc.touches.push(l.touches ?? 0);
      acc.fuertes.push(niveles.filter((l) => (l.touches ?? 0) >= 3).length);
      acc.total.push(niveles.length);

      // Contrafactual: misma función, tolerancia normalizada por ATR.
      for (const k of KS) {
        const s2 = calculateSupportResistance(w, SR_LOOKBACK, SR_MIN_TOUCHES, (k * atrPct) / 100);
        const n2 = [...(s2?.supports ?? []), ...(s2?.resistances ?? [])];
        alt[k].n.push(n2.length);
        alt[k].fuertes.push(n2.filter((l) => (l.touches ?? 0) >= 3).length);
        alt[k].total.push(n2.length);
      }
    }
    if (!acc.n.length) continue;

    const pctFuertes = (o) => {
      const t = o.total.reduce((a, b) => a + b, 0);
      return t ? (o.fuertes.reduce((a, b) => a + b, 0) / t) * 100 : null;
    };
    const fila = {
      tf, coin,
      atrPct: media(acc.atrPct), tolAtr: media(acc.tolAtr),
      niveles: media(acc.n), touches: media(acc.touches), fuertes: pctFuertes(acc),
      alt: Object.fromEntries(KS.map((k) => [k, { niveles: media(alt[k].n), fuertes: pctFuertes(alt[k]) }])),
    };
    resumen.push(fila);
    console.log(`  ${coin.padEnd(6)} ${f2(fila.atrPct).padStart(6)}  ${f2(fila.tolAtr).padStart(7)}`
      + `   ${f1(fila.niveles).padStart(6)}   ${f1(fila.touches).padStart(12)}`
      + `   ${f1(fila.fuertes).padStart(12)}%`);
  }
}

// ─── Veredicto sobre las tres predicciones ───────────────────────────────────
console.log(`\n${'═'.repeat(96)}\nVEREDICTO`);
for (const tf of TFS) {
  const filas = resumen.filter((r) => r.tf === tf);
  if (filas.length < 2) continue;
  const rango = (sel) => {
    const v = filas.map(sel).filter(Number.isFinite);
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  };
  const [tMin, tMax] = rango((r) => r.tolAtr) ?? [null, null];
  const [fMin, fMax] = rango((r) => r.fuertes) ?? [null, null];
  console.log(`\n  ${tf}`);
  console.log(`    P1 tolerancia en ATR: ${f2(tMin)}–${f2(tMax)} ATR`
    + `  → ×${f2(tMax / tMin)} entre la moneda que más agrupa y la que menos`);
  console.log(`    P3 %(touches>=3) —el filtro del VETO—: ${f1(fMin)}–${f1(fMax)} %`
    + `  → ${f1(fMax - fMin)} pt de dispersión`);
  // Contrafactual: ¿converge con tolerancia normalizada?
  for (const k of KS) {
    const v = filas.map((r) => r.alt[k].fuertes).filter(Number.isFinite);
    if (v.length < 2) continue;
    console.log(`       k=${k} (tol = ${k}×ATR%): ${f1(Math.min(...v))}–${f1(Math.max(...v))} %`
      + `  → ${f1(Math.max(...v) - Math.min(...v))} pt`);
  }
}
console.log('\n  LECTURA: si la dispersión de P3 baja claramente con tolerancia normalizada, el');
console.log('  criterio absoluto está introduciendo diferencias entre monedas que no son del');
console.log('  mercado. Si no baja, el umbral es absoluto pero INOCUO → se cierra y no se toca.');
