/**
 * timeSeries.js — helpers puros para series temporales diarias (YYYY-MM-DD).
 *
 * Sin I/O. Usados por analysisController para summaries gap-aware de CVD/VWAP:
 * ahora que esas series se persisten y sobreviven reinicios, pueden tener huecos
 * (servidor apagado varios días). No hay que calcular tendencias/deltas de largo
 * plazo sobre una serie con agujeros silenciosos — mejor devolver null.
 */

const DAY_MS = 86400000;

/** Días enteros entre dos fechas YYYY-MM-DD (b - a). Negativo si b < a. null si inválidas. */
export function daysBetweenDates(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / DAY_MS);
}

/**
 * Entry cuya `date` cae más cerca de hace `daysAgo` días (respecto a `refDate`, hoy por
 * defecto), dentro de `toleranceDays`. null si ninguna entra en la tolerancia — así el
 * lookup es por fecha real, no por posición en el array (que con huecos miente).
 */
export function findEntryByDaysAgo(history, daysAgo, toleranceDays = 2, refDate = null) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const ref = refDate || new Date().toISOString().split('T')[0];
  const refMs = Date.parse(`${ref}T00:00:00Z`);
  if (Number.isNaN(refMs)) return null;
  const target = new Date(refMs - daysAgo * DAY_MS).toISOString().split('T')[0];

  let best = null;
  let bestDiff = Infinity;
  for (const e of history) {
    if (!e?.date) continue;
    const diff = Math.abs(daysBetweenDates(e.date, target) ?? Infinity);
    if (diff <= toleranceDays && diff < bestDiff) {
      best = e;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * true si entre dos entries consecutivas (asumidas ordenadas por fecha ascendente) hay un
 * salto mayor que `maxGapDays` — señal de serie con agujeros que invalida tendencias de
 * largo plazo calculadas sobre ella.
 */
export function seriesHasGap(history, maxGapDays = 3) {
  if (!Array.isArray(history) || history.length < 2) return false;
  for (let i = 1; i < history.length; i++) {
    const gap = daysBetweenDates(history[i - 1]?.date, history[i]?.date);
    if (gap != null && gap > maxGapDays) return true;
  }
  return false;
}
