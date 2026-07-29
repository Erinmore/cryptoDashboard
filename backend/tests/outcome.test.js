/**
 * outcome.test.js — funciones puras de backtesting (utils/outcome.js).
 */

import { describe, test, expect } from '@jest/globals';
import {
  classifyOutcome, evaluateSetupBarrier, setupExpiryMs, candlesWithinValidity,
} from '../src/utils/outcome.js';

describe('classifyOutcome', () => {
  test('Comprar con subida → win', () => {
    expect(classifyOutcome('Comprar', 100, 102)).toBe('win');
  });
  test('Comprar con bajada → loss', () => {
    expect(classifyOutcome('Comprar', 100, 98)).toBe('loss');
  });
  test('Vender con bajada → win (a favor del short)', () => {
    expect(classifyOutcome('Vender', 100, 98)).toBe('win');
  });
  test('Vender con subida → loss', () => {
    expect(classifyOutcome('Vender', 100, 102)).toBe('loss');
  });
  test('movimiento dentro de la banda muerta → flat', () => {
    expect(classifyOutcome('Comprar', 100, 100.1)).toBe('flat'); // 0.1% < 0.3%
  });
  test('Esperar con movimiento relevante → moved', () => {
    expect(classifyOutcome('Esperar', 100, 105)).toBe('moved');
  });
  test('Esperar sin movimiento → flat', () => {
    expect(classifyOutcome('Esperar', 100, 100.1)).toBe('flat');
  });
  test('Preparar tratado como no direccional', () => {
    expect(classifyOutcome('Preparar', 100, 110)).toBe('moved');
  });
  test('datos faltantes → null', () => {
    expect(classifyOutcome('Comprar', null, 100)).toBeNull();
    expect(classifyOutcome('Comprar', 100, null)).toBeNull();
    expect(classifyOutcome('Comprar', 0, 100)).toBeNull();
  });
  test('threshold personalizado respeta la banda', () => {
    expect(classifyOutcome('Comprar', 100, 101, 2)).toBe('flat'); // 1% < 2%
    expect(classifyOutcome('Comprar', 100, 103, 2)).toBe('win');  // 3% > 2%
  });
});

describe('evaluateSetupBarrier — long (stop < entry)', () => {
  const setup = { entry_price: 100, stop_price: 95, tp1_price: 105, tp2_price: 110 };

  test('toca TP1 y luego TP2 → tp2', () => {
    const candles = [
      { high: 103, low: 99 },
      { high: 106, low: 102 }, // TP1
      { high: 111, low: 107 }, // TP2
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('tp2');
    expect(r.hit_tp1).toBe(true);
    expect(r.hit_tp2).toBe(true);
    expect(r.hit_stop).toBe(false);
  });

  test('toca el stop antes que TP → stop', () => {
    const candles = [
      { high: 102, low: 99 },
      { high: 103, low: 94 }, // stop
      { high: 106, low: 101 },
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('stop');
    expect(r.hit_stop).toBe(true);
    expect(r.hit_tp1).toBe(false);
  });

  test('TP1 y stop en la misma vela → conservador: stop primero', () => {
    const candles = [{ high: 106, low: 94 }];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('stop');
  });

  test('tras TP1 ignora el stop (break-even) → se queda en tp1', () => {
    const candles = [
      { high: 101, low: 99 },  // fill (contiene entry 100)
      { high: 106, low: 102 }, // TP1
      { high: 107, low: 93 },  // caería al stop, pero ya se ignora
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('tp1');
    expect(r.hit_tp1).toBe(true);
    expect(r.hit_stop).toBe(false);
  });

  test('entrada llenada pero sin tocar nada → open', () => {
    const candles = [{ high: 103, low: 98 }, { high: 104, low: 99 }];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('open');
    expect(r.filled).toBe(true);
  });
});

describe('evaluateSetupBarrier — gating de entrada (A1)', () => {
  const longSetup = { entry_price: 100, stop_price: 95, tp1_price: 105, tp2_price: 110 };

  test('long: el precio se aleja al alza sin tocar la entrada y llega a TP → not_triggered (no cuenta como win)', () => {
    // low siempre > 100: la orden límite en 100 nunca se llena aunque el precio pase por 105/110.
    const candles = [
      { high: 108, low: 103 }, // pasa por TP1/TP2 pero sin haber llenado la entrada
      { high: 112, low: 106 },
    ];
    const r = evaluateSetupBarrier(longSetup, candles);
    expect(r.outcome).toBe('not_triggered');
    expect(r.filled).toBe(false);
    expect(r.hit_tp1).toBe(false);
  });

  test('long: entrada tocada en una vela posterior y luego TP1 → tp1', () => {
    const candles = [
      { high: 108, low: 103 }, // aún sin fill (low 103 > entry 100)
      { high: 101, low: 99 },  // fill (contiene 100)
      { high: 106, low: 102 }, // TP1
    ];
    const r = evaluateSetupBarrier(longSetup, candles);
    expect(r.outcome).toBe('tp1');
    expect(r.filled).toBe(true);
  });

  test('short: el precio se aleja a la baja sin tocar la entrada → not_triggered', () => {
    const shortSetup = { entry_price: 100, stop_price: 105, tp1_price: 95, tp2_price: 90 };
    const candles = [
      { high: 99, low: 94 }, // high 99 < entry 100: nunca se llena
      { high: 96, low: 89 },
    ];
    const r = evaluateSetupBarrier(shortSetup, candles);
    expect(r.outcome).toBe('not_triggered');
    expect(r.filled).toBe(false);
  });
});

describe('evaluateSetupBarrier — short (stop > entry)', () => {
  const setup = { entry_price: 100, stop_price: 105, tp1_price: 95, tp2_price: 90 };

  test('precio baja a TP1 y TP2 → tp2', () => {
    const candles = [
      { high: 101, low: 97 },
      { high: 99, low: 94 },  // TP1
      { high: 96, low: 89 },  // TP2
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('tp2');
  });

  test('precio sube al stop → stop', () => {
    const candles = [{ high: 106, low: 99 }];
    expect(evaluateSetupBarrier(setup, candles).outcome).toBe('stop');
  });
});

describe('evaluateSetupBarrier — validación', () => {
  test('setup inválido (stop == entry) → null', () => {
    expect(evaluateSetupBarrier({ entry_price: 100, stop_price: 100 }, [{ high: 1, low: 1 }])).toBeNull();
  });
  test('sin velas → null', () => {
    expect(evaluateSetupBarrier({ entry_price: 100, stop_price: 95 }, [])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vigencia del setup (2026-07-28) — `setup_validity_candles` se persistía y no lo
// leía nadie: el barrier recorría los 7d completos y acreditaba como `tp1` un TP
// tocado mucho después de que el propio análisis se declarase caducado.
// ─────────────────────────────────────────────────────────────────────────────

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 6, 28, 8, 0, 0);

describe('setupExpiryMs', () => {
  test('4h × 6 velas = 24h desde el análisis', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: 6, tfExecution: '4h' })).toBe(T0 + 24 * H);
  });

  test('tf_execution manda sobre primary_tf', () => {
    // El setup se ejecuta en 1h aunque el análisis sea de 4h → 3h, no 12h.
    expect(setupExpiryMs({ tMs: T0, validityCandles: 3, tfExecution: '1h', primaryTf: '4h' }))
      .toBe(T0 + 3 * H);
  });

  test('cae a primary_tf si no hay tf_execution', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: 2, primaryTf: '1D' })).toBe(T0 + 48 * H);
  });

  test('FAIL-OPEN: sin vigencia utilizable → null (el caller no recorta)', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: null, tfExecution: '4h' })).toBeNull();
    expect(setupExpiryMs({ tMs: T0, validityCandles: 0, tfExecution: '4h' })).toBeNull();
    expect(setupExpiryMs({ tMs: T0, validityCandles: -3, tfExecution: '4h' })).toBeNull();
    expect(setupExpiryMs({ tMs: T0, validityCandles: 'seis', tfExecution: '4h' })).toBeNull();
  });

  test('FAIL-OPEN: TF no reconocido o timestamp inválido → null', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: 6, tfExecution: '30m' })).toBeNull();
    expect(setupExpiryMs({ tMs: NaN, validityCandles: 6, tfExecution: '4h' })).toBeNull();
  });
});

