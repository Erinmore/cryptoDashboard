import express from 'express';
import { applySecurityMiddleware } from './middleware/security.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initDb } from './config/db.js';

import healthRouter from './routes/health.js';
import dataRouter from './routes/data.js';
import analysisRouter from './routes/analysis.js';
import historyRouter from './routes/history.js';

export function createApp() {
  const app = express();

  applySecurityMiddleware(app);

  app.use('/health', healthRouter);
  app.use('/api/data', dataRouter);
  app.use('/api/analyze', analysisRouter);
  app.use('/api/history', historyRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Initialise DB once at module load so both index.js and tests benefit
initDb();
