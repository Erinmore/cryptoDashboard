import os from 'os';
import path from 'path';
import fs from 'fs';

// DB temporal aislada: DB_PATH ANTES de cualquier import de src/ (patrón obligatorio, ver
// CLAUDE.md §Tests — un import estático de algo que arrastre config/db.js congela la ruta).
const TMP_DB = path.join(os.tmpdir(), `cryptex-ver-${process.pid}-${Date.now()}.db`);
const ORIG_DB_PATH = process.env.DB_PATH;

/**
 * A3 · Versionado por fila. Lo que estos tests protegen no es el valor de las constantes
 * (cambiarán a cada lote), sino que la fila DECLARE con qué reglas se produjo — sin eso,
 * comparar dos periodos vuelve a ser arqueología de commits, y retirar un valor de enum
 * (`Preparar`) rompería las filas viejas en vez de dejarlas interpretables.
 */
describe('versionado por fila (gate/rubric/feature)', () => {
  let dbmod, dbsvc, constants, db, buildAnalysisHeader;

  beforeAll(async () => {
    process.env.DB_PATH = TMP_DB;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    db = dbmod.getDb();
    expect(db.pragma('database_list')[0].file).toBe(TMP_DB);
    dbsvc = await import('../src/services/dbService.js');
    constants = await import('../src/config/constants.js');
    ({ buildAnalysisHeader } = await import('../src/controllers/analysisController.js'));
  });

  const minimalStructured = {
    action: 'Esperar', confidence: 'Media', risk_score: 5, conviction: 0.5,
    has_executable_setup: false, gating_active: false, setup: null,
    scores: { derivatives: 0, structure: 0, volume: 0, onchain: 0, total: 0 },
    executive_summary: 'test',
  };

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch { /* noop */ }
    }
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  const cols = () => db.prepare('PRAGMA table_info(analyses)').all().map((c) => c.name);

  test('las tres columnas existen tras la migración', () => {
    for (const c of ['gate_version', 'rubric_version', 'feature_version']) {
      expect(cols()).toContain(c);
    }
  });

  test('las constantes tienen un solo dueño y son strings no vacíos', () => {
    for (const v of [constants.GATE_VERSION, constants.RUBRIC_VERSION, constants.FEATURE_VERSION]) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
    // Tres componentes distintos: si dos compartieran valor, subir uno subiría el otro en
    // silencio y se perdería justo la capacidad de atribuir que motiva el ítem.
    const set = new Set([constants.GATE_VERSION, constants.RUBRIC_VERSION, constants.FEATURE_VERSION]);
    expect(set.size).toBe(3);
  });

  test('buildAnalysisHeader las inyecta — el camino REAL, no un header a mano', () => {
    const header = buildAnalysisHeader('ver-1', 'SOL', '4h', {}, minimalStructured, {}, 100);
    expect(header.gate_version).toBe(constants.GATE_VERSION);
    expect(header.rubric_version).toBe(constants.RUBRIC_VERSION);
    expect(header.feature_version).toBe(constants.FEATURE_VERSION);
  });

  test('saveAnalysis persiste las tres versiones', () => {
    const header = buildAnalysisHeader('ver-1', 'SOL', '4h', {}, minimalStructured, {}, 100);
    dbsvc.saveAnalysis({ header, tfSnapshots: [], clusters: [], fvgs: [] });
    const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get('ver-1');
    expect(row.gate_version).toBe(constants.GATE_VERSION);
    expect(row.rubric_version).toBe(constants.RUBRIC_VERSION);
    expect(row.feature_version).toBe(constants.FEATURE_VERSION);
  });

  test('getAnalysisHistory las devuelve — persistir sin exponer es tan invisible como no guardar', () => {
    const [row] = dbsvc.getAnalysisHistory('SOL', 10).analyses;
    expect(row.gate_version).toBe(constants.GATE_VERSION);
    expect(row.rubric_version).toBe(constants.RUBRIC_VERSION);
    expect(row.feature_version).toBe(constants.FEATURE_VERSION);
  });

  test('una fila anterior al versionado queda NULL y es distinguible por SQL', () => {
    // Las 11 filas ya en producción son exactamente este caso: no se rellenan a mano, porque
    // NULL es la marca correcta de "producida antes de que se versionara".
    const header = buildAnalysisHeader('ver-old', 'SOL', '4h', {}, minimalStructured, {}, 100);
    delete header.gate_version; delete header.rubric_version; delete header.feature_version;
    header.gate_version = null; header.rubric_version = null; header.feature_version = null;
    dbsvc.saveAnalysis({ header, tfSnapshots: [], clusters: [], fvgs: [] });

    expect(db.prepare('SELECT * FROM analyses WHERE id = ?').get('ver-old').gate_version).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM analyses WHERE gate_version IS NULL').get().n).toBe(1);
  });
  // ⚠️ ANIDADO en el describe dueño de la BBDD a propósito. Un bloque hermano con su propia
  // ruta NO funciona: `config/env.js` congela `dbPath` al evaluarse, así que el segundo
  // `initDb()` reabre la PRIMERA base. La guarda de `database_list` lo cazó — sin ella el
  // test habría pasado escribiendo en otro fichero del que creía.
  describe('sample_reason — de dónde vino cada observación', () => {
  let normalizeSampleReason;
  beforeAll(async () => {
    ({ normalizeSampleReason } = await import('../src/utils/sampleReason.js'));
  });

  const minimal = {
    action: 'Esperar', confidence: 'Media', risk_score: 5, conviction: 0.5,
    has_executable_setup: false, gating_active: false, setup: null,
    scores: { derivatives: 0, structure: 0, volume: 0, onchain: 0, total: 0 },
    executive_summary: 'test',
  };

  describe('normalización — es entrada de usuario que acaba en BBDD', () => {
    test.each([
      ['fixed', 'fixed'],
      ['ui', 'ui'],
      ['manual', 'manual'],
      ['opportunistic:veto_long+oi_expandiendo', 'opportunistic:veto_long+oi_expandiendo'],
      ['  FIXED  ', 'fixed'],                       // se recorta y baja a minúsculas
    ])('%s → %s', (entrada, esperado) => {
      expect(normalizeSampleReason(entrada)).toBe(esperado);
    });

    test.each([
      ['prefijo inventado', 'cron_de_juan'],
      ['inyección SQL', "fixed'; DROP TABLE analyses;--"],
      ['con espacios', 'fixed y algo'],
      ['no string', 42],
      ['ausente', undefined],
      ['vacío', ''],
    ])('%s → unknown', (_l, entrada) => {
      expect(normalizeSampleReason(entrada)).toBe('unknown');
    });

    test('se acota la longitud (no se guarda un texto arbitrario)', () => {
      expect(normalizeSampleReason(`opportunistic:${'a'.repeat(500)}`).length).toBeLessThanOrEqual(64);
    });
  });

  test('se persiste y se devuelve por getAnalysisHistory', () => {
    const h = buildAnalysisHeader('sr-1', 'SOL', '4h', {}, minimal, {}, 100, 'opportunistic:veto_short');
    dbsvc.saveAnalysis({ header: h, tfSnapshots: [], clusters: [], fvgs: [] });
    expect(db.prepare('SELECT sample_reason s FROM analyses WHERE id=?').get('sr-1').s)
      .toBe('opportunistic:veto_short');
    expect(dbsvc.getAnalysisHistory('SOL', 5).analyses[0].sample_reason).toBe('opportunistic:veto_short');
  });

  test('sin motivo → `unknown`, no un origen inventado', () => {
    const h = buildAnalysisHeader('sr-2', 'SOL', '4h', {}, minimal, {}, 100);
    dbsvc.saveAnalysis({ header: h, tfSnapshots: [], clusters: [], fvgs: [] });
    expect(db.prepare('SELECT sample_reason s FROM analyses WHERE id=?').get('sr-2').s).toBe('unknown');
  });

  test('la muestra PLANIFICADA es separable por SQL — que es el punto entero', () => {
    for (const [id, r] of [['sr-3', 'fixed'], ['sr-4', 'ui'], ['sr-5', 'opportunistic:oi_expandiendo']]) {
      const h = buildAnalysisHeader(id, 'BTC', '4h', {}, minimal, {}, 100, r);
      dbsvc.saveAnalysis({ header: h, tfSnapshots: [], clusters: [], fvgs: [] });
    }
    const planificados = db.prepare(
      "SELECT COUNT(*) n FROM analyses WHERE sample_reason = 'fixed'",
    ).get().n;
    const dirigidos = db.prepare(
      "SELECT COUNT(*) n FROM analyses WHERE sample_reason LIKE 'opportunistic%'",
    ).get().n;
    expect(planificados).toBe(1);
    expect(dirigidos).toBe(2);   // sr-1 y sr-5
  });
  });
});

