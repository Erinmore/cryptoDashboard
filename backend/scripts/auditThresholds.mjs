/**
 * auditThresholds.mjs — ¿discriminan algo los umbrales del sistema?
 *
 * Motivación (revisión crítica 2026-07-26): todas las constantes de corte de la ruta de
 * decisión son números redondos elegidos a ojo, y ninguna se validó nunca contra la
 * distribución de la magnitud que bucketiza. El primero que se midió (`cvd_strength`, corte
 * al 2 %) resultó caer sobre la MEDIANA del 4h — es decir, partía la muestra por la mitad
 * en un punto arbitrario. Este script mide el resto.
 *
 * Método: se importan las funciones REALES del backend (no reimplementaciones) y se evalúan
 * sobre ventanas rodantes del mismo tamaño que usa producción para cada TF, con klines de
 * Binance. Para cada umbral se reporta:
 *
 *   - el percentil en el que cae el corte (50 % = parte la muestra por la mitad = no discrimina)
 *   - el reparto entre buckets (un bucket al 0 % es código muerto)
 *
 * Es SOLO LECTURA: no toca la BBDD ni producción. No requiere API keys (Binance público).
 *
 * Uso:
 *   node scripts/auditThresholds.mjs                 # SOL (+ BTC/ETH de control)
 *   COINS=SOL node scripts/auditThresholds.mjs       # solo una moneda
 */

import {
  calculateCVD, calculateADX, calculateATR, calculateStochRSI, calculateVWAP,
  calculateSupportResistance, detectMarketRegime,
} from '../src/utils/indicators.js';
import { calculateSMC } from '../src/utils/smc.js';
import { dynamicNearLevelPct } from '../src/utils/gating.js';
import {
  ADX_TRENDING_THRESHOLD, ADX_RANGING_THRESHOLD, REGIME_ATR_MULTIPLIER,
  SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT,
} from '../src/config/constants.js';

// Nº de velas que pide producción por TF (cacheOhlc en coingeckoService): la ventana rodante
// replica exactamente lo que ve el LLM, no una ventana arbitraria.
const PROD_CANDLES = { '1h': 168, '4h': 180, '1D': 90, '1W': 52 };
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };
const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TFS = Object.keys(PROD_CANDLES);

// ── utilidades de reporte ────────────────────────────────────────────────────

const pct = (n, total) => total === 0 ? '  —  ' : `${(n / total * 100).toFixed(1).padStart(5)}%`;

/** Percentil en el que cae `threshold` dentro de `values` (fracción por debajo). */
function percentileOf(values, threshold) {
  if (values.length === 0) return null;
  const below = values.filter((v) => v < threshold).length;
  return below / values.length * 100;
}

/** Diagnóstico de un corte: cerca del 50 % no separa nada; cerca de 0/100 nunca actúa. */
function verdict(p) {
  if (p == null) return 'sin datos';
  if (p >= 40 && p <= 60) return '⚠️  MONEDA AL AIRE (parte por la mediana)';
  if (p <= 3) return '⚠️  casi nunca por debajo (bucket inferior vacío)';
  if (p >= 97) return '⚠️  casi siempre por debajo (bucket superior vacío)';
  return 'discrimina';
}

function bucketReport(label, counts, total) {
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${pct(v, total)}`);
  const empty = Object.entries(counts).filter(([, v]) => v === 0).map(([k]) => k);
  console.log(`    ${label.padEnd(26)} ${parts.join(' · ')}${empty.length ? `   ← VACÍO: ${empty.join(', ')}` : ''}`);
}

// ── datos ────────────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${res.status}`);
  return (await res.json()).map((r) => ({
    t: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4],
    volume: +r[5], taker_buy_base: +r[9],
  }));
}

// ── auditoría por coin/TF ────────────────────────────────────────────────────

