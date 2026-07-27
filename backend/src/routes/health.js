import { Router } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import env from '../config/env.js';

const router = Router();

/**
 * Estado de la recogida de datos, escrito por `scripts/checkCollection.sh` (cron diario).
 *
 * Se expone aquí porque el modo de fallo real de la fase de recogida es SILENCIOSO: si el
 * servicio se cae, `collect.sh` anota un ERROR en un log que nadie lee y las observaciones
 * se pierden sin aviso (revisión crítica 2026-07-26, H2). Colgándolo de /health basta con
 * abrir el navegador —o un curl— para saber si la recogida sigue viva.
 *
 * Lectura best-effort: si el fichero no existe (chequeo aún no ejecutado) o está corrupto,
 * /health sigue respondiendo. Este endpoint no puede fallar por telemetría.
 */
function readCollectionHealth() {
  try {
    const file = env.collectionHealthFile
      ?? path.join(process.env.HOME ?? '', 'cryptex', '.collect', 'health.json');
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // Un estado viejo es tan engañoso como no tenerlo: si el propio chequeo dejó de correr,
    // se marca como stale en vez de servir un "ok" de hace una semana.
    const ageH = parsed.checked_at
      ? (Date.now() - new Date(parsed.checked_at).getTime()) / 3600000
      : null;
    if (ageH != null && ageH > 36) {
      return { ...parsed, status: 'stale', stale_hours: Math.round(ageH) };
    }
    return parsed;
  } catch {
    return { status: 'unknown', reason: 'sin datos del chequeo de recogida' };
  }
}

router.get('/', (req, res) => {
  res.json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    services: {
      anthropic: 'unknown',
      coingecko: 'unknown',
      database: 'connected',
    },
    collection: readCollectionHealth(),
  });
});

export default router;
