/**
 * btcContextPersistence.test.js — `btc_trend_1d` / `btc_trend_1w` en analyses (F2, 2026-07-29).
 *
 * Por qué existe: el BTC DOMINANCE OVERRIDE degrada cualquier Comprar de un alt cuando la
 * estructura 1D de BTC es bajista. Si BTC pasa bajista un tramo del periodo de recogida, el
 * reparto de acciones saldrá sin Comprar POR DISEÑO — y sin esta covariable persistida el
 * checkpoint no podría separar "Volume bloquea" de "BTC bloquea" sin reconstruir klines de
 * BTC a posteriori. Misma motivación que cvdStrengthPersistence.test.js: particionar la
 * muestra por el estado de la puerta.
 *
 * IMPORTANTE — aislamiento: TODOS los imports de src/ son DINÁMICOS y posteriores a fijar
 * DB_PATH (`config/env.js` congela `dbPath` al evaluarse). Mismo patrón que
 * fvgPersistence.test.js / cvdStrengthPersistence.test.js.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('analyses — persistencia del contexto BTC (btc_trend_1d / btc_trend_1w)', () => {
  const TMP_DB = path.join(os.tmpdir(), `cryptex-btcctx-${process.pid}-${Date.now()}.db`);
  const ORIG_DB_PATH = process.env.DB_PATH;
  let dbmod, dbService, buildAnalysisHeader;

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    dbService = await import('../src/services/dbService.js');
    ({ buildAnalysisHeader } = await import('../src/controllers/analysisController.js'));
  });

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch { /* noop */ }
    }
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  // Guarda de seguridad: si el aislamiento fallara estaríamos escribiendo en la BD de
  // desarrollo. Mejor fallar aquí y ruidosamente que ensuciarla en silencio.
  test('la BD activa es la temporal, no la de desarrollo', () => {
    const file = dbmod.getDb().prepare('PRAGMA database_list').get().file;
    expect(file).toBe(TMP_DB);
    expect(file).not.toMatch(/data[/\\]cryptex\.db$/);
  });

  const minimalStructured = {
    action: 'Esperar', confidence: 'Media', risk_score: 5, conviction: 0.5,
    has_executable_setup: false, gating_active: false, setup: null,
    scores: { derivatives: 0, structure: 0, volume: 0, onchain: 0, total: 0 },
    executive_summary: 'test',
  };

  test('buildAnalysisHeader mapea btc_context → btc_trend_1d/1w', () => {
    const context = { btc_context: { trend_1d: 'bearish', trend_1w: 'neutral', source: 'btc_klines' } };
    const header = buildAnalysisHeader('btc-1', 'SOL', '4h', context, minimalStructured, {}, 100);
    expect(header.btc_trend_1d).toBe('bearish');
    expect(header.btc_trend_1w).toBe('neutral');
  });

  test('saveAnalysis los persiste (los @params casan con las claves de la fila)', () => {
    const context = { btc_context: { trend_1d: 'strongly_bearish', trend_1w: 'bearish', source: 'btc_klines' } };
    const header = buildAnalysisHeader('btc-1', 'SOL', '4h', context, minimalStructured, {}, 100);
    dbService.saveAnalysis({ header, tfSnapshots: [], clusters: [], fvgs: [] });

    const row = dbmod.getDb()
      .prepare('SELECT btc_trend_1d, btc_trend_1w FROM analyses WHERE id = ?').get('btc-1');
    expect(row).toEqual({ btc_trend_1d: 'strongly_bearish', btc_trend_1w: 'bearish' });
  });

  test('btc_context ausente (fetch fallido) no rompe: se persiste NULL', () => {
    const header = buildAnalysisHeader('btc-null', 'SOL', '4h', {}, minimalStructured, {}, 100);
    dbService.saveAnalysis({ header, tfSnapshots: [], clusters: [], fvgs: [] });

    const row = dbmod.getDb()
      .prepare('SELECT btc_trend_1d, btc_trend_1w FROM analyses WHERE id = ?').get('btc-null');
    expect(row).toEqual({ btc_trend_1d: null, btc_trend_1w: null });
  });

  // El punto de todo el ejercicio: la partición del checkpoint es una consulta SQL.
  test('la partición "override de BTC activo / inactivo" es consultable por SQL', () => {
    const ctxOk = { btc_context: { trend_1d: 'bullish', trend_1w: 'bullish', source: 'btc_klines' } };
    const header = buildAnalysisHeader('btc-ok', 'SOL', '4h', ctxOk, minimalStructured, {}, 100);
    dbService.saveAnalysis({ header, tfSnapshots: [], clusters: [], fvgs: [] });

    const gate = dbmod.getDb().prepare(`
      SELECT btc_trend_1d IN ('bearish','strongly_bearish') AS override_activo, COUNT(*) n
      FROM analyses WHERE btc_trend_1d IS NOT NULL
      GROUP BY override_activo ORDER BY override_activo
    `).all();
    expect(gate).toEqual([{ override_activo: 0, n: 1 }, { override_activo: 1, n: 1 }]);
  });
});
