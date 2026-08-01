/**
 * shadowTradePersistence.test.js — shadow trade contra una BD real.
 *
 * Verifica lo que los tests puros NO pueden: que las columnas existen tras la migración,
 * que los @params del upsert casan, que `getAnalysisHistory` las DEVUELVE (el fallo del
 * 2026-07-31: `conditional_setup` se persistía y faltaba en el SELECT, así que el dato
 * era tan invisible como si no se guardara) y que `getAnalysesNeedingOutcome` vuelve a
 * seleccionar un condicional vivo aunque el resto de la fila esté completa.
 *
 * IMPORTANTE — aislamiento: TODOS los imports de src/ son DINÁMICOS y posteriores a fijar
 * DB_PATH (`config/env.js` congela `dbPath` al evaluarse).
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('shadow trade — persistencia y agregación contra BD real', () => {
  const TMP_DB = path.join(os.tmpdir(), `cryptex-shadow-${process.pid}-${Date.now()}.db`);
  const ORIG_DB_PATH = process.env.DB_PATH;
  let dbmod, dbService;

  const HOUR = 3600 * 1000;
  const cond = (over = {}) => JSON.stringify({
    trigger: 'cierre 4h por encima de 100', direction: 'long',
    entry_price: 100, stop_price: 95, tp1_price: 110,
    validity_candles: 6, tf_execution: '4h', ...over,
  });

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

  /** Header mínimo derivado del esquema (evita listar ~70 columnas a mano). */
  const header = (id, over = {}) => {
    const cols = dbmod.getDb().prepare('PRAGMA table_info(analyses)').all().map((c) => c.name);
    return {
      ...Object.fromEntries(cols.map((c) => [c, null])),
      id, coin: 'SOL', primary_tf: '4h', timestamp: new Date().toISOString(),
      prompt_version: 'test', action: 'Esperar', conviction: 0.35,
      has_executable_setup: 0, gating_active: 0, contradictions_found: 0,
      ...over,
    };
  };

  test('la BD activa es la temporal, no la de desarrollo', () => {
    const file = dbmod.getDb().prepare('PRAGMA database_list').get().file;
    expect(file).toBe(TMP_DB);
    expect(file).not.toMatch(/data[/\\]cryptex\.db$/);
  });

  test('las columnas del shadow trade sobreviven el viaje por SQLite', () => {
    dbService.saveAnalysis({
      header: header('sh-1', { conditional_setup: cond() }),
      tfSnapshots: [], clusters: [], fvgs: [],
    });
    dbService.upsertOutcome({
      analysis_id: 'sh-1', cond_outcome: 'not_triggered', cond_filled: 0,
    });

    const row = dbmod.getDb()
      .prepare('SELECT * FROM analysis_outcome WHERE analysis_id = ?').get('sh-1');
    expect(row.cond_outcome).toBe('not_triggered');
    expect(row.cond_filled).toBe(0);
    expect(row.cond_invalid_reason).toBeNull();
  });

  test('el shadow trade NO lleva COALESCE: un open puede corregirse a terminal', () => {
    // El recorrido sí usa COALESCE (un fallo de klines no debe borrar lo medido), pero el
    // estado del condicional EVOLUCIONA: 'open' → 'not_triggered' tiene que poder escribirse.
    dbService.upsertOutcome({ analysis_id: 'sh-1', cond_outcome: 'stop', cond_filled: 1 });
    const row = dbmod.getDb()
      .prepare('SELECT cond_outcome, cond_filled FROM analysis_outcome WHERE analysis_id = ?')
      .get('sh-1');
    expect(row.cond_outcome).toBe('stop');
    expect(row.cond_filled).toBe(1);
  });

  test('getAnalysisHistory devuelve el resultado (el fallo de 07-31: persistir sin exponer)', () => {
    const { analyses } = dbService.getAnalysisHistory('SOL', 10, 0);
    const a = analyses.find((r) => r.id === 'sh-1');
    expect(a.conditional_setup).toBe(cond());
    expect(a.cond_outcome).toBe('stop');
    expect(a.cond_filled).toBe(1);
  });

  test('getAnalysesNeedingOutcome reselecciona un condicional VIVO con la fila completa', () => {
    // Fila con todos los precios puestos: sin la cláusula del condicional dejaría de
    // seleccionarse y el 'open' se quedaría así para siempre.
    const ts = new Date(Date.now() - 30 * HOUR).toISOString();
    dbService.saveAnalysis({
      header: header('sh-vivo', { timestamp: ts, conditional_setup: cond() }),
      tfSnapshots: [], clusters: [], fvgs: [],
    });
    dbService.upsertOutcome({
      analysis_id: 'sh-vivo',
      price_at_analysis: 100, price_1h_later: 100, price_4h_later: 100,
      price_24h_later: 100, price_7d_later: 100,
      max_up_pct_7d: 1, cond_outcome: 'open', cond_filled: 0,
    });

    const ids = dbService.getAnalysesNeedingOutcome(Date.now() - HOUR).map((r) => r.id);
    expect(ids).toContain('sh-vivo');

    // Y deja de seleccionarse en cuanto el condicional es terminal. Se reescribe la fila
    // ENTERA: el upsert solo usa COALESCE en las métricas de recorrido, así que un upsert
    // parcial borraría los precios (el job siempre escribe el objeto completo).
    dbService.upsertOutcome({
      analysis_id: 'sh-vivo',
      price_at_analysis: 100, price_1h_later: 100, price_4h_later: 100,
      price_24h_later: 100, price_7d_later: 100,
      max_up_pct_7d: 1, cond_outcome: 'not_triggered', cond_filled: 0,
    });
    const ids2 = dbService.getAnalysesNeedingOutcome(Date.now() - HOUR).map((r) => r.id);
    expect(ids2).not.toContain('sh-vivo');
  });

  test('un condicional vivo pero MÁS ANTIGUO que la ventana de backfill deja de reintentarse', () => {
    const ts = new Date(Date.now() - 20 * 24 * HOUR).toISOString();
    dbService.saveAnalysis({
      header: header('sh-viejo', { timestamp: ts, conditional_setup: cond() }),
      tfSnapshots: [], clusters: [], fvgs: [],
    });
    dbService.upsertOutcome({
      analysis_id: 'sh-viejo',
      price_at_analysis: 100, price_1h_later: 100, price_4h_later: 100,
      price_24h_later: 100, price_7d_later: 100,
      max_up_pct_7d: 1, cond_outcome: 'open', cond_filled: 0,
    });

    const ids = dbService.getAnalysesNeedingOutcome(Date.now() - HOUR).map((r) => r.id);
    expect(ids).not.toContain('sh-viejo');   // churn acotado, igual que el backfill del recorrido
  });

  test('getOutcomeStats expone el bloque de shadow trades con sus denominadores', () => {
    const stats = dbService.getOutcomeStats('SOL');
    const sh = stats.shadow_trades;
    // Tres evaluados: sh-1 (stop, pero guardado con timestamp de AHORA → su vigencia de
    // 24h sigue abierta), sh-vivo (not_triggered, vencida) y sh-viejo (open, de hace 20d).
    expect(sh.evaluated_n).toBe(3);
    expect(sh.pending_n).toBe(1);             // sh-1: tiene resultado pero aún no cuenta
    expect(sh.n).toBe(2);
    expect(sh.open).toBe(1);                  // sh-viejo: ventana vencida sin cerrar el job
    expect(sh.conclusive_n).toBe(1);          // solo sh-vivo
    expect(sh.triggered_n).toBe(0);
    expect(sh.trigger_rate_pct).toBe(0);
    expect(sh.resolved_n).toBe(0);
    expect(sh.sample_insufficient).toBe(true);
    expect(sh.win_rate).toBeNull();
    expect(sh.by_direction.long.n).toBe(2);
    expect(sh.fill_rule).toBe('touch_entry_intrabar');
  });
});
