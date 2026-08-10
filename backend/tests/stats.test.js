/**
 * stats.test.js — intervalo de Wilson para el win-rate (auditoría C5).
 */

import { describe, test, expect } from '@jest/globals';
import {
  wilsonInterval, classifyOpportunity, maxExcursionAtr,
  summarizeOpportunity, OPPORTUNITY_BASE_RATE,
  normalizedTargetDistance, targetReachabilityFor, TARGET_UNREACHABLE_PCT,
} from '../src/utils/stats.js';

describe('wilsonInterval', () => {
  test('n=0 → todo null', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: null, low: null, high: null, n: 0 });
  });

  test('muestra pequeña → IC muy ancho (por eso no es concluyente)', () => {
    const r = wilsonInterval(1, 2); // 1/2 = 50%
    expect(r.point).toBe(50);
    expect(r.high - r.low).toBeGreaterThan(60); // banda enorme con n=2
  });

  test('muestra grande → IC estrecho alrededor del punto', () => {
    const r = wilsonInterval(60, 100); // 60%
    expect(r.point).toBe(60);
    expect(r.low).toBeGreaterThan(49);
    expect(r.high).toBeLessThan(70);
  });

  test('wins=0 no colapsa a [0,0] (Wilson no es Wald)', () => {
    const r = wilsonInterval(0, 10);
    expect(r.point).toBe(0);
    expect(r.high).toBeGreaterThan(0); // el límite superior no es 0
    expect(r.low).toBe(0);
  });

  test('todos los límites en [0,100]', () => {
    for (const [w, n] of [[0, 1], [1, 1], [3, 5], [50, 50]]) {
      const r = wilsonInterval(w, n);
      expect(r.low).toBeGreaterThanOrEqual(0);
      expect(r.high).toBeLessThanOrEqual(100);
    }
  });
});

// ─── Fase 5 · coste de oportunidad y win-rate path-aware ─────────────────────

describe('classifyOpportunity', () => {
  // El par se fija EXPLÍCITAMENTE: estos tests comprueban la lógica (orden, bloqueo,
  // empates), no la calibración. Un cambio de múltiplos no debe romperlos.
  const op = (row, extra = {}) => classifyOpportunity(row, { targetK: 2, adverseK: 1, ...extra });

  /**
   * Fila de outcome con la rejilla de primeros cruces ya hidratada. El `timestamp` es
   * antiguo a propósito: salvo en los tests de censura, lo que se comprueba aquí es la
   * lógica del recorrido, y para eso la ventana tiene que estar vencida.
   */
  const fila = (up, down, atr = 1) => ({
    timestamp: '2026-01-01T00:00:00.000Z',
    atr_pct_at_analysis: atr,
    path_first_passage: { atr_pct: atr, multiples: [0.5, 1, 1.5, 2, 3, 4], up, down },
  });

  test('recorrido limpio al alza → oportunidad ofrecida', () => {
    const r = op(fila({ 2: 6 }, {}));
    expect(r.offered).toBe(true);
    expect(r.direction).toBe('up');
    expect(r.hours_to).toBe(6);
  });

  test('adverso ANTES del objetivo → no era operable (era latigazo)', () => {
    // Llegó a +2xATR en la hora 10, pero antes se fue -1xATR en la hora 3.
    const r = op(fila({ 2: 10 }, { 1: 3 }));
    expect(r.offered).toBe(false);
    expect(r.blocked_by_adverse).toBe(true);
  });

  test('adverso DESPUÉS del objetivo no invalida la oportunidad', () => {
    const r = op(fila({ 2: 3 }, { 1: 10 }));
    expect(r.offered).toBe(true);
    expect(r.hours_to).toBe(3);
  });

  test('empate en la misma vela → se asume el adverso primero (conservador)', () => {
    const r = op(fila({ 2: 5 }, { 1: 5 }));
    expect(r.offered).toBe(false);
    expect(r.blocked_by_adverse).toBe(true);
  });

  test('mercado plano → evaluable y sin oportunidad (abstención acertada)', () => {
    const r = op(fila({}, {}));
    expect(r.evaluable).toBe(true);
    expect(r.offered).toBe(false);
    expect(r.blocked_by_adverse).toBe(false);
  });

  test('sin rejilla → NO evaluable, distinto de "no ofreció"', () => {
    const r = op({ path_first_passage: null });
    expect(r.evaluable).toBe(false);
    expect(r.offered).toBe(false);
  });

  test('el horizonte descarta lo que llegó demasiado tarde', () => {
    const f = fila({ 2: 100 }, {});
    expect(op(f).offered).toBe(true);                               // sin límite de horas
    expect(op(f, { horizonH: 24 }).offered).toBe(false);            // en 24h, no
  });

  test('elige el sentido que llegó antes cuando ambos son limpios', () => {
    const r = op(fila({ 2: 20 }, { 2: 4 }), { adverseK: 3 });
    expect(r.direction).toBe('down');
    expect(r.hours_to).toBe(4);
  });

  test('acepta el JSON crudo de SQLite', () => {
    const raw = JSON.stringify({ up: { 2: 6 }, down: {} });
    expect(op({ path_first_passage: raw }).offered).toBe(true);
    expect(op({ path_first_passage: '{roto' }).evaluable).toBe(false);
  });

  test('un objetivo más exigente reduce las oportunidades contadas', () => {
    const f = fila({ 2: 6, 3: null }, {});
    expect(classifyOpportunity(f, { targetK: 2 }).offered).toBe(true);
    expect(classifyOpportunity(f, { targetK: 3 }).offered).toBe(false);
  });
});

