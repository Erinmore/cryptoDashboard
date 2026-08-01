/**
 * auditTargetReachability.mjs — ¿es alcanzable el objetivo dentro de la vigencia declarada?
 *
 * POR QUÉ. Al medir el R:R (`auditConditionalRR.mjs`) se retiró `conditional_low_rr`: la
 * expectativa es plana en R:R, así que el corte en 1 no separaba nada. Pero la misma
 * medición dejó ver un defecto distinto y REAL: con el objetivo lejos, el shadow trade
 * CADUCA sin tocarlo el 43-50 % de las veces (a 3×ATR con vigencia de 24h) frente al 4-7 %
 * con el objetivo cerca. Un `conditional_setup` que nombra un objetivo que el mercado no
 * recorre en las velas que el propio análisis declara no es una geometría MALA — es una
 * declaración INERTE, del mismo tipo que `conditional_trigger_vague`: no dice que el trade
 * sea peor, dice que no es comprobable como se ha enunciado.
 *
 * QUÉ NO ES. No juzga calidad. La expectativa de un objetivo lejano no es peor (eso ya se
 * midió); lo que pasa es que el resultado deja de venir del objetivo declarado y pasa a
 * venir de la caducidad, o sea de donde estuviera el precio al vencer.
 *
 * EL EJE, Y POR QUÉ ÉSTE. `normalizedTriggerDistance` ya normaliza distancias por
 * **`ATR% × √velas`**, y esa normalización COLAPSÓ la curva del gatillo (24h y 48h
 * coincidiendo dentro de 0,4-6,4 pt). Aplicada aquí, la distancia al objetivo `k×ATR%` en
 * `V` velas se convierte en **`d = k/√V`**, donde el ATR se cancela: la predicción es que
 * la alcanzabilidad sea una curva de UNA sola variable, igual en las tres monedas y para
 * cualquier vigencia. **Es la hipótesis falsable de este script**: si `d` no colapsa, `d`
 * es la variable equivocada y no hay corte que escribir.
 *
 * EL CORTE, SIN INVENTARLO. El sistema YA tiene una definición medida de "movimiento
 * operable": `OPPORTUNITY_BY_HORIZON` (2×ATR a 24h = 6 velas · 4×ATR a 7d = 42 velas),
 * calibrada en 2026-07-27 para que ambos horizontes discriminen (tasas base 34,8 % y 36 %).
 * Esos dos puntos caen en **d = 2/√6 = 0,816** y **d = 4/√42 = 0,617**. Si ambos dan la
 * MISMA alcanzabilidad, ese valor es el corte **heredado de una constante ya medida**, no
 * un número nuevo. Si dan alcanzabilidades distintas, no hay anclaje y hay que decirlo en
 * vez de elegir el que convenga.
 *
 * MÉTODO. `computeFirstPassage` REAL (la misma función que puebla `path_first_passage` en
 * producción) sobre anclajes de 4h, con la ventana limitada a la vigencia. Las DOS
 * direcciones en cada anclaje y agregadas: la deriva del periodo favorece a una, y
 * mezclarlas la cancela en vez de colarla como si fuera efecto de la distancia.
 * Sin barreras: la pregunta es si el PRECIO llega, no si el trade gana — para eso está el
 * win-rate, y meter el stop aquí respondería otra cosa.
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditTargetReachability.mjs
 *       COINS=SOL DAYS=90 node scripts/auditTargetReachability.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { wilsonInterval, opportunityParamsFor } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const ATR_WINDOW = process.env.ATR_WINDOW ? Number(process.env.ATR_WINDOW) : 19;   // 19 = ATR_PERIOD+5 (`atr_pct_at_analysis`) · 180 = el de decisión (`technical[tf].atr`)
const H4_MS = 4 * 3600 * 1000;
const KS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
const VS = [6, 12, 24, 42];                  // velas 4h: 24h · 48h · 4d · 7d
const MIN_N = 30;                            // por debajo, la celda no se reporta

/** Los 7 condicionales reales con ATR persistido (el 8º aún no tiene fila de outcome). */
const REALES = [
  ['30-07 02:07', 'long', 2.83, 12], ['30-07 08:05', 'short', 2.12, 6],
  ['30-07 20:05', 'long', 2.50, 12], ['31-07 08:05', 'long', 1.69, 6],
  ['31-07 20:05', 'short', 2.86, 6], ['01-08 04:07', 'short', 4.55, 6],
  ['01-08 08:05', 'short', 4.63, 6],
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

// ── datos ────────────────────────────────────────────────────────────────────
const porCelda = new Map();   // `${coin}|${k}|${V}` → {hit, n}
const bump = (key, hit) => {
  const c = porCelda.get(key) ?? { hit: 0, n: 0 };
  c.n++; if (hit) c.hit++;
  porCelda.set(key, c);
};

for (const coin of COINS) {
  const k4 = await klines(coin, '4h', 560);
  const k1raw = [];
  for (const end of [Date.now() - 2000 * 3600e3, Date.now() - 1000 * 3600e3, Date.now()]) {
    k1raw.push(...await klines(coin, '1h', 1000, end));
  }
  const k1 = k1raw.sort((a, b) => a.t - b.t).filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
  const lastT = k1.at(-1).t;

  for (let i = ATR_WINDOW - 1; i < k4.length; i++) {
    const w = k4.slice(i - ATR_WINDOW + 1, i + 1);
    const atr = calculateATR(w, 14);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const price = k4[i].close;
    const atrPct = atr / price * 100;
    const tMs = k4[i].t + H4_MS;
    const path = k1.filter((c) => c.t >= tMs && c.t <= tMs + 42 * H4_MS);
    if (!path.length) continue;

    for (const V of VS) {
      // Cobertura: sin la vigencia entera en los datos, "no llegó" sería indistinguible de
      // "no se pudo ver" — la misma regla que el resto de scripts (y que ahora producción).
      if (tMs + V * H4_MS > lastT) continue;
      const fp = computeFirstPassage(path, price, atrPct, tMs, V * H4_MS, 3600e3, KS);
      if (!fp) continue;
      for (const k of KS) {
        // Las dos direcciones: la deriva favorece a una y agregarlas la cancela.
        bump(`${coin}|${k}|${V}`, fp.up[String(k)] != null);
        bump(`${coin}|${k}|${V}`, fp.down[String(k)] != null);
      }
    }
  }
}

// ── agregación ───────────────────────────────────────────────────────────────
const agg = (k, V, coin = null) => {
  let hit = 0, n = 0;
  for (const c of (coin ? [coin] : COINS)) {
    const x = porCelda.get(`${c}|${k}|${V}`);
    if (x) { hit += x.hit; n += x.n; }
  }
  return { hit, n, ...wilsonInterval(hit, n) };
};
const pct = (x) => (x.n < MIN_N ? '  —  ' : `${x.point.toFixed(1)}`.padStart(5));

console.log(`\n${'═'.repeat(96)}`);
console.log('¿ES ALCANZABLE EL OBJETIVO DENTRO DE LA VIGENCIA DECLARADA?');
console.log(`${COINS.join('+')} · anclajes 4h · ${porCelda.get(`${COINS[0]}|2|6`)?.n ?? 0} evaluaciones/celda por moneda`);
console.log('HIPÓTESIS: la alcanzabilidad depende solo de d = k/√V (el ATR se cancela).');
console.log('═'.repeat(96));

console.log('\n  P(el precio alcanza k×ATR dentro de V velas de 4h), %');
console.log(`  ${'k×ATR'.padEnd(8)}${VS.map((V) => `V=${V}`.padStart(8)).join('')}`);
console.log(`  ${'─'.repeat(8 + 8 * VS.length)}`);
for (const k of KS) {
  console.log(`  ${String(k).padEnd(8)}${VS.map((V) => pct(agg(k, V)).padStart(8)).join('')}`);
}

// ── el test de colapso ───────────────────────────────────────────────────────
console.log('\n  COLAPSO — las mismas celdas ordenadas por d = k/√V.');
console.log('  Si la hipótesis es cierta, d parecidas dan P parecidas AUNQUE k y V difieran.');
console.log(`  ${'d'.padEnd(8)}${'k'.padEnd(6)}${'V'.padEnd(5)}${'n'.padEnd(8)}${'P%'.padEnd(8)}IC95`);
console.log(`  ${'─'.repeat(60)}`);
const filas = [];
for (const k of KS) for (const V of VS) {
  const a = agg(k, V);
  if (a.n >= MIN_N) filas.push({ d: k / Math.sqrt(V), k, V, ...a });
}
filas.sort((a, b) => a.d - b.d);
for (const f of filas) {
  console.log(`  ${f.d.toFixed(3).padEnd(8)}${String(f.k).padEnd(6)}${String(f.V).padEnd(5)}`
    + `${String(f.n).padEnd(8)}${f.point.toFixed(1).padEnd(8)}[${f.low.toFixed(1)}-${f.high.toFixed(1)}]`);
}

// ── los dos puntos calibrados ────────────────────────────────────────────────
console.log('\n  ANCLAJE — ¿coinciden los dos puntos ya calibrados de OPPORTUNITY_BY_HORIZON?');
for (const [V, label] of [[6, '24h'], [42, '7d']]) {
  const k = opportunityParamsFor(V === 6 ? 24 : null).targetK;
  const a = agg(k, V);
  console.log(`    ${label.padEnd(5)} objetivo ${k}×ATR en ${V} velas → d=${(k / Math.sqrt(V)).toFixed(3)}`
    + `   alcanzable ${a.n >= MIN_N ? `${a.point.toFixed(1)}% [${a.low.toFixed(1)}-${a.high.toFixed(1)}]` : 'n insuficiente'}  n=${a.n}`);
}

// ── dónde caen los condicionales reales ──────────────────────────────────────
console.log('\n  LOS CONDICIONALES REALES (7 con ATR persistido) sobre el mismo eje:');
const interp = (d) => {
  const orden = [...filas].sort((a, b) => a.d - b.d);
  if (d <= orden[0].d) return orden[0].point;
  if (d >= orden.at(-1).d) return orden.at(-1).point;
  for (let i = 1; i < orden.length; i++) {
    if (d <= orden[i].d) {
      const w = (d - orden[i - 1].d) / (orden[i].d - orden[i - 1].d);
      return orden[i - 1].point + w * (orden[i].point - orden[i - 1].point);
    }
  }
  return null;
};
for (const [fecha, dir, k, V] of REALES) {
  const d = k / Math.sqrt(V);
  console.log(`    ${fecha}  ${dir.padEnd(5)} objetivo ${k.toFixed(2)}×ATR en ${String(V).padStart(2)} velas`
    + `  → d=${d.toFixed(3)}   alcanzable ≈ ${interp(d).toFixed(1)}%`);
}

// ── ¿importa el nivel del corte? ─────────────────────────────────────────────
// Si mover el corte dentro de una banda ancha no cambia a quién marca, el nivel exacto
// deja de ser una elección delicada — que es justo lo contrario del fallo T2 (ADX=25
// cayendo sobre la mediana, donde un pelo de diferencia cambiaba la respuesta).
const dParaP = (p) => {
  let lo = 0.02, hi = 3;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (interp(m) > p) lo = m; else hi = m; }
  return (lo + hi) / 2;
};
console.log('\n  ROBUSTEZ DEL NIVEL — ¿a quién marca cada corte candidato?');
for (const p of [1, 3, 5, 8, 10, 15, 20]) {
  const dc = dParaP(p);
  const marcados = REALES.filter(([, , k, V]) => k / Math.sqrt(V) >= dc);
  console.log(`    alcanzable < ${String(p).padStart(2)}%  → d ≥ ${dc.toFixed(3)}`
    + `   marca ${marcados.length}/7${marcados.length ? `: ${marcados.map((m) => m[0]).join(', ')}` : ''}`);
}

// ── tabla literal para pegar en stats.js ─────────────────────────────────────
console.log('\n  TABLA PARA `TARGET_REACHABILITY.points` (d → % alcanzable):\n');
for (const d of [0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5]) {
  console.log(`    ${d.toFixed(1)}: ${interp(d).toFixed(1)},`);
}
console.log('');
