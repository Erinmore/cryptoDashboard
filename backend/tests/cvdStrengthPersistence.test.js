/**
 * cvdStrengthPersistence.test.js — `cvd_strength` y `cvd_delta_vs_volume_pct` en
 * analysis_tf_snapshot (revisión crítica 2026-07-26, hallazgo C3).
 *
 * Por qué existe: `cvd_strength` del TF primario decide si la puerta de Comprar/Vender está
 * abierta. Con "marginal" el prompt anula el Volume Flow Score y el validador degrada
 * cualquier acción direccional a Esperar. El snapshot persistía `cvd_trend` y
 * `cvd_divergence` pero NO la fuerza, así que a posteriori era imposible distinguir un
 * "el modelo eligió Esperar" de un "no se le permitió decir otra cosa". Sin esa covariable
 * la muestra de la fase de recogida no se puede particionar.
 *
 * IMPORTANTE — aislamiento: TODOS los imports de src/ son DINÁMICOS y posteriores a fijar
 * DB_PATH. `config/env.js` captura `dbPath` al evaluarse el módulo, así que un import
 * estático congelaría la ruta por defecto y el test escribiría en backend/data/cryptex.db,
 * la BD real. Mismo patrón que fvgPersistence.test.js / historyPersistence.test.js.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('analysis_tf_snapshot — telemetría de cvd_strength', () => {
  const TMP_DB = path.join(os.tmpdir(), `cryptex-cvdstr-${process.pid}-${Date.now()}.db`);
  const ORIG_DB_PATH = process.env.DB_PATH;
  let dbmod, dbService, buildTfSnapshots;

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    dbService = await import('../src/services/dbService.js');
    ({ buildTfSnapshots } = await import('../src/controllers/analysisController.js'));
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

  const header = (id) => {
    const cols = dbmod.getDb().prepare('PRAGMA table_info(analyses)').all().map((c) => c.name);
    return {
      ...Object.fromEntries(cols.map((c) => [c, null])),
      id, coin: 'SOL', primary_tf: '4h', timestamp: new Date().toISOString(),
      prompt_version: 'test', action: 'Esperar', has_executable_setup: 0,
      gating_active: 0, contradictions_found: 0,
    };
  };

  const technical = {
    '4h': { cvd: { trend: 'falling', divergence: 'none', cvd_strength: 'marginal', cvd_delta_vs_volume_pct: -0.25 } },
    '1D': { cvd: { trend: 'rising', divergence: 'bullish', cvd_strength: 'moderate', cvd_delta_vs_volume_pct: 4.2 } },
  };

  test('buildTfSnapshots incluye la fuerza y el ratio crudo del CVD', () => {
    const rows = buildTfSnapshots('cvd-1', technical);
    const r4h = rows.find((r) => r.tf === '4h');
    expect(r4h.cvd_strength).toBe('marginal');
    expect(r4h.cvd_delta_vs_volume_pct).toBe(-0.25);
    const r1d = rows.find((r) => r.tf === '1D');
    expect(r1d.cvd_strength).toBe('moderate');
    expect(r1d.cvd_delta_vs_volume_pct).toBe(4.2);
  });

  test('saveAnalysis los persiste (los @params casan con las claves de la fila)', () => {
    const tfSnapshots = buildTfSnapshots('cvd-1', technical);
    // No debe lanzar: un desajuste @param↔clave sólo revienta aquí, en runtime.
    dbService.saveAnalysis({ header: header('cvd-1'), tfSnapshots, clusters: [], fvgs: [] });

    const rows = dbmod.getDb()
      .prepare('SELECT tf, cvd_strength, cvd_delta_vs_volume_pct FROM analysis_tf_snapshot WHERE analysis_id = ? ORDER BY tf')
      .all('cvd-1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tf === '4h')).toMatchObject({
      cvd_strength: 'marginal', cvd_delta_vs_volume_pct: -0.25,
    });
    expect(rows.find((r) => r.tf === '1D')).toMatchObject({
      cvd_strength: 'moderate', cvd_delta_vs_volume_pct: 4.2,
    });
  });

  // El punto de todo el ejercicio: poder separar la muestra por estado de la puerta.
  test('la partición "puerta abierta / cerrada" es consultable por SQL', () => {
    const open = { '4h': { cvd: { cvd_strength: 'moderate', cvd_delta_vs_volume_pct: 3.1 } } };
    dbService.saveAnalysis({
      header: header('cvd-open'), tfSnapshots: buildTfSnapshots('cvd-open', open), clusters: [], fvgs: [],
    });

    const gate = dbmod.getDb().prepare(`
      SELECT s.cvd_strength = 'marginal' AS puerta_cerrada, COUNT(*) n
      FROM analyses a JOIN analysis_tf_snapshot s
        ON s.analysis_id = a.id AND s.tf = a.primary_tf
      GROUP BY puerta_cerrada ORDER BY puerta_cerrada
    `).all();
    expect(gate).toEqual([{ puerta_cerrada: 0, n: 1 }, { puerta_cerrada: 1, n: 1 }]);
  });

  test('CVD ausente en un TF no rompe: se persiste NULL', () => {
    const sinCvd = { '1W': { rsi: { value: 50 } } };
    dbService.saveAnalysis({
      header: header('cvd-null'), tfSnapshots: buildTfSnapshots('cvd-null', sinCvd), clusters: [], fvgs: [],
    });
    const row = dbmod.getDb()
      .prepare('SELECT cvd_strength, cvd_delta_vs_volume_pct FROM analysis_tf_snapshot WHERE analysis_id = ?')
      .get('cvd-null');
    expect(row.cvd_strength).toBeNull();
    expect(row.cvd_delta_vs_volume_pct).toBeNull();
  });
});
