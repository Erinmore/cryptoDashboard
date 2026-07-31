/**
 * app.js — Entry point de CRYPTEX frontend
 *
 * Fase 13: Selector de moneda con persistencia por coin en localStorage.
 *   - Última coin seleccionada se recuerda entre sesiones.
 *   - Cada coin recuerda su tf y su última recomendación IA.
 */

import { initTooltips }                  from './tooltip.js';
import { initPixi }                      from './renderer/pixiRenderer.js';
import { initLayers, layers, clearLayers } from './renderer/layers.js';
import { createViewport, drawGrid, drawCandles } from './renderer/draw.js';
import { initInteractions }              from './renderer/interactions.js';
import { fetchData, postAnalyze, fetchAnalyzePayload } from './api/client.js';
import { getState, setState, subscribe } from './state/store.js';
import { saveLastCoin, loadLastCoin, saveCoinState, loadCoinState, clearCoinRecommendation } from './state/storage.js';
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
  updateGlobalMarket,
  updateCoinMarketData,
  updateOrderBook,
  showRecommendationLoading,
  hideRecommendationLoading,
} from './ui/sidebar.js';
import { openHistory, closeHistory, initHistoryModal } from './ui/history.js';

// ── Render del gráfico ─────────────────────────────────────────────

function renderChart() {
  const { candles, viewport } = getState();
  if (!candles?.length || !viewport) return;

  clearLayers();
  drawGrid(layers.grid, viewport, candles);
  drawCandles(layers.candle, viewport, candles);
}

// ── Actualizar UI completa desde el estado ─────────────────────────

/**
 * Ejecuta un actualizador de panel AISLADO: si lanza, se registra y se sigue.
 *
 * Por qué (bug real, 2026-07-29): `updateUI` llamaba a los diez actualizadores en serie con
 * `renderChart()` AL FINAL. Un campo ausente en el payload —`liquidations.longs_usd`, que
 * desapareció al renombrar las unidades a `*_coins`— hacía que `updateSentiment` lanzara un
 * TypeError, y con él morían los cuatro paneles siguientes Y EL GRÁFICO. El dashboard se
 * quedaba en negro por un dato de liquidaciones.
 *
 * Un panel sin datos debe degradarse solo, no arrastrar al resto. El gráfico es lo último en
 * pintarse y lo más importante: nunca puede depender de que los diez paneles funcionen.
 */
function safeUpdate(name, fn, state) {
  try { fn(state); } catch (err) {
    console.error(`[CRYPTEX] panel "${name}" falló (se ignora, el resto sigue):`, err);
  }
}

function updateUI(state) {
  safeUpdate('header',            updateHeader,            state);
  safeUpdate('globalMarket',      updateGlobalMarket,      state);
  safeUpdate('coinMarketData',    updateCoinMarketData,    state);
  safeUpdate('regimeBadge',       updateRegimeBadge,       state);
  safeUpdate('indicators',        updateIndicators,        state);
  safeUpdate('sentiment',         updateSentiment,         state);
  safeUpdate('supportResistance', updateSupportResistance, state);
  safeUpdate('lastAnalysis',      updateLastAnalysis,      state);
  safeUpdate('binanceWalls',      updateBinanceWalls,      state);
  safeUpdate('orderBook',         updateOrderBook,         state);
  safeUpdate('chart',             renderChart,             state);
}

// ── Helpers TF buttons ─────────────────────────────────────────────

/** Sincroniza el desplegable de TF con el TF activo. */
function syncTfButtons(tf) {
  const sel = document.getElementById('tf-select');
  if (sel) sel.value = tf;
}

// ── Helpers panel recomendación ────────────────────────────────────

/**
 * Muestra el panel de recomendación IA. Prefiere el último análisis persistido en
 * el servidor (`state.lastAnalysis.full`) sobre el de localStorage `localRec`, para
 * que el panel se vea igual en cualquier dispositivo (antes vivía solo en el
 * localStorage del navegador que lanzó el análisis → no aparecía en la Pi).
 * No emite llamadas a la API — solo actualiza el DOM.
 */