async function auditCoinTf(coin, tf) {
  const N = PROD_CANDLES[tf];
  const all = await fetchKlines(coin, BINANCE_TF[tf]);
  if (all.length <= N) return null;

  const acc = {
    windows: 0,
    cvdRatio: [], adx: [], atrPct: [], stochK: [], vwapDiffPct: [], srTouches: [], srLevelsPerWindow: [],
    cvdStrength: { marginal: 0, moderate: 0, strong: 0 },
    regime: { trending: 0, ranging: 0, weak_trend: 0, high_volatility: 0, unknown: 0 },
    stochSignal: { neutral: 0, overbought: 0, oversold: 0, oversold_cross_up: 0, overbought_cross_down: 0 },
    vwapSide: { above: 0, below: 0, at: 0 },
    nearLevelClamp: { bajo_min: 0, dentro: 0, sobre_max: 0 },
    smcStatus: { active: 0, context: 0, expired: 0, sin_señal: 0 },
    fvgMitigation: [],
  };

  for (let end = N; end <= all.length; end++) {
    const w = all.slice(end - N, end);
    const closes = w.map((c) => c.close);
    const price = closes.at(-1);
    acc.windows++;

    // G1 · cvd_strength — se lee la ETIQUETA QUE PRODUCE EL BACKEND, no se re-bucketiza aquí.
    // (En la primera versión el script aplicaba sus propios cortes 2/8, así que seguía
    // reportando la calibración vieja después de cambiarla: verificación inútil.)
    const cvd = calculateCVD(w);
    if (cvd && Number.isFinite(cvd.cvd_delta_vs_volume_pct)) {
      acc.cvdRatio.push(Math.abs(cvd.cvd_delta_vs_volume_pct));
      if (cvd.cvd_strength) acc.cvdStrength[cvd.cvd_strength]++;
    }

    // G3 · ADX 25/20 + régimen (ATR > 2× SMA(ATR))
    const adx = calculateADX(w);
    if (adx && Number.isFinite(adx.adx)) acc.adx.push(adx.adx);
    acc.regime[detectMarketRegime(w, closes) ?? 'unknown']++;

    // G3 · StochRSI 20/80
    const st = calculateStochRSI(closes);
    if (st && Number.isFinite(st.k)) { acc.stochK.push(st.k); acc.stochSignal[st.signal ?? 'neutral']++; }

    // G3 · price_vs_vwap con banda de ±0.05 %
    const vwap = calculateVWAP(w);
    if (vwap && Number.isFinite(vwap.value) && vwap.value > 0) {
      const d = (price - vwap.value) / vwap.value * 100;
      acc.vwapDiffPct.push(Math.abs(d));
      const atrNow = calculateATR(w);
      const bandPct = atrNow && price > 0 ? (atrNow / price * 100) * 0.25 : 0.05;
      acc.vwapSide[d > bandPct ? 'above' : d < -bandPct ? 'below' : 'at']++;
    }

    // G5 · ATR% → umbral dinámico de cercanía (1.5×ATR%, clamp [0.5, 3])
    const atr = calculateATR(w);
    if (atr && price > 0) {
      const atrPct = atr / price * 100;
      acc.atrPct.push(atrPct);
      // Se llama a la función REAL (con su techo por TF), no a una réplica del clamp.
      // `dynamicNearLevelPct` redondea a 2 decimales: hay que comparar contra el raw TAMBIÉN
      // redondeado, o el redondeo se cuenta como recorte y el clamp parece saturado siempre.
      const raw = parseFloat((1.5 * atrPct).toFixed(2));
      const eff = dynamicNearLevelPct(atrPct, tf);
      acc.nearLevelClamp[eff > raw ? 'bajo_min' : eff < raw ? 'sobre_max' : 'dentro']++;
    }

    // G1 · toques de los niveles S/R (MIN_TOUCHES=3 veto / 2 contradicción)
    const sr = calculateSupportResistance(w, SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT);
    const lvls = [...(sr?.supports ?? []), ...(sr?.resistances ?? [])];
    acc.srLevelsPerWindow.push(lvls.length);
    for (const lv of lvls) {
      if (Number.isFinite(lv.touches)) acc.srTouches.push(lv.touches);
    }

    // G4 · decay SMC + mitigación de FVG (70 / 40)
    // OJO: la clave es `timeframe`, no `tf`. Con `tf` la función cae al default
    // activeMax=Infinity y TODO sale 'active' (falso positivo de "decay muerto").
    const smc = calculateSMC(w, { timeframe: tf });
    const ev = smc?.last_bos ?? smc?.last_choch ?? null;
    acc.smcStatus[ev?.signal_status ?? 'sin_señal']++;
    for (const dir of ['bullish', 'bearish']) {
      for (const f of smc?.unmitigated_fvgs?.[dir] ?? []) {
        if (Number.isFinite(f.mitigation_pct)) acc.fvgMitigation.push(f.mitigation_pct);
      }
    }
  }
  return acc;
}

