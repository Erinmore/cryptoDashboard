import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TF_DURATION_MS, TF_DURATION_HOURS, TIMEFRAME_MINUTES } from '../src/config/constants.js';
import { setupExpiryMs } from '../src/utils/outcome.js';
import { describeConditionalPlan } from '../src/utils/conditionalPlan.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * B3 — "cuánto dura una vela" tiene UN dueño.
 *
 * Había SEIS copias (constants, outcome, episodes, derivativesScore, stats, conditionalPlan).
 * Medidas antes de unificar: las seis COINCIDÍAN, así que no había bug — había superficie de
 * bug. Estos tests convierten esa superficie en un fallo ruidoso.
 */
describe('B3 · dueño único de la duración de vela', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });

  test('ningún módulo define su propia tabla de duración por TF', () => {
    // Busca literales con las cuatro claves de TF juntas: la firma de una tabla nueva.
    const patron = /\{[^{}]*['"]1h['"]\s*:[^{}]*['"]4h['"]\s*:[^{}]*['"]1D['"]\s*:[^{}]*['"]1W['"]\s*:[^{}]*\}/;
    const ofensas = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join('config', 'constants.js'))) continue;   // el dueño
      const txt = fs.readFileSync(file, 'utf8');
      txt.split('\n').forEach((ln, i) => {
        // Sólo interesan las que mapean a DURACIONES (números), no a intervalos ni límites.
        if (patron.test(ln) && /:\s*\d/.test(ln) && /(_MS|_HOURS|_MINUTES|HOUR|3600|86400)/i.test(ln)) {
          ofensas.push(`${path.relative(SRC, file)}:${i + 1}`);
        }
      });
    }
    expect(ofensas).toEqual([]);   // si falla: importa TF_DURATION_MS/HOURS de config/constants
  });

  test('las dos derivadas salen del MISMO juego de números', () => {
    for (const tf of Object.keys(TIMEFRAME_MINUTES)) {
      expect(TF_DURATION_MS[tf]).toBe(TIMEFRAME_MINUTES[tf] * 60_000);
      expect(TF_DURATION_HOURS[tf]).toBe(TIMEFRAME_MINUTES[tf] / 60);
      expect(TF_DURATION_MS[tf]).toBe(TF_DURATION_HOURS[tf] * 3_600_000);
    }
  });

  /**
   * LA PROPIEDAD QUE DE VERDAD IMPORTA. El panel enseña "válido hasta X" y el evaluador cierra
   * el shadow trade en su propia caducidad. Si divergieran, el usuario leería una promesa que
   * el sistema no cumple — y nada avisaría. Con un solo dueño no pueden discrepar.
   */
  test('la caducidad que se PINTA es la misma que el evaluador APLICA', () => {
    const t0 = '2026-08-03T08:05:55.077Z';
    for (const [tf, candles] of [['4h', 12], ['1h', 6], ['1D', 3], ['4h', 42]]) {
      const plan = describeConditionalPlan({
        conditionalSetup: {
          direction: 'short', entry_price: 71.9, stop_price: 73.6, tp1_price: 68.32,
          validity_candles: candles, tf_execution: tf,
        },
        primaryTf: '4h', timestamp: t0,
      });
      const evaluador = setupExpiryMs({
        tMs: Date.parse(t0), validityCandles: candles, tfExecution: tf, primaryTf: '4h',
      });
      expect(Date.parse(plan.expires_at)).toBe(evaluador);
    }
  });
});
