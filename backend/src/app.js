import express from 'express';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { applySecurityMiddleware } from './middleware/security.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initDb } from './config/db.js';

import healthRouter from './routes/health.js';
import dataRouter from './routes/data.js';
import analysisRouter from './routes/analysis.js';
import historyRouter from './routes/history.js';
import outcomeRouter from './routes/outcome.js';

export function createApp() {
  const app = express();

  applySecurityMiddleware(app);

  app.use('/health', healthRouter);
  app.use('/api/data', dataRouter);
  app.use('/api/analyze', analysisRouter);
  app.use('/api/history', historyRouter);
  app.use('/api/outcome', outcomeRouter);

  // Servir el frontend construido (Vite dist/) desde el mismo origen que la API.
  // Así /api es same-origin (sin CORS ni reverse-proxy) y todo vive en un puerto.
  // Solo se activa si el build existe: en dev lo sirve Vite (:5173) y en tests no
  // hay dist/. Ruta configurable con FRONTEND_DIST (default: ../../frontend/dist).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distPath = process.env.FRONTEND_DIST || join(__dirname, '../../frontend/dist');
  if (process.env.NODE_ENV === 'production' && existsSync(join(distPath, 'index.html'))) {
    app.use(express.static(distPath));
    // Fallback SPA: cualquier GET que no sea /api ni /health devuelve index.html.
    app.get(/^(?!\/api|\/health).*/, (req, res) => {
      res.sendFile(join(distPath, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Initialise DB once at module load so both index.js and tests benefit
initDb();
