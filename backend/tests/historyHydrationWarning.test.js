import { jest } from '@jest/globals';

/**
 * Sólo CVD y VWAP se hidratan desde `history_series`; el resto de series las rellenan de nuevo
 * sus propias APIs en cada poll. Esa asimetría es deliberada y correcta —ninguna API sirve el
 * CVD ya calculado— pero deja a esas dos dependiendo de que la BBDD esté disponible.
 *
 * `getDb()` LANZA si nadie ha llamado a `initDb()`, y `loadSeries` capturaba ese error
 * devolviendo `[]` con un log de nivel `debug`. Resultado: **"no he podido mirar" y "la serie
 * está vacía" eran indistinguibles**, y en producción el aviso ni se veía.
 *
 * No es un bug activo (en producción `app.js` inicializa la BBDD antes que nada), pero sí una
 * degradación silenciosa que produce un valor PLAUSIBLE — y mordió: el diff del payload de B5
 * (2026-08-04) pasó por vacío sobre CVD y VWAP creyendo que las series estaban vacías, y sólo
 * se detectó comprobando la cobertura a mano.
 *
 * Este test fija que el caso ruidoso siga siendo ruidoso. ⚠️ NO llama a `initDb()` a propósito:
 * es justo el estado que se quiere ejercitar. Y por eso importa `historyService` de forma
 * DINÁMICA tras mockear el logger — con un import estático el módulo se evaluaría antes que el
 * mock (mismo motivo por el que los tests de BBDD de este proyecto usan imports dinámicos).
 */
describe('hidratación de CVD/VWAP sin BBDD inicializada', () => {
  let hs, warn;

  beforeAll(async () => {
    warn = jest.fn();
    jest.unstable_mockModule('../src/middleware/logger.js', () => ({
      default: { warn, debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    }));
    hs = await import('../src/services/historyService.js');
  });

  test('degrada a serie vacía en vez de tumbar la app', () => {
    const h = hs.getHistories('SOL');
    expect(h.cvd).toEqual([]);
    expect(h.vwap).toEqual([]);
  });

  test('pero AVISA en warn — "no se ha leído" no puede parecer "está vacía"', () => {
    const metricas = warn.mock.calls.map(([ctx]) => ctx?.metric);
    expect(metricas).toEqual(expect.arrayContaining(['cvd', 'vwap']));
    const [, mensaje] = warn.mock.calls[0];
    expect(mensaje).toMatch(/BBDD no disponible/);
  });
});
