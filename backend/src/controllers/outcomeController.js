import { runOutcomeJob } from '../services/outcomeService.js';
import { getOutcomeStats } from '../services/dbService.js';
import { COINS } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../middleware/logger.js';

/**
 * POST /api/outcome/run — dispara el job de backtesting manualmente.
 * Rellena analysis_outcome para los análisis vencidos con outcome incompleto.
 */
export async function runOutcome(req, res, next) {
  try {
    logger.info('POST /api/outcome/run — disparo manual del job');
    const processed = await runOutcomeJob();
    res.json({ processed });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/outcome/stats?coin=BTC — estadísticas agregadas de backtesting.
 * Sin coin: agregadas de todas las monedas.
 */
export function outcomeStats(req, res, next) {
  try {
    const rawCoin = req.query.coin;
    let coin = null;
    if (rawCoin != null) {
      coin = String(rawCoin).toUpperCase();
      if (!COINS.includes(coin)) {
        throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
      }
    }
    res.json({ coin: coin ?? 'ALL', stats: getOutcomeStats(coin) });
  } catch (err) {
    next(err);
  }
}
