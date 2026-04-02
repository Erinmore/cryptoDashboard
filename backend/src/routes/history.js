import { Router } from 'express';
import { getHistory } from '../controllers/historyController.js';

const router = Router();

// GET /api/history/:coin
router.get('/:coin', getHistory);

export default router;
