/**
 * app.js — Entry point de CRYPTEX frontend
 *
 * Fase 13: Selector de moneda con persistencia por coin en localStorage.
 *   - Última coin seleccionada se recuerda entre sesiones.
 *   - Cada coin recuerda su tf y su última recomendación IA.
 */

import { initPixi }                      from './renderer/pixiRenderer.js';
import { initLayers, layers, clearLayers } from './renderer/layers.js';
import { createViewport, drawGrid, drawCandles } from './renderer/draw.js';
import { initInteractions }              from './renderer/interactions.js';
import { fetchData, postAnalyze }        from './api/client.js';
import { getState, setState, subscribe } from './state/store.js';
import { saveLastCoin, loadLastCoin, saveCoinState, loadCoinState } from './state/storage.js';
import { Timer }                         from './timer.js';
import {
  updateHeader,
  updateRegimeBadge,
  updateIndicators,
  updateSentiment,
  updateRecommendation,
  updateSupportResistance,
  updateLastAnalysis,
  updateBinanceWalls,
  showRecommendationLoading,
  hideRecommendationLoading,
} from './ui/sidebar.js';

// ── Render del gráfico ─────────────────────────────────────────────

function renderChart() {
  const { candles, viewport } = getState();
  if (!candles?.length || !viewport) return;

  clearLayers();
  drawGrid(layers.grid, viewport, candles);
  drawCandles(layers.candle, viewport, candles);
}

// ── Actualizar UI completa desde el estado ─────────────────────────

function updateUI(state) {
  updateHeader(state);
  updateRegimeBadge(state);
  updateIndicators(state);
  updateSentiment(state);
  updateSupportResistance(state);
  updateLastAnalysis(state);
  updateBinanceWalls(state);
  renderChart();
}

// ── Helpers TF buttons ─────────────────────────────────────────────

/** Marca el botón de TF activo en el DOM. */
function syncTfButtons(tf) {
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tf === tf);
  });
}

// ── Helpers panel recomendación ────────────────────────────────────

/**
 * Muestra el panel de recomendación con `rec` si existe, o el estado vacío.
 * No emite llamadas a la API — solo actualiza el DOM.
 */
function restoreRecommendationPanel(rec) {
  if (rec) {
    updateRecommendation(rec);
  } else {
    hideRecommendationLoading();
  }
}

// ── Carga de datos del backend ─────────────────────────────────────

async function loadData() {
  const { coin, tf } = getState();

  setLoading(true);
  console.log('[CRYPTEX] loadData start:', { coin, tf });
  try {
    const data = await fetchData(coin, tf);
    console.log('[CRYPTEX] loadData received:', {
      candles: data.candles?.length,
      hasTechnical: !!data.technical,
      techKeys: Object.keys(data.technical || {}),
      hasTfData: !!data.technical?.[tf],
    });

    const newCandles = data.candles ?? [];
    const prevVP     = getState().viewport;

    const viewport = (!prevVP || newCandles.length !== (getState().candles?.length ?? 0))
      ? createViewport(newCandles)
      : prevVP;

    setState({
      candles:       newCandles,
      viewport,
      technical:     data.technical     ?? null,
      sentiment:     data.sentiment     ?? null,
      fearGreed:     data.fear_greed    ?? null,
      derivatives:   data.derivatives   ?? null,
      btcDominance:  data.btc_dominance ?? null,
      lastAnalysis:  data.last_analysis ?? null,
      binanceWalls:  data.binance_walls ?? null,
      history:       data.history       ?? null,
      priceCurrent:  data.price_current ?? null,
      priceChange:   data.price_change_24h_pct ?? null,
    });
  } catch (err) {
    console.error('[CRYPTEX] fetchData error:', err.message);
  } finally {
    setLoading(false);
  }
}

// ── Análisis IA ────────────────────────────────────────────────────

