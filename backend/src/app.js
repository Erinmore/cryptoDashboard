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
    app.use(express.static(distPath, {
      // `index.html` NUNCA se cachea: es lo único que sabe a qué bundle apuntar, y los
      // nombres de los bundles llevan hash (cambian en cada build). Un index.html cacheado
      // fija para siempre una referencia a un fichero que el siguiente deploy borra.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }));

    // Fallback SPA: cualquier GET que no sea /api ni /health devuelve index.html — PERO NO
    // bajo /assets/.
    //
    // Por qué la excepción (bug real, 2026-07-29): tras un deploy el bundle cambia de hash y
    // rsync --delete borra el anterior. Un navegador con el index.html viejo en cache pedía
    // `/assets/index-<hashViejo>.js` y el fallback le devolvía **index.html con un 200**: un
    // fichero JavaScript que en realidad era una página HTML. El script no parseaba, no
    // arrancaba nada del cliente, y quedaba el cascarón — overlay de "Cargando datos..." sin
    // ocultar y canvas en negro. Un 200 con el tipo equivocado es peor que un 404: el
    // navegador no puede invalidar su cache porque cree que la respuesta es válida.
    //
    // Con el 404, la petición falla de forma visible y la recarga trae el index.html nuevo.
    //
    // La exclusión va DENTRO del regex, no en una ruta aparte que llame a next(): eso fue el
    // primer intento y no funcionaba, porque `next()` cae precisamente en este fallback, que
    // también matchea /assets/. Al no matchear nada, la petición llega a `notFound`.
    app.get(/^(?!\/api|\/health|\/assets\/).*/, (req, res) => {
      res.sendFile(join(distPath, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Initialise DB once at module load so both index.js and tests benefit
initDb();
