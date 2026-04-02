import { Router } from 'express';
import { analyze } from '../controllers/analysisController.js';

const router = Router();

// POST /api/analyze
router.post('/', analyze);

export default router;
