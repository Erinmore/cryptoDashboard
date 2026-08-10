#!/usr/bin/env node
/**
 * auditHorizonMomentum.mjs — E1: ¿es el HORIZONTE de 24h el parámetro que apagó las ~20
 * hipótesis del Bloque A+B, o el eje tampoco contiene nada a plazos largos?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT — el hueco estructural
 *
 * La regla de oro del proyecto es "ninguna constante de corte se escribe sin medir antes su
 * distribución", y se aplicó con rigor a `cvd_strength`, `ADX_RANGING`, la banda del OI,
 * `SR_TOLERANCE`, el techo de `dynamicNearLevelPct`... todas ellas constantes de CONTENIDO.
 *
 * Pero el HORIZONTE nunca se midió. `HORIZON_H = 24` en `auditDirectionalBias.mjs` y
 * `auditCleanMoveDirection.mjs`; `LOOKBACK = 6` ("24h en velas de 4h") en los diez scripts del
 * Bloque B. Las ~20 hipótesis direccionales del proyecto comparten ese número, fijado por
 * convención y heredado sin comprobar. Es un parámetro ESTRUCTURAL —igual que el TF primario
 * de 4h y el universo de 3 monedas— y se escapó de la regla que los de contenido sí obedecen.
 *
 * Un NO-GO a 24h no dice nada sobre 7d o 30d: 24h en cripto está dominado por ruido, y el
 * único efecto técnico con réplica out-of-sample publicada (time-series momentum) vive a
 * plazos de semanas a meses, no de horas.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ MOMENTUM Y NO REPETIR UN INDICADOR DEL BLOQUE B
 *
 *  · CERO parámetros libres salvo el horizonte mismo (el eje bajo prueba). Nada que calibrar,
 *    luego ninguna vía de circularidad — al contrario que reejecutar MACD/WaveTrend, cuyos
 *    periodos están afinados para plazos cortos y confundirían "el horizonte no sirve" con
 *    "este indicador está parametrizado para otro plazo".
 *  · Continuidad directa con un resultado conocido: M9 ya probó `momentum 24h` entre sus 7
 *    features pre-registradas y falló. Éste es LITERALMENTE el mismo predictor, movido de eje.
 *  · Es la hipótesis canónica del plazo largo (formación = tenencia). Si el eje del horizonte
 *    contiene algo, aquí es donde asoma primero.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · A 24h NO separa, replicando M9. Si separase, el fallo estaría en este script y no en
 *       el hallazgo previo — es el control de continuidad, no un resultado.
 *  P2 · Si el eje del horizonte contiene algo, el lift crece de forma MONÓTONA con el plazo y
 *       asoma primero entre 14d y 30d (la banda donde vive el TSMOM publicado).
 *  P3 · La medibilidad se muere por el otro extremo: con anclajes disjuntos, un horizonte H
 *       sobre T años deja ~T/H observaciones. A 90d eso son ~20-32 anclas por moneda, por
 *       debajo de MIN_N=30. La predicción es que el eje se vuelve INMEDIBLE antes de volverse
 *       interesante — y ESO es un resultado sobre la caja, no sobre la señal.
 *
 * CRITERIO DE SUPERVIVENCIA, fijado antes de ver ningún número: un horizonte sobrevive solo si
 * separa por IC de Wilson en AMBAS direcciones y en las 3 monedas (el listón de §10.2). Se
 * prueban 6 horizontes × 3 monedas × 2 direcciones = 36 celdas: con esa superficie, que UNA
 * celda suelta separe es lo ESPERABLE por azar y no cuenta como nada. El listón de 6/6 es lo
 * que hace la prueba honesta pese al barrido.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * CONTROL DE CÓDIGO — dos niveles, porque la no-exactitud tiene causa identificada
 *
 *  (a) EXACTO por ancla sobre la SEÑAL. Bajo reflexión local `p' = 2A - p`, el retorno pasado
 *      `(p_i - p_{i-F})/p_{i-F}` tiene numerador que se niega EXACTO y denominador que pasa a
 *      `2A - p_{i-F}` (positivo mientras el ancla sea local), luego el SIGNO del momentum se
 *      invierte exactamente. Se exige 100 %.
 *  (b) AGREGADO por tolerancia sobre el RESULTADO. `fwdAtr` divide por `atrPct = atr/price`:
 *      el ATR es invariante bajo reflexión (los rangos se preservan: high'-low' = high-low)
 *      pero `price` pasa a `2A - price`, así que el cociente NO se niega exacto. Mismo motivo
 *      que en B4/B5 (`auditVwapSideSignal`, `auditVolumeProfileExcursionSignal`), donde la
 *      señal también es un cociente de precios. Tolerancia 5pp, la ya establecida.
 *
 * MÉTODO: TF 4h (el de producción y el de todo el Bloque B, para que las cifras sean
 * comparables). Formación = horizonte (TSMOM canónico). Recorrido normalizado por
 * ATR% × √velas, misma definición y misma banda (0.5) que los diez scripts del Bloque B.
 * Anclajes DISJUNTOS vía `lib/disjointAnchors.mjs`. Comparación contra el COMPLEMENTO
 * (momentum pasado negativo), que es su complemento EXACTO — no contra la base, que lo
 * contiene y compartiría observaciones.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditHorizonMomentum.mjs
 *       COINS=SOL DAYS=3000 node scripts/auditHorizonMomentum.mjs
 */

