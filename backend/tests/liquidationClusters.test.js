/**
 * liquidationClusters.test.js — el núcleo puro de las magnetic zones y, sobre todo,
 * el CONTRATO DE FORMA entre lo que el servicio emite y lo que la persistencia lee.
 *
 * Por qué existe este fichero (2026-08-02): `analysis_liquidation_snapshot` llevaba vacía
 * los 10 análisis del periodo. No era degraded mode — el dato estaba. `buildClusterRows`
 * leía `top_long_clusters`/`top_short_clusters` y el servicio emite `long_clusters`/
 * `short_clusters`, así que el `?? []` se tragaba el bloque entero sin un solo error en
 * el log. Ningún test podía cazarlo porque ninguno cruzaba las dos mitades.
 *
 * La regla que se ancla aquí: un `?? []` sobre una clave inexistente no distingue "no hay
 * datos" de "me equivoqué de nombre", así que las CLAVES son parte del contrato y se
 * comprueban explícitamente.
 */

import { jest } from '@jest/globals';
import {
  computeLiquidationClusters,
  clusterDistancePct,
} from '../src/utils/liquidationClusters.js';
import { buildClusterRows } from '../src/controllers/analysisController.js';

const H = 3600;

/** Construye buckets + candles 1h coherentes entre sí. */
function fixture() {
  const t0 = 1_700_000_000; // segundos, alineado a hora
  const buckets = [];
  const candles = [];
  for (let i = 0; i < 24; i++) {
    const t = t0 + i * H;
    // Precio en rampa: low de 100 a 123, high 2 por encima.
    const low = 100 + i;
    const high = low + 2;
    candles.push({ t: t * 1000, open: low + 1, high, low, close: low + 1, volume: 10 });
    // Liquidaciones concentradas: longs fuertes en la vela 3, shorts fuertes en la 20.
    buckets.push({
      t,
      l: i === 3 ? 5_000_000 : 1_000,
      s: i === 20 ? 2_000_000 : 500,
    });
  }
  return { buckets, candles };
}

describe('clusterDistancePct — dueño único de la fórmula de distancia', () => {
  test('signo: negativo por debajo del precio, positivo por encima, 0 en el precio', () => {
    expect(clusterDistancePct(100, 97)).toBe(-3);
    expect(clusterDistancePct(100, 102)).toBe(2);
    expect(clusterDistancePct(100, 100)).toBe(0);
  });

  test('null ante referencia ausente o cero (no inventa una distancia infinita)', () => {
    expect(clusterDistancePct(null, 100)).toBeNull();
    expect(clusterDistancePct(0, 100)).toBeNull();
    expect(clusterDistancePct(100, null)).toBeNull();
  });

  test('redondea a 2 decimales, como el resto de porcentajes del payload', () => {
    expect(clusterDistancePct(73.64, 72.1)).toBe(-2.09);
  });
});

describe('computeLiquidationClusters — núcleo puro', () => {
  test('devuelve null sin buckets o sin velas (degraded mode, no excepción)', () => {
    const { buckets, candles } = fixture();
    expect(computeLiquidationClusters([], candles)).toBeNull();
    expect(computeLiquidationClusters(buckets, [])).toBeNull();
    expect(computeLiquidationClusters(null, null)).toBeNull();
  });

  test('devuelve null si el rango de precio es degenerado (todas las velas planas)', () => {
    const candles = Array.from({ length: 5 }, (_, i) => ({
      t: (1_700_000_000 + i * H) * 1000, high: 100, low: 100, close: 100,
    }));
    const buckets = candles.map((c, i) => ({ t: 1_700_000_000 + i * H, l: 10, s: 10 }));
    expect(computeLiquidationClusters(buckets, candles)).toBeNull();
  });

  test('agrupa: el cluster top de cada lado es el del bucket con más USD', () => {
    const { buckets, candles } = fixture();
    const r = computeLiquidationClusters(buckets, candles);

    // El long dominante estaba en la vela 3 (low = 103); el short en la 20 (high = 122).
    expect(r.long_clusters[0].total_usd).toBeGreaterThan(4_900_000);
    expect(r.long_clusters[0].price).toBeGreaterThan(102);
    expect(r.long_clusters[0].price).toBeLessThan(105);

    expect(r.short_clusters[0].total_usd).toBeGreaterThan(1_900_000);
    expect(r.short_clusters[0].price).toBeGreaterThan(121);
    expect(r.short_clusters[0].price).toBeLessThan(124);
  });

  test('nunca devuelve más de 5 clusters por lado', () => {
    const { buckets, candles } = fixture();
    const r = computeLiquidationClusters(buckets, candles);
    expect(r.long_clusters.length).toBeLessThanOrEqual(5);
    expect(r.short_clusters.length).toBeLessThanOrEqual(5);
  });

  test('el precio de referencia es el close de la ÚLTIMA vela, no el spot', () => {
    const { buckets, candles } = fixture();
    const r = computeLiquidationClusters(buckets, candles);
    const ref = candles[candles.length - 1].close;
    // Todos los long_clusters por debajo de la referencia dan distancia negativa.
    const below = r.long_clusters.filter(c => c.price < ref);
    expect(below.length).toBeGreaterThan(0);
    expect(r.nearest_long_cluster_pct).toBeLessThan(0);
  });

  test('los flags magnéticos sólo se activan en la banda 1%-3%', () => {
    const { buckets, candles } = fixture();
    const r = computeLiquidationClusters(buckets, candles);
    // Coherencia interna: el flag debe casar con la distancia que lo genera.
    const inBand = (p, lo, hi) => p != null && p >= lo && p <= hi;
    expect(r.magnetic_long_zone_active).toBe(inBand(r.nearest_long_cluster_pct, -3, -1));
    expect(r.magnetic_short_zone_active).toBe(inBand(r.nearest_short_cluster_pct, 1, 3));
  });

  test('declara su origen: es inferencia, no CoinGlass', () => {
    const { buckets, candles } = fixture();
    expect(computeLiquidationClusters(buckets, candles).source).toBe('coinalyze_inferred');
  });
});

