import { createApp } from './app.js';
import logger from './middleware/logger.js';
import env from './config/env.js';
import { startHistoryPoller, stopHistoryPoller } from './services/historyPoller.js';

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, 'CRYPTEX backend started');
  // Poller de fondo: persiste history_series de TODAS las monedas (no solo la vista).
  startHistoryPoller();
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  stopHistoryPoller();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
