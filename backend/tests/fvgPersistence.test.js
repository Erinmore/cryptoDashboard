/**
 * fvgPersistence.test.js — analysis_fvg_snapshot contra una BD real (deuda §6).
 *
 * Verifica lo que los tests puros de buildFvgRows NO pueden: que los nombres de los
 * parámetros del INSERT (@zone_low, @formed_t…) casan con las claves de las filas
 * construidas. Un desajuste ahí sólo revienta en runtime.
 *
 * IMPORTANTE — aislamiento: TODOS los imports de src/ son DINÁMICOS y posteriores a fijar
 * DB_PATH. `config/env.js` captura `dbPath` al evaluarse el módulo, así que un import
 * estático (aunque sea de analysisController, que arrastra dbService → db.js) congelaría
 * la ruta por defecto y los tests escribirían en backend/data/cryptex.db, la BD real.
 * Mismo patrón que historyPersistence.test.js.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('analysis_fvg_snapshot — persistencia contra BD real', () => {
  const TMP_DB = path.join(os.tmpdir(), `cryptex-fvg-${process.pid}-${Date.now()}.db`);
  const ORIG_DB_PATH = process.env.DB_PATH;
  let dbmod, dbService, buildFvgRows;

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    dbService = await import('../src/services/dbService.js');
    ({ buildFvgRows } = await import('../src/controllers/analysisController.js'));
  });

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch { /* noop */ }
    }
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  // Guarda de seguridad: si el aislamiento fallara, estaríamos escribiendo en la BD de
  // desarrollo. Mejor fallar aquí y ruidosamente que ensuciarla en silencio.
  test('la BD activa es la temporal, no la de desarrollo', () => {
    const file = dbmod.getDb().prepare('PRAGMA database_list').get().file;
    expect(file).toBe(TMP_DB);
    expect(file).not.toMatch(/data[/\\]cryptex\.db$/);
  });

  // El INSERT de `analyses` exige TODOS sus parámetros con nombre. En vez de escribir los
  // ~70 campos a mano (y tocarlos cada vez que se añada una columna), derivamos el header
  // del propio esquema: todo a null y luego lo mínimo que importa.
  const header = (id) => {
    const cols = dbmod.getDb().prepare('PRAGMA table_info(analyses)').all().map((c) => c.name);
    return {
      ...Object.fromEntries(cols.map((c) => [c, null])),
      id, coin: 'SOL', primary_tf: '4h', timestamp: new Date().toISOString(),
      prompt_version: 'test', action: 'Esperar', has_executable_setup: 0,
      gating_active: 0, contradictions_found: 0,
    };
  };

  test('saveAnalysis persiste las filas FVG con su geometría intacta', () => {
    const technical = {
      '4h': { smc: { unmitigated_fvgs: {
        bullish: [{ low: 95, high: 98, size_pct: 3.16, mitigation_pct: 12.5, candles_ago: 3, signal_status: 'active', t_right: 1700000000 }],
        bearish: [{ low: 110, high: 112, size_pct: 1.8, mitigation_pct: 0, candles_ago: 7, signal_status: 'context', t_right: 1700003600 }],
      } } },
    };
    const fvgs = buildFvgRows('fvg-1', technical, 100);
    expect(fvgs).toHaveLength(2);

    // No debe lanzar: si los @params no casaran con las claves, better-sqlite3 falla aquí.
    dbService.saveAnalysis({ header: header('fvg-1'), tfSnapshots: [], clusters: [], fvgs });

    const rows = dbmod.getDb()
      .prepare('SELECT * FROM analysis_fvg_snapshot WHERE analysis_id = ? ORDER BY fvg_type')
      .all('fvg-1');
    expect(rows).toHaveLength(2);

    expect(rows.find(r => r.fvg_type === 'bearish')).toMatchObject({
      tf: '4h', fvg_rank: 0, zone_low: 110, zone_high: 112, size_pct: 1.8,
      mitigation_pct: 0, candles_ago: 7, signal_status: 'context', formed_t: 1700003600,
      distance_pct: 10,
    });
    const bull = rows.find(r => r.fvg_type === 'bullish');
    expect(bull.zone_low).toBe(95);
    expect(bull.mitigation_pct).toBe(12.5);
    expect(bull.distance_pct).toBe(-2);
  });

  test('un análisis sin FVGs guarda sin filas y sin romper la transacción', () => {
    dbService.saveAnalysis({ header: header('fvg-empty'), tfSnapshots: [], clusters: [], fvgs: [] });
    const rows = dbmod.getDb()
      .prepare('SELECT * FROM analysis_fvg_snapshot WHERE analysis_id = ?').all('fvg-empty');
    expect(rows).toHaveLength(0);
  });

  test('saveAnalysis sin la clave fvgs (retrocompat) no rompe', () => {
    expect(() => dbService.saveAnalysis({ header: header('fvg-legacy'), tfSnapshots: [], clusters: [] }))
      .not.toThrow();
  });
});