describe('CONTRATO DE FORMA servicio ↔ persistencia (el bug del 02-08)', () => {
  test('las claves que emite el núcleo son EXACTAMENTE las que lee buildClusterRows', () => {
    const { buckets, candles } = fixture();
    const emitted = computeLiquidationClusters(buckets, candles);

    // Si alguien renombra un lado sin el otro, esto cae.
    expect(Object.keys(emitted)).toEqual(expect.arrayContaining(['long_clusters', 'short_clusters']));
    expect(emitted.top_long_clusters).toBeUndefined();
    expect(emitted.top_short_clusters).toBeUndefined();

    const rows = buildClusterRows('a1', emitted, 120);
    // La prueba de fuego: con datos presentes, NO puede salir vacío.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(emitted.long_clusters.length + emitted.short_clusters.length);
  });

  test('REGRESIÓN: la clave antigua ya no produce filas fantasma ni las de verdad', () => {
    // Forma vieja (la que el código leía): debe dar 0 filas, no colarse.
    const rows = buildClusterRows('a1', {
      top_long_clusters: [{ price: 100, total_usd: 5 }],
      top_short_clusters: [{ price: 110, total_usd: 5 }],
    }, 105);
    expect(rows).toHaveLength(0);
  });

  test('cada fila mapea a las columnas de analysis_liquidation_snapshot', () => {
    const { buckets, candles } = fixture();
    const rows = buildClusterRows('a1', computeLiquidationClusters(buckets, candles), 120);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ['analysis_id', 'cluster_rank', 'cluster_type', 'distance_pct', 'price', 'total_usd'].sort(),
      );
      expect(['long', 'short']).toContain(r.cluster_type);
      expect(Number.isFinite(r.price)).toBe(true);
      expect(Number.isFinite(r.total_usd)).toBe(true);
    }
  });

  test('distance_pct se calcula contra el precio del análisis y con el signo correcto', () => {
    const rows = buildClusterRows('a1', {
      long_clusters:  [{ price: 90,  total_usd: 5 }],
      short_clusters: [{ price: 110, total_usd: 5 }],
    }, 100);
    const long  = rows.find(r => r.cluster_type === 'long');
    const short = rows.find(r => r.cluster_type === 'short');
    expect(long.distance_pct).toBe(-10);
    expect(short.distance_pct).toBe(10);
  });

  test('sin precio de referencia la distancia es null, no 0 (dato ausente ≠ precio encima)', () => {
    const rows = buildClusterRows('a1', { long_clusters: [{ price: 90, total_usd: 5 }] }, null);
    expect(rows[0].distance_pct).toBeNull();
  });

  test('clusters ausentes → 0 filas, sin lanzar (degraded mode)', () => {
    expect(buildClusterRows('a1', null, 100)).toHaveLength(0);
    expect(buildClusterRows('a1', {}, 100)).toHaveLength(0);
  });

  test('el rank respeta el orden de entrada y empieza en 0 por cada lado', () => {
    const rows = buildClusterRows('a1', {
      long_clusters:  [{ price: 90, total_usd: 9 }, { price: 80, total_usd: 4 }],
      short_clusters: [{ price: 110, total_usd: 7 }],
    }, 100);
    const longs = rows.filter(r => r.cluster_type === 'long');
    expect(longs.map(r => r.cluster_rank)).toEqual([0, 1]);
    expect(rows.find(r => r.cluster_type === 'short').cluster_rank).toBe(0);
  });

  test('corta en 5 aunque lleguen más (límite de 10 filas por análisis)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ price: 90 - i, total_usd: 10 - i }));
    const rows = buildClusterRows('a1', { long_clusters: many, short_clusters: many }, 100);
    expect(rows).toHaveLength(10);
  });
});