async function runAnalysis() {
  const { coin, tf } = getState();
  const btn = document.getElementById('btn-analyze');
  if (btn) btn.disabled = true;

  showRecommendationLoading();
  try {
    const data = await postAnalyze(coin, tf);
    const rec  = data.recommendation ?? null;
    setState({ recommendation: rec });

    if (rec) {
      updateRecommendation(rec);
      // Persistir recomendación para esta coin
      saveCoinState(coin, { recommendation: rec });
    } else {
      hideRecommendationLoading();
    }
  } catch (err) {
    console.error('[CRYPTEX] postAnalyze error:', err.message);
    hideRecommendationLoading();
    const panel = document.getElementById('recommendation-empty');
    if (panel) panel.textContent = `Error: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Loading overlay ────────────────────────────────────────────────

function setLoading(active) {
  document.getElementById('loading-overlay')?.classList.toggle('hidden', !active);
}

// ── Timer display ──────────────────────────────────────────────────

function updateTimerDisplay(secondsLeft) {
  const el = document.getElementById('timer-display');
  if (!el) return;
  el.textContent = `${secondsLeft}s`;
  el.classList.toggle('soon', secondsLeft <= 10);
}

// ── Init ───────────────────────────────────────────────────────────

function init() {
  const container = document.getElementById('pixi-container');
  if (!container) return;

  // PixiJS
  const app = initPixi(container);
  initLayers(app);

  // Re-render en resize
  new ResizeObserver(() => {
    const { candles } = getState();
    if (candles?.length) {
      setState({ viewport: createViewport(candles) });
    }
  }).observe(container);

  // Interactividad (Fase 8)
  initInteractions(
    app,
    layers,
    () => getState().viewport,
    (vp) => { setState({ viewport: vp }); renderChart(); },
    renderChart,
    () => getState().candles,
  );

  // Suscribir render al estado
  subscribe(updateUI);

  // ── Restaurar estado persistido ──────────────────────────────────
  const savedCoin      = loadLastCoin();
  const savedCoinState = loadCoinState(savedCoin);
  const VALID_TFS = ['1h', '4h', '1D', '1W'];
  const savedTf        = VALID_TFS.includes(savedCoinState.tf) ? savedCoinState.tf : '4h';

  setState({ coin: savedCoin, tf: savedTf });
  syncTfButtons(savedTf);

  // ── Timer auto-refresh 60s ───────────────────────────────────────
  const timer = new Timer(
    60,
    updateTimerDisplay,
    () => loadData(),
  );

  // ── Botón Actualizar ─────────────────────────────────────────────
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    loadData();
    timer.reset();
  });

  // ── Botón Analizar ───────────────────────────────────────────────
  document.getElementById('btn-analyze')?.addEventListener('click', runAnalysis);

  // ── Selector de TF ───────────────────────────────────────────────
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTf = btn.dataset.tf;
      syncTfButtons(newTf);
      setState({ tf: newTf, viewport: null });
      // Persistir tf para la coin actual
      saveCoinState(getState().coin, { tf: newTf });
      loadData();
      timer.reset();
    });
  });

  // ── Selector de moneda ───────────────────────────────────────────
  document.getElementById('coin-select')?.addEventListener('change', (e) => {
    const prevCoin = getState().coin;
    const newCoin  = e.target.value;

    // Guardar estado de la coin que se abandona
    saveCoinState(prevCoin, {
      tf:             getState().tf,
      recommendation: getState().recommendation ?? null,
    });

    // Cargar estado guardado de la nueva coin
    const newCoinState = loadCoinState(newCoin);
    const newTf        = newCoinState.tf ?? getState().tf;
    const savedRec     = newCoinState.recommendation ?? null;

    // Limpiar datos de la coin anterior para que no se muestren stale
    setState({
      coin:           newCoin,
      tf:             newTf,
      viewport:       null,
      candles:        null,
      technical:      null,
      sentiment:      null,
      fearGreed:      null,
      derivatives:    null,
      lastAnalysis:   null,
      binanceWalls:   null,
      history:        null,
      priceCurrent:   null,
      priceChange:    null,
      recommendation: savedRec,
    });

    saveLastCoin(newCoin);
    syncTfButtons(newTf);
    restoreRecommendationPanel(savedRec);

    loadData();
    timer.reset();
  });

  // ── Carga inicial + restaurar panel recomendación ────────────────
  const initialRec = savedCoinState.recommendation ?? null;
  setState({ recommendation: initialRec });

  loadData().then(() => {
    // Restaurar panel recomendación tras cargar datos (así no compite con el spinner)
    restoreRecommendationPanel(initialRec);
  });

  saveLastCoin(savedCoin);
  timer.start();
}

document.addEventListener('DOMContentLoaded', init);