describe('candlesWithinValidity', () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * H, high: 1, low: 1 }));

  test('recorta a las velas que ABREN antes de la caducidad', () => {
    const r = candlesWithinValidity(candles, T0 + 4 * H);
    expect(r).toHaveLength(4);                    // t = T0, +1h, +2h, +3h
    expect(r.at(-1).t).toBe(T0 + 3 * H);
  });

  test('la vela que abre justo en la caducidad queda FUERA', () => {
    expect(candlesWithinValidity(candles, T0 + 1 * H)).toHaveLength(1);
  });

  test('expiry null → serie intacta (misma referencia, sin copia)', () => {
    expect(candlesWithinValidity(candles, null)).toBe(candles);
  });

  test('serie vacía o no-array → se devuelve tal cual', () => {
    expect(candlesWithinValidity([], T0)).toEqual([]);
    expect(candlesWithinValidity(null, T0)).toBeNull();
  });
});

describe('vigencia × barrier — el caso que motivó el arreglo', () => {
  // Long: entrada 100, stop 95, TP1 110. Se llena en la 1ª vela, no pasa nada durante
  // la vigencia (6 velas de 4h = 24h) y el TP se toca al 5º día.
  const setup = { entry_price: 100, stop_price: 95, tp1_price: 110 };
  const candles = [
    { t: T0, high: 101, low: 99 },                                                  // llena
    ...Array.from({ length: 23 }, (_, i) => ({ t: T0 + (i + 1) * H, high: 102, low: 98 })),
    { t: T0 + 120 * H, high: 115, low: 101 },                                       // TP1 al 5º día
  ];
  const expiry = setupExpiryMs({ tMs: T0, validityCandles: 6, tfExecution: '4h' });

  test('sin acotar (comportamiento viejo) el TP tardío contaba como tp1', () => {
    expect(evaluateSetupBarrier(setup, candles).outcome).toBe('tp1');
  });

  test('acotado a su vigencia queda open → el caller lo cierra como expired', () => {
    const r = evaluateSetupBarrier(setup, candlesWithinValidity(candles, expiry));
    expect(r.filled).toBe(true);
    expect(r.hit_tp1).toBe(false);
    expect(r.outcome).toBe('open');
  });

  test('un stop DENTRO de la vigencia sigue contando (el recorte no favorece al setup)', () => {
    const conStop = [
      { t: T0,           high: 101, low: 99 },
      { t: T0 + 5 * H,   high: 99,  low: 94 },    // stop, dentro de las 24h
      { t: T0 + 120 * H, high: 115, low: 101 },   // TP posterior, irrelevante
    ];
    expect(evaluateSetupBarrier(setup, candlesWithinValidity(conStop, expiry)).outcome).toBe('stop');
  });
});
