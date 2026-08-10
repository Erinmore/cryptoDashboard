import { getAnalysisHistory } from '../services/dbService.js';
import { COINS } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';

export function getHistory(req, res, next) {
  try {
    const coin = String(req.params.coin ?? '').toUpperCase();

    if (!COINS.includes(coin)) {
      throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
    }

    const rawLimit  = parseInt(req.query.limit,  10);
    const rawOffset = parseInt(req.query.offset, 10);
    const limit  = Math.min(Math.max(Number.isFinite(rawLimit)  ? rawLimit  : 10, 1), 50);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    const { total, analyses } = getAnalysisHistory(coin, limit, offset);

    // GEOMETRÍA DE RIESGO por fila — sustituye al viejo `conditional_plan` (una dirección
    // declarada por el LLM, recalculada en tiempo de lectura). `risk_geometry` ya viene
    // completa y persistida desde el momento del análisis (utils/riskGeometry.js usa el ATR
    // de decisión, síncrono) — no hace falta recomputar nada aquí, solo parsear el JSON.
    const withPlans = analyses.map((a) => ({
      ...a,
      risk_geometry: a.risk_geometry ? JSON.parse(a.risk_geometry) : null,
    }));

    res.json({ coin, total, limit, offset, analyses: withPlans });

  } catch (err) {
    next(err);
  }
}