describe('maxExcursionAtr', () => {
  test('normaliza el mayor de los dos lados por el ATR', () => {
    const row = { atr_pct_at_analysis: 2, max_up_pct_24h: 3, max_down_pct_24h: -5 };
    expect(maxExcursionAtr(row)).toBe(2.5); // 5 / 2
  });

  test('sin ATR no hay escala → null', () => {
    expect(maxExcursionAtr({ max_up_pct_24h: 3 })).toBeNull();
    expect(maxExcursionAtr({ atr_pct_at_analysis: 0, max_up_pct_24h: 3 })).toBeNull();
  });

  test('el horizonte selecciona las columnas correctas', () => {
    const row = {
      atr_pct_at_analysis: 1,
      max_up_pct_24h: 2, max_down_pct_24h: -1,
      max_up_pct_7d: 9, max_down_pct_7d: -1,
    };
    expect(maxExcursionAtr(row, '24h')).toBe(2);
    expect(maxExcursionAtr(row, '7d')).toBe(9);
  });
});

// `classifyPathOutcome` y `convictionBucket` se retiraron de utils/stats.js con el pivot a
// ayudante de riesgo (§REORIENTACIÓN): sin dictamen direccional no hay win-rate path-aware
// que calcular ni convicción que bucketizar. El `now: null` desactiva-censura de
// `horizonMatured` (la función compartida) sigue cubierto por las pruebas de
// `classifyOpportunity` de más abajo.

describe('summarizeOpportunity — comparación contra la tasa base', () => {
  const fila = (up, down) => ({
    timestamp: '2026-01-01T00:00:00.000Z',   // ventana vencida (ver censura, más abajo)
    atr_pct_at_analysis: 1,
    path_first_passage: { up, down },
  });

  test('el lift compara el offered_pct con la tasa base medida', () => {
    // 2 de 4 ofrecen → 50%, contra una base de 34.8% a 24h.
    const rows = [fila({ 2: 5 }, {}), fila({ 2: 6 }, {}), fila({}, {}), fila({}, {})];
    const s = summarizeOpportunity(rows, { horizonH: 24 });
    expect(s.offered_pct).toBe(50);
    expect(s.base_rate_pct).toBe(OPPORTUNITY_BASE_RATE['24h'].pct);
    expect(s.lift_pct).toBeCloseTo(15.2, 1);
  });

  // 2026-08-09: `offered_pct`/`lift_pct` eran la otra proporción de la familia (junto a
  // `trigger_rate_pct`) sin IC de Wilson — a diferencia de `win_rate`/`expectancy_r`, que sí
  // lo llevan. Sin él, un lift negativo se lee como "peor que el azar" cuando puede ser sólo
  // muestra insuficiente.
  test('offered_pct lleva IC de Wilson, y la base cayendo dentro del IC marca lift NO significativo', () => {
    const rows = [fila({ 2: 5 }, {}), fila({ 2: 6 }, {}), fila({}, {}), fila({}, {})];
    const s = summarizeOpportunity(rows, { horizonH: 24 });
    expect(s.offered_pct_ci_low).toBeCloseTo(15, 0);
    expect(s.offered_pct_ci_high).toBeCloseTo(85, 0);
    // La base (34.8) cae dentro de [15, 85] → el lift de +15.2 no es significativo con n=4.
    expect(s.lift_significant).toBe(false);
  });

  test('sin ninguna fila ofrecida, el IC no inventa un 0% sólido (sigue siendo ancho)', () => {
    const rows = [fila({}, {}), fila({}, {})];
    const s = summarizeOpportunity(rows, { horizonH: 24 });
    expect(s.offered_pct).toBe(0);
    expect(s.offered_pct_ci_low).toBe(0);
    expect(s.offered_pct_ci_high).toBeCloseTo(65.8, 0);
  });

  test('sin filas evaluables, el IC es null (no 0/0)', () => {
    const s = summarizeOpportunity([{ path_first_passage: null }], { horizonH: 24 });
    expect(s.offered_pct_ci_low).toBeNull();
    expect(s.offered_pct_ci_high).toBeNull();
    expect(s.lift_significant).toBeNull();
  });

  test('el horizonte de 7d usa su propio par calibrado (4×, no 2×)', () => {
    // Con 2×/1× a 7 días la tasa base era 68,5% y saturaba: el objetivo escala con la
    // ventana, así que cada horizonte tiene sus múltiplos.
    const soloDosX = summarizeOpportunity([fila({ 2: 5 }, {})], { horizonH: null });
    expect(soloDosX.offered_pct).toBe(0);          // 2×ATR ya no basta a 7d
    expect(soloDosX.thresholds.target_k_atr).toBe(4);

    const conCuatroX = summarizeOpportunity([fila({ 2: 5, 4: 30 }, {})], { horizonH: null });
    expect(conCuatroX.offered_pct).toBe(100);
    expect(conCuatroX.base_rate_pct).toBe(OPPORTUNITY_BASE_RATE['7d'].pct);
    expect(conCuatroX.base_rate_discriminates).toBe(true);
  });

  test('con múltiplos NO calibrados no se compara (la base medida no aplica)', () => {
    const s = summarizeOpportunity([fila({ 3: 5 }, {})], { horizonH: 24, targetK: 3 });
    expect(s.base_rate_pct).toBeNull();
    expect(s.lift_pct).toBeNull();
  });

  test('sin filas evaluables no se inventa un lift', () => {
    const s = summarizeOpportunity([{ path_first_passage: null }], { horizonH: 24 });
    expect(s.offered_pct).toBeNull();
    expect(s.lift_pct).toBeNull();
  });
});

