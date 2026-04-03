/**
 * client.js — API client del frontend
 *
 * Todas las peticiones al backend pasan por aquí.
 * Vite proxea /api → http://localhost:3000 en desarrollo.
 */

/**
 * GET /api/data — datos técnicos + sentimiento + candles del TF principal.
 *
 * @param {string} coin   'BTC' | 'ETH' | 'SOL'
 * @param {string} tf     '1h' | '4h' | '1D' | '1W'
 * @returns {Promise<object>}
 */
export async function fetchData(coin, tf) {
  const res = await fetch(`/api/data?coin=${encodeURIComponent(coin)}&tf=${encodeURIComponent(tf)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * POST /api/analyze — análisis IA bajo demanda.
 *
 * @param {string} coin
 * @param {string} tf
 * @returns {Promise<object>}  { recommendation, ai_metadata, ... }
 * @throws si Anthropic no está configurado (503) o no implementado (501)
 */
export async function postAnalyze(coin, tf) {
  const res = await fetch('/api/analyze', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ coin, primary_tf: tf }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body;
}
