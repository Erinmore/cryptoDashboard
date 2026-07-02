import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

// DB temporal aislada — evita tocar backend/data/cryptex.db.
const TMP_DB = path.join(os.tmpdir(), `cryptex-hist-${process.pid}-${Date.now()}.db`);
const ORIG_DB_PATH = process.env.DB_PATH;

describe('history_series persistence', () => {
  let hs, dbmod;

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    hs = await import('../src/services/historyService.js');
  });

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch { /* noop */ }
    }
    // Restaurar para no filtrar la ruta temporal a otros ficheros de test (mismo proceso).
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  test('CVD write-through persists rows to DB', () => {
    hs.addCVDEntry('BTC', '2026-06-01', 100, 'rising', null);
    hs.addCVDEntry('BTC', '2026-06-02', 110, 'rising', null);
    const rows = dbmod.getDb()
      .prepare(`SELECT ts_key, payload FROM history_series WHERE coin=? AND metric=? ORDER BY ts_key`)
      .all('BTC', 'cvd');
    expect(rows.length).toBe(2);
    expect(JSON.parse(rows[1].payload).value).toBe(110);
  });

  test('same-day re-add upserts (no duplicate row)', () => {
    hs.addCVDEntry('BTC', '2026-06-02', 115, 'rising', null); // overwrite 2026-06-02
    const row = dbmod.getDb()
      .prepare(`SELECT COUNT(*) n FROM history_series WHERE coin=? AND metric=?`)
      .get('BTC', 'cvd');
    expect(row.n).toBe(2); // still 2, not 3
  });

  test('funding_rate persists to DB even though not hydrated', () => {
    hs.addFundingRateEntry('BTC', { t: 1775109600, o: 0.01, h: 0.01, l: 0.01, c: 0.01, trend: 'stable' });
    const row = dbmod.getDb()
      .prepare(`SELECT COUNT(*) n FROM history_series WHERE coin=? AND metric=?`)
      .get('BTC', 'funding_rate');
    expect(row.n).toBe(1);
  });

  test('fear_greed persists under GLOBAL coin', () => {
    hs.addFearGreedEntry(50, 'Neutral', 'stable', '2026-06-02');
    const row = dbmod.getDb()
      .prepare(`SELECT COUNT(*) n FROM history_series WHERE coin='GLOBAL' AND metric='fear_greed'`)
      .get();
    expect(row.n).toBeGreaterThanOrEqual(1);
  });

  test('A7 — backfill desordenado/con duplicados deduplica por clave y queda ordenado', () => {
    // Reenviar candles fuera de orden y repetidos (simula backfills solapados de Coinalyze).
    const t0 = 1775000000;
    const H = 6 * 3600; // funding cada 6h
    hs.addFundingRateEntry('ETH', { t: t0 + 2 * H, o: 0.03, h: 0, l: 0, c: 0.03 });
    hs.addFundingRateEntry('ETH', { t: t0,         o: 0.01, h: 0, l: 0, c: 0.01 });
    hs.addFundingRateEntry('ETH', { t: t0 + 1 * H, o: 0.02, h: 0, l: 0, c: 0.02 });
    hs.addFundingRateEntry('ETH', { t: t0 + 2 * H, o: 0.99, h: 0, l: 0, c: 0.99 }); // upsert del mismo t

    const fr = hs.getHistories('ETH').funding_rate;
    expect(fr.map((e) => e.t)).toEqual([t0, t0 + 1 * H, t0 + 2 * H]); // ordenado, sin duplicados
    expect(fr.at(-1).c).toBe(0.99);                                    // el upsert ganó
  });

  test('CVD/VWAP hydrate into memory after a simulated restart; backfilled metrics do not', async () => {
    hs.addVWAPEntry('BTC', '2026-06-02', 200, 'rising', null);

    // Simular reinicio: cerrar, resetear módulos, re-importar y re-inicializar sobre el mismo fichero.
    dbmod.closeDb();
    jest.resetModules();
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    hs = await import('../src/services/historyService.js');

    const h = hs.getHistories('BTC');
    expect(h.cvd.length).toBe(2);
    expect(h.cvd.at(-1).value).toBe(115);
    expect(h.vwap.length).toBe(1);
    expect(h.vwap.at(-1).value).toBe(200);
    // Funding se rellena fresco desde su API en cada poll ⇒ NO se hidrata en memoria.
    expect(h.funding_rate.length).toBe(0);
  });
});