// ─── CENSURA: un "no ofreció" no vale hasta que el horizonte vence ────────────
// Regresión del 2026-08-01: el bloque de 7d publicaba `offered_pct 0,0` y `lift −36`
// con las 7 filas de la muestra por debajo de 66 h de vida — cero observaciones maduras
// presentadas como una abstención brillante. Misma censura que ya se corrigió en
// `trigger_rate_pct`. La asimetría es el punto: un cruce limpio es terminal en cuanto se
// observa; su ausencia solo significa "todavía no".
describe('classifyOpportunity — censura por horizonte no vencido', () => {
  const T0 = Date.parse('2026-08-01T00:00:00.000Z');
  const H = 3600 * 1000;
  const fila = (up, down) => ({
    timestamp: '2026-08-01T00:00:00.000Z',
    atr_pct_at_analysis: 1,
    path_first_passage: { up, down },
  });

  test('sin cruce y con la ventana abierta → pending, FUERA del denominador', () => {
    const r = classifyOpportunity(fila({}, {}), { horizonH: 24, now: T0 + 12 * H });
    expect(r.pending).toBe(true);
    expect(r.evaluable).toBe(false);
    expect(r.offered).toBe(false);
  });

  test('la MISMA fila cuenta como negativo en cuanto la ventana vence', () => {
    const r = classifyOpportunity(fila({}, {}), { horizonH: 24, now: T0 + 25 * H });
    expect(r.pending).toBe(false);
    expect(r.evaluable).toBe(true);
    expect(r.offered).toBe(false);
  });

  test('un cruce limpio es TERMINAL aunque la ventana siga abierta', () => {
    // Asimetría deliberada: más mercado no deshace un recorrido ya ofrecido.
    const r = classifyOpportunity(fila({ 2: 6 }, {}), { horizonH: 24, now: T0 + 8 * H });
    expect(r.offered).toBe(true);
    expect(r.pending).toBe(false);
    expect(r.evaluable).toBe(true);
  });

  test('blocked_by_adverse también es terminal (el paso por targetK ya cruzó adverseK)', () => {
    const r = classifyOpportunity(fila({ 2: 10 }, { 1: 3 }), { horizonH: 24, now: T0 + 11 * H });
    expect(r.blocked_by_adverse).toBe(true);
    expect(r.pending).toBe(false);
    expect(r.evaluable).toBe(true);
  });

  test('el bloque de 7d vence a 7 días, no cuando hay klines', () => {
    const seisDias = classifyOpportunity(fila({}, {}), { horizonH: null, now: T0 + 6 * 24 * H });
    expect(seisDias.pending).toBe(true);
    const ochoDias = classifyOpportunity(fila({}, {}), { horizonH: null, now: T0 + 8 * 24 * H });
    expect(ochoDias.evaluable).toBe(true);
  });

  test('sin timestamp utilizable no se certifica un negativo', () => {
    const sinFecha = { atr_pct_at_analysis: 1, path_first_passage: { up: {}, down: {} } };
    expect(classifyOpportunity(sinFecha, { horizonH: 24 }).pending).toBe(true);
  });

  test('summarizeOpportunity saca las pendientes del denominador y las reporta', () => {
    const rows = [
      fila({ 2: 5 }, {}),   // ofreció (terminal aunque sea joven)
      fila({}, {}),         // ventana abierta → pending
      fila({}, {}),         // ventana abierta → pending
      { timestamp: '2026-01-01T00:00:00.000Z', path_first_passage: { up: {}, down: {} } },
    ];
    const s = summarizeOpportunity(rows, { horizonH: 24, now: T0 + 6 * H });
    expect(s.n).toBe(4);
    expect(s.pending_n).toBe(2);
    expect(s.evaluable_n).toBe(2);        // la que ofreció + la madura de enero
    expect(s.offered_pct).toBe(50);       // 1 de 2, no 1 de 4
  });

  test('con TODA la muestra joven no se publica un lift (el caso que lo destapó)', () => {
    const rows = [fila({}, {}), fila({}, {}), fila({}, {})];
    const s = summarizeOpportunity(rows, { horizonH: null, now: T0 + 66 * H });
    expect(s.pending_n).toBe(3);
    expect(s.evaluable_n).toBe(0);
    expect(s.offered_pct).toBeNull();
    expect(s.lift_pct).toBeNull();        // antes: 0,0 % con lift −36
  });
});

