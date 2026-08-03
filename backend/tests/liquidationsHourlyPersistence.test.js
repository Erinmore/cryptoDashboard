import os from 'os';
import path from 'path';
import fs from 'fs';

// DB temporal aislada. `config/env.js` captura `dbPath` al evaluarse, así que DB_PATH se fija
// ANTES de cualquier import de src/ y todo entra por `await import()` (patrón de
// historyPersistence.test.js; un import estático escribiría en la BBDD real).
const TMP_DB = path.join(os.tmpdir(), `cryptex-liq1h-${process.pid}-${Date.now()}.db`);
const ORIG_DB_PATH = process.env.DB_PATH;

const HOUR = 3600;
/** Velas horarias sintéticas terminando en `endSec`, formato Coinalyze (`t`,`l`,`s`). */
const candles = (endSec, n, from = 0) => Array.from({ length: n }, (_, i) => ({
  t: endSec - (n - 1 - i) * HOUR,
  l: from + i,
  s: from + i * 2,
}));

describe('liquidations_1h — serie de archivo (persistencia horaria)', () => {
  let hs, dbmod, db;
  const NOW = Math.floor(Date.UTC(2026, 7, 1, 12, 0, 0) / 1000);

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    db = dbmod.getDb();
    // Guarda: si la BBDD activa no fuera la temporal, el test escribiría en la real.
    const file = db.pragma('database_list')[0].file;
    expect(file).toBe(TMP_DB);
    hs = await import('../src/services/historyService.js');
  });

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch { /* noop */ }
    }
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  const rows = (coin) => db.prepare(
    'SELECT ts_key, payload FROM history_series WHERE coin=? AND metric=? ORDER BY ts_key',
  ).all(coin, 'liquidations_1h');

  test('escribe una fila por vela horaria, con ts_key = t del candle', () => {
    const written = hs.addLiquidationsHourlyEntries('SOL', candles(NOW, 5));
    expect(written).toBe(5);
    const r = rows('SOL');
    expect(r.length).toBe(5);
    expect(r.at(-1).ts_key).toBe(NOW);
    expect(r[1].ts_key - r[0].ts_key).toBe(HOUR);
  });

  test('unidad en MONEDAS BASE — nunca claves *_usd', () => {
    const p = JSON.parse(rows('SOL')[0].payload);
    expect(p).toHaveProperty('longs_coins');
    expect(p).toHaveProperty('shorts_coins');
    expect(p).not.toHaveProperty('longs_usd');
    expect(p.t).toBe(rows('SOL')[0].ts_key);
  });

  test('incremental: reenviar la MISMA ventana no duplica ni reescribe lo viejo', () => {
    const before = rows('SOL').length;
    // Sólo las 2 últimas horas caen dentro del margen de reescritura → se reescriben.
    const written = hs.addLiquidationsHourlyEntries('SOL', candles(NOW, 5, 100));
    expect(written).toBeLessThanOrEqual(3);
    expect(rows('SOL').length).toBe(before);          // ninguna fila nueva
    expect(JSON.parse(rows('SOL')[0].payload).longs_coins).toBe(0);  // la vieja, intacta
  });

  test('la última vela SÍ se reescribe (puede estar formándose al descargarla)', () => {
    hs.addLiquidationsHourlyEntries('SOL', [{ t: NOW, l: 999, s: 111 }]);
    expect(JSON.parse(rows('SOL').at(-1).payload).longs_coins).toBe(999);
  });

  test('sólo escribe lo nuevo cuando la ventana avanza', () => {
    const before = rows('SOL').length;
    const written = hs.addLiquidationsHourlyEntries('SOL', candles(NOW + 3 * HOUR, 8));
    expect(written).toBe(3 + 2);       // 3 horas nuevas + las 2 del margen de reescritura
    expect(rows('SOL').length).toBe(before + 3);
  });

  test('las series por moneda son independientes', () => {
    hs.addLiquidationsHourlyEntries('BTC', candles(NOW, 4));
    expect(rows('BTC').length).toBe(4);
    expect(rows('SOL').length).toBeGreaterThan(4);
  });

  test('NO contamina la serie diaria (dos granularidades, dos métricas)', () => {
    const daily = () => db.prepare(
      "SELECT COUNT(*) n FROM history_series WHERE metric='liquidations_1d'",
    ).get().n;
    expect(daily()).toBe(0);
    hs.addLiquidationsDailyEntry('SOL', '2026-08-01', 10, 20);
    expect(daily()).toBe(1);
    // Y la horaria sigue siendo suya: la diaria no le ha añadido filas.
    expect(rows('SOL').every((r) => r.ts_key % HOUR === 0)).toBe(true);
    // El nombre SIN sufijo no debe existir ya en ninguna fila nueva.
    expect(db.prepare("SELECT COUNT(*) n FROM history_series WHERE metric='liquidations'").get().n).toBe(0);
  });

  test('NO entra en la ventana en memoria del LLM', () => {
    const h = hs.getHistories('SOL');
    // La diaria sí está (una entrada del test anterior); la horaria no aparece por ningún lado.
    expect(h.liquidations.length).toBe(1);
    expect(h).not.toHaveProperty('liquidations_1h');
    expect(h).not.toHaveProperty('liquidationsHourly');
  });

  test('entradas inservibles se ignoran sin lanzar', () => {
    const before = rows('BTC').length;
    expect(hs.addLiquidationsHourlyEntries('BTC', [
      { t: null, l: 1, s: 1 }, { t: NOW + 99 * HOUR, l: null, s: null }, null,
    ])).toBe(0);
    expect(rows('BTC').length).toBe(before);
    expect(hs.addLiquidationsHourlyEntries('BTC', [])).toBe(0);
    expect(hs.addLiquidationsHourlyEntries(null, candles(NOW, 2))).toBe(0);
  });

  test('poda lo anterior a la retención (400 días)', () => {
    const old = Math.floor(Date.now() / 1000) - 401 * 86400;
    db.prepare('INSERT INTO history_series (coin, metric, ts_key, payload) VALUES (?,?,?,?)')
      .run('ETH', 'liquidations_1h', old, '{}');
    expect(rows('ETH').length).toBe(1);
    hs.addLiquidationsHourlyEntries('ETH', candles(Math.floor(Date.now() / 1000), 2));
    expect(rows('ETH').some((r) => r.ts_key === old)).toBe(false);
  });
});