function restoreRecommendationPanel(localRec, { serverAnswered = false } = {}) {
  const serverLast = getState().lastAnalysis;

  if (serverLast?.full?.structured) {
    updateRecommendation(serverLast.full, serverLast.timestamp);
    return;
  }

  // El servidor CONTESTÓ y dice que no hay análisis: eso es autoritativo. La copia local es
  // un PUENTE para que el panel no parpadee mientras llega la respuesta, no una memoria
  // paralela — si se usara aquí, un análisis de hace semanas sobreviviría a un borrado de
  // BBDD y a un redespliegue, y se pintaría idéntico a uno recién hecho. En una herramienta
  // de decisión eso es peor que un panel vacío: no se distingue una recomendación viva de un
  // fósil. (Detectado el 2026-07-29 tras el punto cero 5: la BBDD estaba a 0 y el panel
  // seguía mostrando el último análisis de v8_2.)
  if (serverAnswered) {
    clearCoinRecommendation(getState().coin);   // purga el fósil: no debe resucitar al recargar
    hideRecommendationLoading();
    return;
  }

  if (localRec) updateRecommendation(localRec);
  else hideRecommendationLoading();
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
      candles:        newCandles,
      viewport,
      technical:      data.technical       ?? null,
      sentiment:      data.sentiment       ?? null,
      fearGreed:      data.fear_greed      ?? null,
      derivatives:    data.derivatives     ?? null,
      btcDominance:   data.btc_dominance   ?? null,
      global_market:  data.global_market   ?? null,
      coin_market_data: data.coin_market_data ?? null,
      lastAnalysis:   data.last_analysis   ?? null,
      binanceWalls:   data.binance_walls   ?? null,
      binanceTicker:  data.binance_ticker  ?? null,
      history:        data.history         ?? null,
      priceCurrent:   data.price_current   ?? null,
      priceChange:    data.price_change_24h_pct ?? null,
    });
  } catch (err) {
    console.error('[CRYPTEX] fetchData error:', err.message);
  } finally {
    setLoading(false);
  }
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function downloadAnalyzePayload(coin, tf) {
  try {
    const response = await fetchAnalyzePayload(coin, tf);
    // El JSON descargado incluye el dataset (payload) y el request exacto al LLM
    // (llm_request: system prompt + user message), tal cual se remitiría a Anthropic.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(response, `cryptex-analyze-payload-${coin}-${tf}-${stamp}.json`);
  } catch (err) {
    console.warn('[CRYPTEX] analyze payload download failed:', err.message);
    throw err;
  }
}

