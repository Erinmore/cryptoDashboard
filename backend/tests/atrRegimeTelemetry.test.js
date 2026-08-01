/**
 * Telemetría de RÉGIMEN DE VOLATILIDAD (2026-08-01) — `atr.pct_percentile`.
 *
 * Nace de una medición que TUMBÓ el cambio que iba a acompañarla: se propuso convertir
 * `OPPORTUNITY_BASE_RATE` en una tabla por régimen, y al medirla con anclajes independientes
 * el efecto no sobrevivió (los cuartiles de ATR% ABSOLUTO resultaron ser casi una
 * clasificación por MONEDA). La constante se queda como está; lo que sí hacía falta es poder
 * CONDICIONAR a posteriori, y para eso hay que persistir en qué régimen se decidió.
 *
 * Estos tests fijan las tres propiedades que lo hacen utilizable:
 *   1. es un PERCENTIL de la propia serie (0-100), no un valor absoluto;
 *   2. ordena por régimen y NO por escala del activo — dos series idénticas salvo un factor
 *      de precio deben dar el mismo percentil (es lo que el ATR% absoluto no cumple);
 *   3. NO viaja al LLM (misma regla que `width_pctile` / `cvd_strength_cuts`).
 */
import { computeIndicators } from '../src/services/indicatorService.js';
import { buildLlmRequest } from '../src/services/anthropicService.js';

/** Serie sintética con volatilidad controlada: `volFactor` escala el rango de cada vela. */
function series({ n = 200, base = 100, volFactor = 1, tailVol = null }) {
  const out = [];
  let px = base;
  for (let i = 0; i < n; i++) {
    const v = (tailVol != null && i >= n - 20) ? tailVol : volFactor;
    const range = base * 0.01 * v;
    const drift = Math.sin(i / 7) * range * 0.3;
    const open = px;
    const close = px + drift;
    out.push({
      t: Date.UTC(2026, 0, 1) + i * 4 * 3600 * 1000,
      open, close,
      high: Math.max(open, close) + range / 2,
      low: Math.min(open, close) - range / 2,
      volume: 1000, taker_buy_base: 500,
    });
    px = close;
  }
  return out;
}

describe('atr.pct_percentile — telemetría de régimen', () => {
  test('es un percentil de la propia serie, en [0,100]', () => {
    const t = computeIndicators(series({}), '4h');
    expect(t.atr).toBeTruthy();
    expect(typeof t.atr.pct_percentile).toBe('number');
    expect(t.atr.pct_percentile).toBeGreaterThanOrEqual(0);
    expect(t.atr.pct_percentile).toBeLessThanOrEqual(100);
  });

  test('una expansión al final del periodo lo empuja hacia arriba', () => {
    const calm = computeIndicators(series({ volFactor: 1 }), '4h');
    const spike = computeIndicators(series({ volFactor: 1, tailVol: 6 }), '4h');
    expect(spike.atr.pct_percentile).toBeGreaterThan(calm.atr.pct_percentile);
    expect(spike.atr.pct_percentile).toBeGreaterThan(80);
  });

  test('NO depende de la escala del precio — es la propiedad que el ATR% absoluto no tiene', () => {
    // La invariancia se comprueba ESCALANDO la misma serie, no regenerándola con otra base:
    // regenerar reacumula el precio vela a vela y el error de coma flotante acaba cruzando el
    // redondeo a 2 decimales de `pct`, que desplaza el percentil medio punto. Eso mediría mi
    // generador, no el indicador. Escalar ×1000 es la transformación exacta bajo la que el
    // percentil DEBE ser idéntico — y es justo lo que el ATR% absoluto no cumple, porque
    // ordenaría por moneda en vez de por régimen.
    const base = series({ tailVol: 4 });
    const scaled = base.map((c) => ({
      ...c, open: c.open * 1000, close: c.close * 1000, high: c.high * 1000, low: c.low * 1000,
    }));
    const a = computeIndicators(base, '4h');
    const b = computeIndicators(scaled, '4h');
    expect(b.atr.pct_percentile).toBe(a.atr.pct_percentile);
    // ⚠️ `atr.pct` NO es exactamente invariante y no se le exige que lo sea: `calculateATR`
    // redondea a 2 decimales en unidades de PRECIO, así que su precisión RELATIVA depende de
    // la escala del activo (a $100 el redondeo vale ~0,3 % del ATR; a $100.000, nada). Por
    // eso el percentil se rankea contra la serie sin redondear y no contra este campo.
    expect(Math.abs(b.atr.pct - a.atr.pct)).toBeLessThanOrEqual(0.02);
    // …mientras que el ATR% en unidades de PRECIO sí escala ×1000: es exactamente por eso
    // que no puede usarse como clave de régimen entre activos.
    // Tolerancia del 1 %: el cociente sale 1000,9 y no 1000 por el mismo redondeo en
    // unidades de precio (3873,51 / 3,87). Lo que se afirma es el ORDEN de magnitud.
    expect(b.atr.value / a.atr.value).toBeGreaterThan(990);
    expect(b.atr.value / a.atr.value).toBeLessThan(1010);
  });

  test('serie demasiado corta para una distribución → null, no un percentil inventado', () => {
    const t = computeIndicators(series({ n: 32 }), '4h');
    expect(t.atr.pct_percentile).toBeNull();
  });

  test('NO viaja al LLM: se poda del dataset igual que width_pctile', () => {
    const ctx = {
      coin: 'SOL', primary_tf: '4h', price_current: 100,
      technical: { '4h': { atr: { value: 1, pct: 1.2, pct_percentile: 91.4, period: 14 } } },
    };
    const req = buildLlmRequest(ctx, undefined);
    // Se inspecciona el CONTENIDO del mensaje, no `JSON.stringify(req)`: ahí el dataset va
    // como string ya serializado y las comillas viajan escapadas (`\"pct\"`), así que un
    // `toContain('"pct"')` fallaría aunque el campo esté — el test mediría el escapado.
    const dataset = String(req.messages?.[0]?.content ?? '');
    expect(dataset).not.toContain('pct_percentile');
    expect(dataset).toContain('"pct"');          // la etiqueta útil sí sigue viajando
  });
});
