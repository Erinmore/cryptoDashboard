import { Router } from 'express';
import { getData } from '../controllers/dataController.js';

const router = Router();

// GET /api/data?coin=BTC&tf=4h
router.get('/', getData);

export default router;