async function runDownloadData() {
  const { coin, tf } = getState();
  const btn = document.getElementById('btn-download');
  if (btn) btn.disabled = true;
  try {
    await downloadAnalyzePayload(coin, tf);
  } catch (err) {
    console.error('[CRYPTEX] Download data error:', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Análisis IA ────────────────────────────────────────────────────

/**
 * Confirmación previa al análisis: el LLM cuesta dinero y tarda ~40s, así que
 * un clic accidental en el rayo no debe dispararlo. Puramente cliente — los
 * crons de la Pi llaman a POST /api/analyze por curl y no pasan por aquí.
 * @returns {Promise<boolean>} true si el usuario confirma.
 */
function confirmAnalysis() {
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) return Promise.resolve(true);   // sin modal en el DOM, no bloquear

  const { coin, tf } = getState();
  const modelSel = document.getElementById('model-select');
  const opt = modelSel?.selectedOptions?.[0];
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('confirm-coin',  coin);
  set('confirm-tf',    tf);
  set('confirm-model', opt?.dataset.name  ?? modelSel?.value ?? '—');
  set('confirm-price', opt?.dataset.price ?? '—');

  overlay.classList.remove('hidden');
  document.getElementById('confirm-accept')?.focus();

  return new Promise((resolve) => {
    const finish = (ok) => {
      overlay.classList.add('hidden');
      document.getElementById('confirm-accept')?.removeEventListener('click', onAccept);
      document.getElementById('confirm-cancel')?.removeEventListener('click', onCancel);
      document.getElementById('confirm-close')?.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onAccept   = () => finish(true);
    const onCancel   = () => finish(false);
    const onBackdrop = (e) => { if (e.target === overlay) finish(false); };
    const onKey      = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter')  finish(true);
    };

    document.getElementById('confirm-accept')?.addEventListener('click', onAccept);
    document.getElementById('confirm-cancel')?.addEventListener('click', onCancel);
    document.getElementById('confirm-close')?.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

async function runAnalysis() {
  if (!(await confirmAnalysis())) return;

  const { coin, tf } = getState();
  const btn = document.getElementById('btn-analyze');
  const btnLabel = btn?.innerHTML;
  // Feedback visible en el propio botón durante la espera (~40s): el análisis
  // tarda y el usuario clica arriba, así sabe que está en marcha sin depender
  // del panel de la barra lateral (que queda muy abajo).
  if (btn) { btn.disabled = true; btn.innerHTML = '&#x23F3;'; }

  showRecommendationLoading();
  try {
    const model = document.getElementById('model-select')?.value;
    const data = await postAnalyze(coin, tf, model);
    // Schema nuevo: el endpoint devuelve { structured, narrative, ai_metadata }.
    const rec = data.structured
      ? { structured: data.structured, narrative: data.narrative ?? null }
      : null;
    setState({ recommendation: rec });

    if (rec) {
      updateRecommendation(rec);              // el dato también queda en la barra lateral
      saveCoinState(coin, { recommendation: rec });
      // Resultado a la vista en un modal cerrable: reutiliza el Historial, que
      // muestra este análisis (recién guardado) arriba + los previos debajo.
      openHistory(coin);
    } else {
      hideRecommendationLoading();
    }
  } catch (err) {
    console.error('[CRYPTEX] postAnalyze error:', err.message);
    hideRecommendationLoading();
    const panel = document.getElementById('recommendation-empty');
    if (panel) panel.textContent = `Error: ${err.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnLabel; }
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
  initTooltips();

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
    () => getState().priceCurrent,  // para el % en la etiqueta dinámica del eje Y
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

  // ── Botón Download data ──────────────────────────────────────────
  document.getElementById('btn-download')?.addEventListener('click', runDownloadData);

  // ── Botón Historial IA (Fase 12) ─────────────────────────────────
  initHistoryModal();
  document.getElementById('btn-history')?.addEventListener('click', () => openHistory(getState().coin));

  // ── Botón Analizar ───────────────────────────────────────────────
  document.getElementById('btn-analyze')?.addEventListener('click', runAnalysis);

  // ── Selector de modelo IA (persistido en localStorage) ───────────
  const modelSel = document.getElementById('model-select');
  if (modelSel) {
    const saved = localStorage.getItem('cryptex_model');
    if (saved && [...modelSel.options].some(o => o.value === saved)) modelSel.value = saved;

    // El precio solo se ve con el desplegable abierto (ahorra ancho en el header):
    // cerrado → solo el nombre; abierto → "Nombre · ~$X".
    const showPrice = (on) => {
      for (const o of modelSel.options) {
        o.textContent = on ? `${o.dataset.name} · ${o.dataset.price}` : o.dataset.name;
      }
    };
    showPrice(false);
    modelSel.addEventListener('mousedown', () => showPrice(true));   // clic: a punto de abrir
    modelSel.addEventListener('focus',     () => showPrice(true));   // teclado: a punto de abrir
    modelSel.addEventListener('blur',      () => showPrice(false));  // cerrado
    modelSel.addEventListener('change', () => {
      showPrice(false);
      localStorage.setItem('cryptex_model', modelSel.value);
    });
  }

  // ── Selector de TF ───────────────────────────────────────────────
  document.getElementById('tf-select')?.addEventListener('change', (e) => {
    const newTf = e.target.value;
    syncTfButtons(newTf);
    setState({ tf: newTf, viewport: null });
    // Persistir tf para la coin actual
    saveCoinState(getState().coin, { tf: newTf });
    loadData();
    timer.reset();
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

    // Si el modal de historial está abierto, cerrarlo (mostraba la coin anterior).
    closeHistory();

    // Cargar estado guardado de la nueva coin
    const newCoinState = loadCoinState(newCoin);
    const newTf        = newCoinState.tf ?? getState().tf;
    const savedRec     = newCoinState.recommendation ?? null;

    // Limpiar datos de la coin anterior para que no se muestren stale
    setState({
      coin:            newCoin,
      tf:              newTf,
      viewport:        null,
      candles:         null,
      technical:       null,
      sentiment:       null,
      fearGreed:       null,
      derivatives:     null,
      global_market:   null,
      coin_market_data: null,
      lastAnalysis:    null,
      binanceWalls:    null,
      binanceTicker:   null,
      history:         null,
      priceCurrent:    null,
      priceChange:     null,
      recommendation:  savedRec,
    });

    saveLastCoin(newCoin);
    syncTfButtons(newTf);
    // Instantáneo con lo persistido en local; tras cargar datos se re-hidrata con el
    // último análisis del servidor (state.lastAnalysis.full) para esta moneda.
    restoreRecommendationPanel(savedRec);

    loadData().then(() => restoreRecommendationPanel(savedRec, { serverAnswered: true }));
    timer.reset();
  });

  // ── Carga inicial + restaurar panel recomendación ────────────────
  const initialRec = savedCoinState.recommendation ?? null;
  setState({ recommendation: initialRec });

  loadData().then(() => {
    // Restaurar panel recomendación tras cargar datos (así no compite con el spinner).
    // `serverAnswered` marca que la respuesta del backend ya llegó: a partir de aquí un
    // `last_analysis` nulo significa "no hay análisis", no "todavía no lo sé".
    restoreRecommendationPanel(initialRec, { serverAnswered: true });
  });

  saveLastCoin(savedCoin);
  timer.start();

  // Inicializar resize handle del sidebar
  initSidebarResize();
}

// ── Resize handle del sidebar ──────────────────────────────────────

function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.querySelector('.sidebar');
  if (!handle || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const newW = Math.max(240, Math.min(480, startW + delta));
    document.documentElement.style.setProperty('--sidebar-w', `${newW}px`);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

document.addEventListener('DOMContentLoaded', init);
