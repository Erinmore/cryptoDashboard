/**
 * auditVolumeGuardSymmetry.mjs — la asimetría del score de volumen en BTC, cerrada.
 *
 * EL PENDIENTE. El 2026-08-01 se midió el reparto de signo de `expectedVolumeScore` (la
 * guardia C2 de volumen) y en BTC salió **11,8 % positivo / 34,2 % negativo** en una
 * muestra y **20,1 % / 29,2 %** en otra. Se atribuyó al recorte de anclajes y se dejó
 * abierto: "no se llama ni bug ni no-bug sin mirarlo mejor". Esto lo mira mejor.
 *
 * LA PREGUNTA BIEN PLANTEADA. No es "¿por qué 11,8 y no 34,2?" sino dos preguntas separadas
 * que hay que responder en orden:
 *   (1) ¿la asimetría la mete el CÓDIGO o está en los datos?
 *   (2) si está en los datos, ¿las dos muestras difieren más de lo que su propio ruido
 *       permite, o el "cambio" es ruido de estimación leído como señal?
 *
 * ANCLAS, fijadas antes de ejecutar:
 *
 *  A1 · REFLEXIÓN (ancla EXACTA, responde a la pregunta 1). Se refleja el camino del precio
 *       y el agresor (`taker_buy' = volume − taker_buy`). Bajo esa transformación el delta
 *       por vela cambia de signo, luego el CVD se invierte: `trend` rising↔falling y la
 *       divergencia cambia de lado. `cvd_strength` mide una MAGNITUD y no debe cambiar.
 *       Por tanto **`expectedVolumeScore(reflejado) == −expectedVolumeScore(original)` en el
 *       100 % de las ventanas**. Si falla, la asimetría es del código y hay bug. Si pasa,
 *       queda demostrado que el código no puede generar sesgo de signo y la asimetría es
 *       del mercado — que es exactamente lo que quedó sin decidir.
 *
 *  A2 · RUIDO DE ESTIMACIÓN (responde a la pregunta 2). Anclas SOLAPADAS vs anclas SIN
 *       SOLAPE: dos ventanas consecutivas comparten casi todas sus velas, así que el n
 *       efectivo es ≈ `anclas/ventana` y un IC binomial sobre las solapadas sale ~13× más
 *       estrecho de lo real. Es el mismo fallo de denominador que infló el "24-42 %" de
 *       `volatility_state` y que produjo el sesgo de 0,225R de la expectativa. **Si los
 *       IC honestos de 11,8 y 20,1 se solapan, las dos muestras no difieren.**
 *
 *  A3 · CONTRA-PERIODO. Se repite en una ventana anterior. La asimetría debería seguir al
 *       régimen, no ser una constante del activo.
 *
 * Nota: el reparto tiene un tercer valor, el 0, que NO es residuo — la guardia se ABSTIENE
 * a propósito ante `cvd_strength=marginal` y ante cualquier divergencia (carve-out de
 * absorción). Se reporta desglosado, porque "no puntúa" y "puntúa negativo" son cosas
 * distintas y mezclarlas es lo que hace ilegible un par de porcentajes sueltos.
 *
 * SOLO LECTURA. No abre la BBDD. Binance público, sin API keys.
 *
 * Uso: node scripts/auditVolumeGuardSymmetry.mjs  ·  COINS=BTC OFFSET_DAYS=270 node ...
 */

import { calculateCVD } from '../src/utils/indicators.js';
import { expectedVolumeScore } from '../src/utils/expectedScores.js';

const COINS = (process.env.COINS ?? 'BTC,SOL,ETH').split(',');
const TF = process.env.TF ?? '4h';                      // TF primario del protocolo
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d' };
const WIN = { '1h': 168, '4h': 180, '1D': 90 }[TF];     // ventana de producción
const ANCHORS_INDEP = Number(process.env.ANCHORS_INDEP ?? 100);  // anclas SIN solape buscadas
const OFFSET_DAYS = Number(process.env.OFFSET_DAYS ?? 0);
const HOUR_MS = 3600 * 1000;

/** Histórico profundo paginando hacia atrás: sin él no hay anclas SIN SOLAPE suficientes. */
async function fetchDeep(symbol, interval, want, endTime) {
  const out = [];
  let end = endTime;
  for (let i = 0; i < 20 && out.length < want; i++) {
    const batch = await klines(symbol, interval, 1000, end);
    if (!batch.length) break;
    out.unshift(...batch);
    end = batch[0].t - 1;
    if (batch.length < 1000) break;
  }
  return out;
}

async function klines(symbol, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
    volume: +x[5], taker_buy_base: +x[9],
  }));
}

/**
 * Reflexión GEOMÉTRICA del camino: `p' = p₀²/p`. Se usa ésta y no la aritmética
 * (`p' = 2p₀ − p`) por una razón que costó dos falsos positivos: la aritmética invierte las
 * diferencias ABSOLUTAS pero NO los cambios PORCENTUALES (el denominador cambia al
 * reflejar), y `calculateCVD` decide la divergencia con un umbral del 0,1 % sobre el cambio
 * porcentual del precio. Con la geométrica los retornos logarítmicos cambian de signo
 * exactamente, así que todo lo porcentual se invierte de verdad. `1/x` es decreciente →
 * high y low se intercambian. El agresor se complementa: `taker_buy' = volume − taker_buy`.
 */