import { calculateATRSeries } from '../src/utils/indicators.js';
import { fetchKlines, mirrorCandles } from './lib/binanceKlines.mjs';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 3000);
const ATR_WARMUP = 180;            // misma ventana de arranque que el Bloque B
const FWD_BAND = 0.5;              // misma banda que los diez scripts del Bloque B
const MIN_N = 30;
const CANDLE_SEC = 4 * 3600;

// Horizontes en VELAS de 4h. 6 = 24h (el heredado, control de continuidad con M9).
const HORIZONS = [
  { label: '24h', candles: 6 },
  { label: '3d', candles: 18 },
  { label: '7d', candles: 42 },
  { label: '14d', candles: 84 },
  { label: '30d', candles: 180 },
  { label: '90d', candles: 540 },
];

/**
 * Anclas para un horizonte dado. Señal = signo del retorno de las `H` velas anteriores
 * (formación = tenencia). Resultado = recorrido futuro normalizado por ATR%×√H.
 */
function build(candles, H) {
  const atrByIdx = new Map((calculateATRSeries(candles, 14) ?? []).map((e) => [e.idx, e.atr]));
  const sq = Math.sqrt(H);
  const start = Math.max(ATR_WARMUP, H);
  const rows = [];
  const mirrorRows = [];
  let signExact = 0;
  let signTotal = 0;

  for (let i = start; i + H < candles.length; i++) {
    const atr = atrByIdx.get(i);
    const price = candles[i].close;
    const pxPast = candles[i - H].close;
    if (!Number.isFinite(atr) || !(price > 0) || !(pxPast > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;

    // Señal: signo ESTRICTO del retorno pasado. El 0 exacto no vota (misma corrección de
    // boundary que B1: `calculateMACD` redondea y los ±0 comparaban igual bajo >=/<).
    const past = price - pxPast;
    if (past === 0) continue;
    const up = past > 0;

    const pxFwd = candles[i + H].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * sq);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, up, fwdAtr });

    // ── control (a) EXACTO: el signo del momentum debe invertirse bajo reflexión local ──
    const lo = i - H;
    const localSlice = candles.slice(lo, i + 1 + H);
    const mLocal = mirrorCandles(localSlice, localSlice[0].close);
    const mIdx = i - lo;
    const mPrice = mLocal[mIdx].close;
    const mPast = mPrice - mLocal[0].close;
    if (mPast !== 0) {
      signTotal++;
      if ((mPast > 0) !== up) signExact++;
    }

    // ── control (b) AGREGADO: resultado sobre el tramo reflejado ────────────────────────
    const mAtrEntry = (calculateATRSeries(mLocal, 14) ?? []).find((e) => e.idx === mIdx);
    if (mAtrEntry && mPrice > 0 && mPast !== 0) {
      const mAtrPct = (mAtrEntry.atr / mPrice) * 100;
      if (mAtrPct > 0) {
        const mPxFwd = mLocal[mIdx + H].close;
        const mFwdAtr = (((mPxFwd - mPrice) / mPrice) * 100) / (mAtrPct * sq);
        mirrorRows.push({ t, up: mPast > 0, fwdAtr: mFwdAtr });
      }
    }
  }
  return { rows, mirrorRows, signExact, signTotal };
}

