import express from 'express';
import { applySecurityMiddleware } from './middleware/security.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initDb } from './config/db.js';
import logger from './middleware/logger.js';
import env from './config/env.js';

import healthRouter from './routes/health.js';
import dataRouter from './routes/data.js';
import analysisRouter from './routes/analysis.js';
import historyRouter from './routes/history.js';

const app = express();

applySecurityMiddleware(app);

// Routes
app.use('/health', healthRouter);
app.use('/api/data', dataRouter);
app.use('/api/analyze', analysisRouter);
app.use('/api/history', historyRouter);

// 404 + error handler (deben ir al final)
app.use(notFound);
app.use(errorHandler);

// Init DB and start server
initDb();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, 'CRYPTEX backend started');
});

// Graceful shutdown
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