const mirror = (cs) => {
  const C = cs[0].close ** 2;
  return cs.map((c) => ({
    t: c.t, open: C / c.open, close: C / c.close,
    high: C / c.low, low: C / c.high,
    volume: c.volume, taker_buy_base: c.volume - c.taker_buy_base,
  }));
};

const blank = () => ({
  n: 0, pos: 0, neg: 0, zero: 0,
  zMarginal: 0, zDiv: 0, zFlat: 0,
  mirrorOk: 0, mirrorBad: [],
});

function classify(t, candles) {
  const cvd = calculateCVD(candles);
  const { score } = expectedVolumeScore(cvd);
  t.n++;
  if (score > 0) t.pos++; else if (score < 0) t.neg++; else {
    t.zero++;
    if (!cvd || cvd.cvd_strength == null || cvd.cvd_strength === 'marginal') t.zMarginal++;
    else if (cvd.divergence && cvd.divergence !== 'none') t.zDiv++;
    else t.zFlat++;
  }
  // A1 — la reflexión debe invertir el signo exactamente.
  const { score: mScore } = expectedVolumeScore(calculateCVD(mirror(candles)));
  if (mScore === -score) t.mirrorOk++;
  else if (t.mirrorBad.length < 4) {
    const m = calculateCVD(mirror(candles));
    t.mirrorBad.push(`${score}→${mScore} [orig ${cvd?.trend}/${cvd?.divergence}/${cvd?.cvd_strength}`
      + ` vs refl ${m?.trend}/${m?.divergence}/${m?.cvd_strength}]`);
  }
  return score;
}

const pct = (k, n) => (n ? (k / n) * 100 : 0);
const ci95 = (k, n) => (n ? 1.96 * Math.sqrt((k / n) * (1 - k / n) / n) * 100 : 0);
const band = (k, n) => `${pct(k, n).toFixed(1)}%±${ci95(k, n).toFixed(1)}`;

console.log('AUDITORÍA DE SIMETRÍA DE `expectedVolumeScore` (guardia C2 de volumen)');
console.log(`TF ${TF} · ventana ${WIN} · offset ${OFFSET_DAYS} d`);
console.log('A1 reflexión → 100 % · A2 el IC leíble es el de las anclas SIN SOLAPE\n');

const agg = blank();

for (const coin of COINS) {
  try {
    const endTime = OFFSET_DAYS ? Date.now() - OFFSET_DAYS * 24 * HOUR_MS : undefined;
    const all = await fetchDeep(coin, BINANCE_TF[TF], WIN * (ANCHORS_INDEP + 1), endTime);
    if (all.length < WIN + 20) { console.log(`  ${coin}: histórico insuficiente`); continue; }

    const over = blank(), indep = blank();
    for (let end = WIN; end <= all.length; end++) classify(over, all.slice(end - WIN, end));
    // Sin solape y con la fase derivando (paso = ventana+1), la lección de auditVolatilityState.
    for (let end = WIN; end <= all.length; end += WIN + 1) classify(indep, all.slice(end - WIN, end));

    console.log(`${'═'.repeat(80)}\n${coin}`);
    console.log(`  solapadas   n=${String(over.n).padStart(4)}  `
      + `+ ${band(over.pos, over.n)}   − ${band(over.neg, over.n)}   0 ${band(over.zero, over.n)}`);
    console.log(`  SIN solape  n=${String(indep.n).padStart(4)}  `
      + `+ ${band(indep.pos, indep.n)}   − ${band(indep.neg, indep.n)}   0 ${band(indep.zero, indep.n)}`
      + '   ← IC leíble');
    console.log(`  ceros: marginal ${pct(over.zMarginal, over.n).toFixed(1)}% · `
      + `divergencia (abstención) ${pct(over.zDiv, over.n).toFixed(1)}% · `
      + `trend flat ${pct(over.zFlat, over.n).toFixed(1)}%`);
    const bad = over.n - over.mirrorOk;
    console.log(`  A1 reflexión: ${(over.mirrorOk / over.n * 100).toFixed(2)}%`
      + (bad ? `  ❌ ${bad} fallos: ${over.mirrorBad.join(', ')}` : '  ✅ EXACTO'));

    agg.n += over.n; agg.pos += over.pos; agg.neg += over.neg; agg.zero += over.zero;
    agg.mirrorOk += over.mirrorOk;
  } catch (e) { console.log(`  ${coin}: ${e.message}`); }
}

console.log(`\n${'═'.repeat(80)}`);
console.log(`A1 AGREGADO: ${(agg.mirrorOk / agg.n * 100).toFixed(2)}% de ${agg.n} ventanas invierten el signo`
  + `  ${agg.mirrorOk === agg.n ? '✅ el código NO puede sesgar el signo' : '❌ asimetría en el código'}`);