describe('migración de datos liquidations → liquidations_1d', () => {
  const TMP2 = path.join(os.tmpdir(), `cryptex-mig-${process.pid}-${Date.now()}.db`);
  let dbmod, db;

  afterAll(() => {
    try { dbmod.closeDb(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP2 + ext); } catch { /* noop */ }
    }
    if (ORIG_DB_PATH === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = ORIG_DB_PATH;
  });

  test('renombra las filas viejas y es idempotente', async () => {
    process.env.DB_PATH = TMP2;
    dbmod = await import('../src/config/db.js');
    dbmod.initDb();
    db = dbmod.getDb();

    // Simula una BBDD anterior al renombrado.
    db.prepare('INSERT INTO history_series (coin, metric, ts_key, payload) VALUES (?,?,?,?)')
      .run('SOL', 'liquidations', 1785000000, '{"date":"2026-07-01"}');
    const count = (m) => db.prepare(
      'SELECT COUNT(*) n FROM history_series WHERE metric = ?',
    ).get(m).n;
    expect(count('liquidations')).toBe(1);

    dbmod.initDb();                                    // 2ª pasada: aplica la migración
    expect(count('liquidations')).toBe(0);
    expect(count('liquidations_1d')).toBe(1);

    dbmod.initDb();                                    // 3ª pasada: no debe romper ni duplicar
    expect(count('liquidations_1d')).toBe(1);
  });
});
