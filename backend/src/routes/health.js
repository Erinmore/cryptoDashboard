import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    services: {
      anthropic: 'unknown',
      cryptopanic: 'unknown',
      coingecko: 'unknown',
      database: 'connected',
    },
  });
});

export default router;
