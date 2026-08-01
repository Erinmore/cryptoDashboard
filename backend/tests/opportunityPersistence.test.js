/**
 * opportunityPersistence.test.js — métricas de recorrido (Fase 5) contra una BD real.
 *
 * Verifica lo que los tests puros NO pueden: que los @params del upsert casan con las
 * claves de la fila, que la columna JSON `path_first_passage` sobrevive el viaje de ida y
 * vuelta por SQLite, y que `getOutcomeStats` sabe rehidratarla. Un desajuste ahí sólo
 * revienta en runtime — que es exactamente donde no queremos descubrirlo, porque el job
 * corre en la Pi cada 15 minutos sin que nadie mire.
 *
 * IMPORTANTE — aislamiento: TODOS los imports de src/ son DINÁMICOS y posteriores a fijar
 * DB_PATH (`config/env.js` congela `dbPath` al evaluarse). Mismo patrón que
 * fvgPersistence.test.js.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('métricas de recorrido — persistencia y agregación contra BD real', () => {
  const TMP_DB = path.join(os.tmpdir(), `cryptex-opp-${process.pid}-${Date.now()}.db`);
  const ORIG_DB_PATH = process.env.DB_PATH;
  let dbmod, dbService;

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    dbService = await import('../src/services/dbService.js');
  });

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch { /* noop */ }
    }
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  test('la BD activa es la temporal, no la de desarrollo', () => {
    const file = dbmod.getDb().prepare('PRAGMA database_list').get().file;
    expect(file).toBe(TMP_DB);
    expect(file).not.toMatch(/data[/\\]cryptex\.db$/);
  });

  /**
   * Fecha por defecto de los análisis del test: pasada y con la ventana de 7d VENCIDA.
   * No es un detalle cosmético — desde el 2026-08-01 el coste de oportunidad solo cuenta
   * como "no ofreció" lo que ya tuvo tiempo de moverse, así que una fila recién creada
   * queda `pending` y fuera del denominador (ver el último test de este fichero).
   */
  const FECHA_MADURA = '2026-07-01T09:00:00.000Z';   // dentro de la vela 4h de 08:00 UTC

  /** Header mínimo derivado del esquema (evita listar ~70 columnas a mano). */
  const header = (id, over = {}) => {
    const cols = dbmod.getDb().prepare('PRAGMA table_info(analyses)').all().map((c) => c.name);
    return {
      ...Object.fromEntries(cols.map((c) => [c, null])),
      id, coin: 'SOL', primary_tf: '4h', timestamp: FECHA_MADURA,
      prompt_version: 'test', action: 'Esperar', conviction: 0.35,
      has_executable_setup: 0, gating_active: 0, contradictions_found: 0,
      ...over,
    };
  };

  const passage = (up, down) => ({ atr_pct: 2, multiples: [0.5, 1, 1.5, 2, 3, 4], up, down });

  test('el JSON de primeros cruces sobrevive el viaje por SQLite', () => {
    dbService.saveAnalysis({ header: header('opp-1'), tfSnapshots: [], clusters: [], fvgs: [] });
    dbService.upsertOutcome({
      analysis_id: 'opp-1',
      atr_pct_at_analysis: 2,
      max_up_pct_24h: 5, max_down_pct_24h: -1,
      max_up_pct_7d: 9, max_down_pct_7d: -3,
      t_max_up_h: 12, t_max_down_h: 40,
      path_first_passage: passage({ 2: 6 }, {}),
    });

    const row = dbmod.getDb()
      .prepare('SELECT * FROM analysis_outcome WHERE analysis_id = ?').get('opp-1');
    expect(row.atr_pct_at_analysis).toBe(2);
    expect(row.max_up_pct_7d).toBe(9);
    expect(JSON.parse(row.path_first_passage).up['2']).toBe(6);
  });

  test('un segundo ciclo sin recorrido NO borra lo ya medido (COALESCE del upsert)', () => {
    // Escenario real: Binance falla en un ciclo → el job escribe null y no debe perder
    // la medición anterior, que ya no se puede recuperar si la ventana avanzó.
    dbService.upsertOutcome({ analysis_id: 'opp-1', price_24h_later: 80 });

    const row = dbmod.getDb()
      .prepare('SELECT * FROM analysis_outcome WHERE analysis_id = ?').get('opp-1');
    expect(row.max_up_pct_7d).toBe(9);
    expect(row.path_first_passage).not.toBeNull();
    expect(row.price_24h_later).toBe(80);
  });

  test('getOutcomeStats mide el coste de oportunidad de los Esperar', () => {
    // opp-2: el mercado ofreció +2xATR limpio → coste de oportunidad.
    dbService.saveAnalysis({ header: header('opp-2'), tfSnapshots: [], clusters: [], fvgs: [] });
    dbService.upsertOutcome({
      analysis_id: 'opp-2', atr_pct_at_analysis: 2,
      max_up_pct_24h: 6, max_down_pct_24h: -0.5,
      path_first_passage: passage({ 2: 8 }, {}),
    });
    // opp-3: plano → abstenerse fue acertado.
    dbService.saveAnalysis({ header: header('opp-3'), tfSnapshots: [], clusters: [], fvgs: [] });
    dbService.upsertOutcome({
      analysis_id: 'opp-3', atr_pct_at_analysis: 2,
      max_up_pct_24h: 1, max_down_pct_24h: -1,
      path_first_passage: passage({}, {}),
    });

    const stats = dbService.getOutcomeStats('SOL');
    const opp = stats.opportunity_cost['24h'];
    expect(opp.n).toBe(3);            // los 3 son Esperar
    expect(opp.evaluable_n).toBe(3);
    expect(opp.offered_n).toBe(2);    // opp-1 y opp-2
    expect(opp.offered_pct).toBeCloseTo(66.7, 1);
    expect(opp.pending_n).toBe(0);    // las 3 tienen la ventana vencida
    expect(opp.thresholds.target_k_atr).toBe(2);
  });

  test('con 100% Esperar el win-rate sigue sin reportar, pero el coste ya se mide', () => {
    // El hallazgo central de la Fase 5: no es que falte muestra, es que la salida
    // dominante no cruzaba TP ni stop y por tanto era inevaluable.
    const stats = dbService.getOutcomeStats('SOL');
    expect(stats.path_win_rate.directional_n).toBe(0);
    expect(stats.path_win_rate.win_rate).toBeNull();
    expect(stats.path_win_rate.sample_insufficient).toBe(true);
    expect(stats.opportunity_cost['24h'].offered_pct).not.toBeNull();
  });

  test('los episodios colapsan los análisis de la misma vela 4h', () => {
    const stats = dbService.getOutcomeStats('SOL');
    // Los 3 se guardaron con `new Date()` → misma vela 4h → un solo episodio.
    expect(stats.episodes.analyses_n).toBe(3);
    expect(stats.episodes.episodes_n).toBe(1);
  });

  test('la calibración de convicción agrupa por bucket', () => {
    const cal = dbService.getOutcomeStats('SOL').conviction_calibration;
    expect(cal).toHaveLength(1);            // los 3 con conviction 0.35
    expect(cal[0].bucket).toBe('baja');
    expect(cal[0].n).toBe(3);
    expect(cal[0].waits_offered_pct).toBeCloseTo(66.7, 1);
  });

  test('un análisis recién hecho queda pending y NO baja el offered_pct', () => {
    // La regresión del 2026-08-01: el bloque de 7d publicaba `offered_pct 0,0` (lift −36)
    // con la muestra entera por debajo de 66 h de vida. Aquí, extremo a extremo: la fila
    // joven se cuenta en `pending_n`, no como una abstención acertada.
    dbService.saveAnalysis({
      header: header('opp-4', { timestamp: new Date().toISOString() }),
      tfSnapshots: [], clusters: [], fvgs: [],
    });
    dbService.upsertOutcome({
      analysis_id: 'opp-4', atr_pct_at_analysis: 2,
      max_up_pct_24h: 0.4, max_down_pct_24h: -0.3,
      path_first_passage: passage({}, {}),
    });

    const opp = dbService.getOutcomeStats('SOL').opportunity_cost['24h'];
    expect(opp.n).toBe(4);
    expect(opp.pending_n).toBe(1);
    expect(opp.evaluable_n).toBe(3);
    expect(opp.offered_pct).toBeCloseTo(66.7, 1);   // sin el gate habría caído a 50,0
  });
});
