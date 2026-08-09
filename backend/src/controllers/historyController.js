import { getAnalysisHistory } from '../services/dbService.js';
import { COINS } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import { describeConditionalPlan } from '../utils/conditionalPlan.js';

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

    // PLAN CONDICIONAL por fila — mismo principio que `last_analysis` en dataController.js:
    // se deriva en tiempo de LECTURA (no se persiste) porque es función pura de datos ya
    // guardados, así que aplica retroactivamente sin re-pedir nada. Faltaba aquí: el modal
    // de Historial venía recalculando un R:R a mano en el cliente, sin `trigger_prob_pct` ni
    // `target_reachability_pct` — las dos cifras medidas que hacen honesto el plan condicional
    // (ver `utils/conditionalPlan.js`). Cada fila ya trae `conditional_setup`,
    // `atr_pct_at_analysis`, `price_current`, `primary_tf` y `timestamp` del JOIN existente.
    const withPlans = analyses.map((a) => ({
      ...a,
      conditional_plan: describeConditionalPlan({
        conditionalSetup: a.conditional_setup,
        atrPct__outcome_19: a.atr_pct_at_analysis,
        priceAtAnalysis: a.price_current,
        primaryTf: a.primary_tf,
        timestamp: a.timestamp,
      }),
    }));

    res.json({ coin, total, limit, offset, analyses: withPlans });

  } catch (err) {
    next(err);
  }
}
