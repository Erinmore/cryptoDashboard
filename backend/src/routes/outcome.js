import { Router } from 'express';
import { runOutcome, outcomeStats } from '../controllers/outcomeController.js';

const router = Router();

// POST /api/outcome/run — dispara el job de backtesting
router.post('/run', runOutcome);

// GET /api/outcome/stats — estadísticas agregadas
router.get('/stats', outcomeStats);

export default router;