// ─── Alcanzabilidad del objetivo (2026-08-01) ────────────────────────────────
// Reemplaza al retirado `conditional_low_rr`: no juzga la calidad de la geometría (plana
// en R:R) sino si el objetivo declarado es alcanzable en las velas que el propio análisis
// declara. Eje y curva medidos en `scripts/auditTargetReachability.mjs`.
describe('normalizedTargetDistance + targetReachabilityFor', () => {
  test('el ATR se cancela: d depende solo de k/√velas', () => {
    // Mismo k=2 y V=6 con ATR% muy distintos → la MISMA distancia normalizada.
    const d1 = normalizedTargetDistance({
      tp1Price: 104, entryPrice: 100, atrPct: 2, validityCandles: 6, tfExecution: '4h', primaryTf: '4h',
    });
    const d2 = normalizedTargetDistance({
      tp1Price: 101, entryPrice: 100, atrPct: 0.5, validityCandles: 6, tfExecution: '4h', primaryTf: '4h',
    });
    expect(d1).toBeCloseTo(2 / Math.sqrt(6), 6);
    expect(d2).toBeCloseTo(d1, 6);
  });

  test('convierte la vigencia al TF del ATR (no mezcla velas de distinto tamaño)', () => {
    // 24 velas de 1h = 6 velas de 4h: la misma vigencia real debe dar la misma d.
    const en1h = normalizedTargetDistance({
      tp1Price: 104, entryPrice: 100, atrPct: 2, validityCandles: 24, tfExecution: '1h', primaryTf: '4h',
    });
    expect(en1h).toBeCloseTo(2 / Math.sqrt(6), 6);
  });

  test('sin ATR% no se inventa una distancia', () => {
    expect(normalizedTargetDistance({
      tp1Price: 104, entryPrice: 100, atrPct: null, validityCandles: 6, tfExecution: '4h', primaryTf: '4h',
    })).toBeNull();
    expect(targetReachabilityFor(null)).toBeNull();
  });

  test('la curva es monótona decreciente y se ancla en los extremos (no extrapola)', () => {
    const ds = [0.1, 0.4, 0.8, 1.2, 1.5, 2.0, 2.5];
    const ps = ds.map(targetReachabilityFor);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeLessThan(ps[i - 1]);
    expect(targetReachabilityFor(0)).toBe(targetReachabilityFor(0.1));
    expect(targetReachabilityFor(99)).toBe(targetReachabilityFor(2.5));
  });

  test('los dos condicionales reales que motivaron la regla caen bajo el umbral', () => {
    // 01-08 04:07 y 08:05: tp1 a 4,55/4,63×ATR con vigencia de 6 velas de 4h.
    for (const k of [4.55, 4.63]) {
      const d = k / Math.sqrt(6);
      expect(targetReachabilityFor(d)).toBeLessThan(TARGET_UNREACHABLE_PCT);
    }
    // Y el resto NO: la regla discrimina en vez de marcarlo todo.
    for (const [k, V] of [[2.83, 12], [2.12, 6], [2.50, 12], [1.69, 6], [2.86, 6]]) {
      expect(targetReachabilityFor(k / Math.sqrt(V))).toBeGreaterThan(TARGET_UNREACHABLE_PCT);
    }
  });
});