function reportTf(coin, tf, a) {
  const n = a.windows;
  console.log(`\n  ── ${coin} / ${tf}  (${n} ventanas de ${PROD_CANDLES[tf]} velas)`);

  const pCvd = percentileOf(a.cvdRatio, 2);
  console.log(`    cvd_strength (auto-normalizado) — el corte 2% viejo caía en el percentil ${pCvd?.toFixed(1)}%`);
  bucketReport('  buckets', a.cvdStrength, n);

  const pAdxT = percentileOf(a.adx, ADX_TRENDING_THRESHOLD);
  const pAdxR = percentileOf(a.adx, ADX_RANGING_THRESHOLD);
  console.log(`    ADX trending corte ${ADX_TRENDING_THRESHOLD}       → percentil ${pAdxT?.toFixed(1)}%   ${verdict(pAdxT)}`);
  console.log(`    ADX ranging  corte ${ADX_RANGING_THRESHOLD}       → percentil ${pAdxR?.toFixed(1)}%   ${verdict(pAdxR)}`);
  bucketReport('  régimen', a.regime, n);

  const pStochLo = percentileOf(a.stochK, 20);
  const pStochHi = percentileOf(a.stochK, 80);
  console.log(`    StochRSI 20/80             → percentiles ${pStochLo?.toFixed(1)}% / ${pStochHi?.toFixed(1)}%`);
  bucketReport('  señal', a.stochSignal, n);

  const pVwap = percentileOf(a.vwapDiffPct, 0.05);
  console.log(`    price_vs_vwap banda 0.25×ATR% — el ±0.05% viejo caía en el percentil ${pVwap?.toFixed(1)}%`);
  bucketReport('  lado', a.vwapSide, n);

  const medAtr = [...a.atrPct].sort((x, y) => x - y)[Math.floor(a.atrPct.length / 2)];
  console.log(`    ATR% mediana ${medAtr?.toFixed(2)}% → umbral dinámico ${(1.5 * medAtr).toFixed(2)}%`);
  bucketReport('  clamp (techo por TF)', a.nearLevelClamp, n);

  const t = a.srTouches;
  const share = (k) => pct(t.filter((x) => x >= k).length, t.length);
  const perW = a.srLevelsPerWindow.reduce((x, y) => x + y, 0) / (a.srLevelsPerWindow.length || 1);
  console.log(`    S/R ${perW.toFixed(1)} niveles/ventana (${t.length} tot) >=2: ${share(2)} · >=3: ${share(3)} · >=4: ${share(4)}`);

  bucketReport('SMC signal_status', a.smcStatus, n);
  const m = a.fvgMitigation;
  if (m.length) {
    const b = { '<40 (active)': 0, '40-70 (context)': 0, '>70 (expired)': 0 };
    for (const v of m) b[v < 40 ? '<40 (active)' : v <= 70 ? '40-70 (context)' : '>70 (expired)']++;
    bucketReport(`FVG mitigation (${m.length})`, b, m.length);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log('AUDITORÍA DE UMBRALES — distribución real vs cortes hardcodeados');
console.log('Funciones importadas del backend. Ventana rodante = la de producción por TF.');
console.log(`Constantes: ADX ${ADX_TRENDING_THRESHOLD}/${ADX_RANGING_THRESHOLD} · REGIME_ATR_MULT ${REGIME_ATR_MULTIPLIER} · SR_LOOKBACK ${SR_LOOKBACK} · SR_MIN_TOUCHES ${SR_MIN_TOUCHES} · SR_TOL ${SR_TOLERANCE_PCT * 100}%`);

for (const coin of COINS) {
  console.log(`\n${'═'.repeat(78)}\n${coin}`);
  for (const tf of TFS) {
    try {
      const a = await auditCoinTf(coin, tf);
      if (a) reportTf(coin, tf, a); else console.log(`  ${tf}: histórico insuficiente`);
    } catch (e) {
      console.log(`  ${tf}: ERROR ${e.message}`);
    }
  }
}
console.log('\nLeyenda: percentil ≈50% = el corte parte la muestra por la mitad (no discrimina).');
console.log('         bucket VACÍO = esa rama del código nunca se ejecuta para este activo/TF.');
