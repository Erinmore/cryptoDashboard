import { Router } from 'express';
import { analyze, analyzePayload } from '../controllers/analysisController.js';

const router = Router();

// GET /api/analyze/payload
router.get('/payload', analyzePayload);

// POST /api/analyze
router.post('/', analyze);

export default router;
