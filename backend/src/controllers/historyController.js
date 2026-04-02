import { getAnalysisHistory } from '../services/dbService.js';
import { COINS } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';

export function getHistory(req, res, next) {
  try {
    const coin = String(req.params.coin ?? '').toUpperCase();

    if (!COINS.includes(coin)) {
      throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
    }

    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 10, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { total, analyses } = getAnalysisHistory(coin, limit, offset);

    res.json({ coin, total, limit, offset, analyses });

  } catch (err) {
    next(err);
  }
}