const upHit = (r) => r.fwdAtr > FWD_BAND;
const dnHit = (r) => r.fwdAtr < -FWD_BAND;

console.log('═'.repeat(104));
console.log('E1 · ¿ES EL HORIZONTE DE 24H EL PARÁMETRO QUE APAGÓ EL BLOQUE A+B? — TSMOM por horizonte');
console.log(`${DAYS} d objetivo · TF 4h · formación = tenencia · banda ${FWD_BAND}×ATR%×√velas (la del Bloque B)`);
console.log('P1: 24h NO separa (control de continuidad con M9) · P2: si hay algo, el lift crece monótono');
console.log('P3: la medibilidad muere antes que la señal (n_ef ~ T/H) · SUPERVIVENCIA: 6/6 celdas por horizonte');
console.log('═'.repeat(104));

const grid = new Map(); // label -> [{coin, upSep, dnSep, upLift, dnLift, nUp, nDn}]

for (const coin of COINS) {
  let raw;
  try { raw = await fetchKlines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  const spanDays = (raw.at(-1).t - raw[0].t) / 86400e3;
  console.log(`\n${'─'.repeat(104)}`);
  console.log(`${coin} — ${raw.length} velas de 4h (${spanDays.toFixed(0)} días de histórico)`);
  console.log(`  ${'horiz'.padEnd(6)} ${'n'.padStart(6)} ${'mom+→sube'.padStart(22)} ${'mom−→baja'.padStart(22)}   control`);

  for (const { label, candles: H } of HORIZONS) {
    if (raw.length < Math.max(ATR_WARMUP, H) + H + 40) {
      console.log(`  ${label.padEnd(6)} histórico insuficiente para este horizonte`);
      continue;
    }
    const { rows, mirrorRows, signExact, signTotal } = build(raw, H);
    if (rows.length < 10) { console.log(`  ${label.padEnd(6)} sin anclas`); continue; }

    const horizonSec = H * CANDLE_SEC;
    const stride = Math.max(2, Math.min(H, 12));
    const opts = { horizonSec, stride };

    const momUp = rows.filter((r) => r.up);
    const momDn = rows.filter((r) => !r.up);

    // Comparación contra el COMPLEMENTO exacto, no contra la base que lo contiene.
    const upInUp = disjointRate(momUp, upHit, opts);      // ¿sube tras momentum +?
    const upInDn = disjointRate(momDn, upHit, opts);      // ¿sube tras momentum −?
    const dnInDn = disjointRate(momDn, dnHit, opts);      // ¿baja tras momentum −?
    const dnInUp = disjointRate(momUp, dnHit, opts);      // ¿baja tras momentum +?

    const vUp = verdictCI(upInUp, upInDn);
    const vDn = verdictCI(dnInDn, dnInUp);
    const upSep = !!(upInUp && upInDn && upInUp.n_eff >= MIN_N && upInDn.n_eff >= MIN_N
      && vUp.separated && vUp.side === 'above');
    const dnSep = !!(dnInDn && dnInUp && dnInDn.n_eff >= MIN_N && dnInUp.n_eff >= MIN_N
      && vDn.separated && vDn.side === 'above');

    const upLift = upInUp && upInDn ? upInUp.point - upInDn.point : null;
    const dnLift = dnInDn && dnInUp ? dnInDn.point - dnInUp.point : null;

    // control (b): tasa de "sigue bajando" tras momentum− real vs "sigue subiendo" tras
    // momentum+ en el reflejo. Deben aproximarse si el código no mete asimetría.
    const mUpRows = mirrorRows.filter((r) => r.up);
    const rate = (arr, hit) => (arr.length ? arr.filter(hit).length / arr.length : null);
    const rOrig = rate(momDn, dnHit);
    const rMir = rate(mUpRows, upHit);
    const aggOk = rOrig != null && rMir != null && Math.abs(rOrig - rMir) < 0.05;
    const signPct = signTotal ? (signExact / signTotal) * 100 : null;

    const fmt = (r, lift, sep) => {
      if (!r) return 'sin anclas'.padStart(22);
      const l = lift == null ? '' : `${lift >= 0 ? '+' : ''}${lift.toFixed(1)}`;
      return `${r.point.toFixed(1)}% n=${String(r.n_eff).padStart(3)} ${l.padStart(5)}pt ${sep ? '✅' : r.n_eff < MIN_N ? '⚠n' : '✗'}`.padStart(22);
    };
    console.log(`  ${label.padEnd(6)} ${String(rows.length).padStart(6)} ${fmt(upInUp, upLift, upSep)} ${fmt(dnInDn, dnLift, dnSep)}`
      + `   signo ${signPct == null ? '—' : signPct.toFixed(2) + '%'} ${signPct === 100 ? '✅' : '⚠️'} agg ${aggOk ? '✅' : '⚠️'}`);
    const ciStr = (r) => (r ? `[${r.low.toFixed(1)}-${r.high.toFixed(1)}]` : '[—]');
    console.log(`         IC sube: mom+ ${ciStr(upInUp)} vs mom− ${ciStr(upInDn)}   `
      + `IC baja: mom− ${ciStr(dnInDn)} vs mom+ ${ciStr(dnInUp)}`);

    if (!grid.has(label)) grid.set(label, []);
    grid.get(label).push({
      coin, upSep, dnSep, upLift, dnLift,
      nUp: upInUp?.n_eff ?? 0, nDn: dnInDn?.n_eff ?? 0,
    });
  }
}

console.log(`\n${'═'.repeat(104)}`);
console.log('VEREDICTO POR HORIZONTE — supervivencia exige 3/3 monedas en AMBAS direcciones');
console.log(`  ${'horiz'.padEnd(6)} ${'celdas separadas'.padEnd(20)} ${'n_ef medio'.padEnd(12)} ${'lift medio'.padEnd(24)} veredicto`);
for (const { label } of HORIZONS) {
  const rowsH = grid.get(label);
  if (!rowsH || !rowsH.length) { console.log(`  ${label.padEnd(6)} sin datos`); continue; }
  const sep = rowsH.reduce((a, r) => a + (r.upSep ? 1 : 0) + (r.dnSep ? 1 : 0), 0);
  const total = rowsH.length * 2;
  const nAvg = rowsH.reduce((a, r) => a + r.nUp + r.nDn, 0) / total;
  const liftsUp = rowsH.map((r) => r.upLift).filter((x) => x != null);
  const liftsDn = rowsH.map((r) => r.dnLift).filter((x) => x != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const mUp = avg(liftsUp); const mDn = avg(liftsDn);
  const measurable = nAvg >= MIN_N;
  const verdict = sep === total ? '✅ SOBREVIVE'
    : !measurable ? '⛔ INMEDIBLE (n_ef < 30)'
      : '✗ NO-GO';
  console.log(`  ${label.padEnd(6)} ${`${sep}/${total}`.padEnd(20)} ${nAvg.toFixed(0).padEnd(12)}`
    + ` ${`sube ${mUp >= 0 ? '+' : ''}${mUp.toFixed(1)}pt · baja ${mDn >= 0 ? '+' : ''}${mDn.toFixed(1)}pt`.padEnd(24)} ${verdict}`);
}

console.log('\nLECTURA:');
console.log(' · Si 24h sale NO-GO y los demás también CON n_ef suficiente → el horizonte no era el');
console.log('   parámetro culpable, y la caja queda cerrada por un lado más.');
console.log(' · Si algún horizonte SOBREVIVE (6/6) → el 24h heredado apagó una señal real y hay que');
console.log('   remedir el Bloque B en ese eje antes de dar nada por archivado.');
console.log(' · Si los horizontes largos salen INMEDIBLES → no son un NO-GO, son una pregunta que');
console.log('   este conjunto de datos (3 monedas, klines de Binance) NO PUEDE responder. Eso acota');
console.log('   la caja y dice qué haría falta para abrirla (más activos, no más historia).');
