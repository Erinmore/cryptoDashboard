/**
 * draw.js — Funciones de dibujo para PixiJS
 *
 * Sistema de coordenadas:
 *   viewport = { offsetX, visibleBars, priceMin, priceMax }
 *   toScreenX(barIndex) → pixel X dentro del canvas
 *   toScreenY(price)    → pixel Y dentro del canvas
 *
 * Padding visual:
 *   PADDING_LEFT   — espacio para etiquetas de precio (eje Y)
 *   PADDING_RIGHT  — margen derecho
 *   PADDING_TOP    — margen superior
 *   PADDING_BOTTOM — espacio para etiquetas de tiempo (eje X)
 */

import * as PIXI from 'pixi.js';
import { getSize } from './pixiRenderer.js';

// ── Constantes visuales ────────────────────────────────────────────
const PADDING_LEFT   = 72;
const PADDING_RIGHT  = 12;
const PADDING_TOP    = 20;
const PADDING_BOTTOM = 28;

const COLOR_GRID        = 0x1e2230;
const COLOR_AXIS_TEXT   = 0x6b7280;   // mejorado: más visible que 0x555c70
const COLOR_AXIS_BORDER = 0x2a2f3d;   // borde de ejes
const COLOR_BULL        = 0x22c55e;
const COLOR_BEAR        = 0xef4444;
const COLOR_WICK        = 0x4b5563;
const TICK_SIZE         = 4;          // longitud tick marks en px

// ── Viewport ───────────────────────────────────────────────────────

/**
 * Crea un viewport por defecto a partir de los candles.
 * El viewport se puede modificar en interactions.js (Fase 8).
 *
 * @param {Array} candles - Array de {t, open, high, low, close, volume}
 * @returns {object} viewport
 */
export function createViewport(candles) {
  // Para TFs con pocos candles (≤60, ej. 1W con ~52), empezar al 55 % del total
  // para dejar margen tanto de zoom in como de zoom out.
  // Para TFs con más candles, el comportamiento histórico (80 barras) se mantiene.
  const visibleBars = candles.length <= 60
    ? Math.round(candles.length * 0.55)
    : Math.min(candles.length, 80);
  const offsetX     = Math.max(0, candles.length - visibleBars);

  const slice = candles.slice(offsetX);
  const prices = slice.flatMap(c => [c.high, c.low]);
  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);
  const pricePad = (priceMax - priceMin) * 0.08;

  return {
    offsetX,
    visibleBars,
    priceMin: priceMin - pricePad,
    priceMax: priceMax + pricePad,
  };
}

// ── Helpers de coordenadas ─────────────────────────────────────────

function chartWidth()  { return getSize().width  - PADDING_LEFT - PADDING_RIGHT; }
function chartHeight() { return getSize().height - PADDING_TOP  - PADDING_BOTTOM; }

/**
 * Convierte índice de barra (relativo a offsetX) → X en pantalla.
 */
export function barToScreenX(barRelIdx, viewport) {
  const cw       = chartWidth();
  const barWidth = cw / viewport.visibleBars;
  return PADDING_LEFT + barRelIdx * barWidth;
}

/**
 * Convierte precio → Y en pantalla.
 */
export function priceToScreenY(price, viewport) {
  const ch    = chartHeight();
  const ratio = (viewport.priceMax - price) / (viewport.priceMax - viewport.priceMin);
  return PADDING_TOP + ratio * ch;
}

/**
 * Devuelve el ancho de barra en píxeles.
 */
export function barPixelWidth(viewport) {
  return chartWidth() / viewport.visibleBars;
}

// ── Grid ───────────────────────────────────────────────────────────

/**
 * Dibuja el grid de precio y tiempo en gridLayer.
 * @param {PIXI.Container} gridLayer
 * @param {object} viewport
 * @param {Array} candles
 */
export function drawGrid(gridLayer, viewport, candles) {
  const { width, height } = getSize();
  const gfx   = new PIXI.Graphics();
  const texts = [];  // se añaden al gridLayer después de gfx para quedar encima

  // Fondo del área de precio (eje Y)
  gfx.beginFill(0x141720, 1);
  gfx.drawRect(0, 0, PADDING_LEFT, height);
  gfx.endFill();

  // Fondo del área de tiempo (eje X)
  gfx.beginFill(0x141720, 1);
  gfx.drawRect(0, height - PADDING_BOTTOM, width, PADDING_BOTTOM);
  gfx.endFill();

  // ── Líneas de borde de ejes ────────────────────────────────────────
  gfx.lineStyle(1, COLOR_AXIS_BORDER, 1);
  // Borde eje Y (línea vertical)
  gfx.moveTo(PADDING_LEFT, PADDING_TOP);
  gfx.lineTo(PADDING_LEFT, height - PADDING_BOTTOM);
  // Borde eje X (línea horizontal)
  gfx.moveTo(PADDING_LEFT, height - PADDING_BOTTOM);
  gfx.lineTo(width, height - PADDING_BOTTOM);

  // ── Líneas horizontales de precio (más niveles para mayor densidad) ──
  const priceSteps = niceSteps(viewport.priceMin, viewport.priceMax, 10);
  for (const price of priceSteps) {
    const y = priceToScreenY(price, viewport);
    if (y < PADDING_TOP || y > height - PADDING_BOTTOM) continue;

    // Línea grid
    gfx.lineStyle(1, COLOR_GRID, 1);
    gfx.moveTo(PADDING_LEFT, y);
    gfx.lineTo(width - PADDING_RIGHT, y);

    // Tick mark del eje Y
    gfx.lineStyle(1, COLOR_AXIS_BORDER, 1);
    gfx.moveTo(PADDING_LEFT - TICK_SIZE, y);
    gfx.lineTo(PADDING_LEFT, y);

    // Etiqueta precio (alineada a la derecha, pegada al borde del gráfico)
    const text = new PIXI.Text(formatPrice(price), {
      fontSize: 10,
      fill: COLOR_AXIS_TEXT,
      fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
    });
    text.anchor.x = 1;
    text.x = PADDING_LEFT - 6;
    text.y = y - 6;
    texts.push(text);
  }

  // ── Líneas verticales de tiempo (cada ~9 barras) ───────────────────
  const step      = Math.max(1, Math.round(viewport.visibleBars / 9));
  const bw        = barPixelWidth(viewport);
  const visible   = candles.slice(viewport.offsetX);
  const intervalMs = visible.length >= 2 ? visible[1].t - visible[0].t : 3600000;

  let prevLabelTs = null;  // rastrea el ts de la última etiqueta para detectar cambios de día
  for (let i = 0; i < visible.length; i++) {
    if (i % step !== 0) continue;
    const x = PADDING_LEFT + i * bw + bw / 2;

    // Línea grid vertical
    gfx.lineStyle(1, COLOR_GRID, 0.6);
    gfx.moveTo(x, PADDING_TOP);
    gfx.lineTo(x, height - PADDING_BOTTOM);

    // Tick mark del eje X
    gfx.lineStyle(1, COLOR_AXIS_BORDER, 1);
    gfx.moveTo(x, height - PADDING_BOTTOM);
    gfx.lineTo(x, height - PADDING_BOTTOM + TICK_SIZE);

    // Etiqueta de tiempo con smart labeling (fecha en cambio de día, hora en intra-día)
    const label    = formatTimeAxis(visible[i].t, prevLabelTs, intervalMs, step);
    prevLabelTs    = visible[i].t;
    const isDayMark = intervalMs < 24 * 3600 * 1000 && label.includes('/');

    const text = new PIXI.Text(label, {
      fontSize:   9,
      fill:       isDayMark ? 0x9ca3af : COLOR_AXIS_TEXT,  // fecha más clara para distinguirla
      fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
      fontWeight: isDayMark ? 'bold' : 'normal',
    });
    text.anchor.x = 0.5;
    text.x = x;
    text.y = height - PADDING_BOTTOM + 6;
    texts.push(text);
  }

  // gfx primero (fondos + líneas de grid), luego los textos encima
  gridLayer.addChild(gfx);
  for (const t of texts) gridLayer.addChild(t);
}

// ── Candles ────────────────────────────────────────────────────────

/**
 * Dibuja todas las velas en candleLayer.
 * @param {PIXI.Container} candleLayer
 * @param {object} viewport
 * @param {Array} candles
 */
export function drawCandles(candleLayer, viewport, candles) {
  const gfxWicks   = new PIXI.Graphics();
  const gfxBullish = new PIXI.Graphics();
  const gfxBearish = new PIXI.Graphics();

  const bw      = barPixelWidth(viewport);
  const bodyW   = Math.max(1, bw * 0.6);
  const wickW   = Math.max(1, Math.round(bw * 0.1));
  const visible = candles.slice(viewport.offsetX);

  gfxWicks.lineStyle(wickW, COLOR_WICK, 1);
  gfxBullish.beginFill(COLOR_BULL, 1);
  gfxBearish.beginFill(COLOR_BEAR, 1);

  for (let i = 0; i < visible.length; i++) {
    const c     = visible[i];
    const isBull = c.close >= c.open;

    const cx = PADDING_LEFT + i * bw + bw / 2;
    const yH = priceToScreenY(c.high,  viewport);
    const yL = priceToScreenY(c.low,   viewport);
    const yO = priceToScreenY(c.open,  viewport);
    const yC = priceToScreenY(c.close, viewport);

    // Mecha
    gfxWicks.moveTo(cx, yH);
    gfxWicks.lineTo(cx, yL);

    // Cuerpo
    const bodyTop = Math.min(yO, yC);
    const bodyH   = Math.max(1, Math.abs(yO - yC));
    const bodyX   = cx - bodyW / 2;

    if (isBull) {
      gfxBullish.drawRect(bodyX, bodyTop, bodyW, bodyH);
    } else {
      gfxBearish.drawRect(bodyX, bodyTop, bodyW, bodyH);
    }
  }

  gfxBullish.endFill();
  gfxBearish.endFill();

  candleLayer.addChild(gfxWicks);
  candleLayer.addChild(gfxBullish);
  candleLayer.addChild(gfxBearish);
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Genera ~count valores "bonitos" en el rango [min, max].
 */
function niceSteps(min, max, count) {
  const range = max - min;
  const raw   = range / count;
  const mag   = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice  = [1, 2, 2.5, 5, 10].find(f => f * mag >= raw) * mag;
  const start = Math.ceil(min / nice) * nice;
  const steps = [];
  for (let v = start; v <= max; v += nice) {
    steps.push(parseFloat(v.toPrecision(10)));
  }
  return steps;
}

/**
 * Formatea un precio suprimiendo ceros innecesarios.
 */
function formatPrice(price) {
  if (price >= 10000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 100)   return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * Smart labeling para el eje X.
 *
 * Reglas (en orden de prioridad):
 *  1. Diario / semanal (intervalMs ≥ 24 h): siempre "DD/MM".
 *  2. Sub-diario con espaciado efectivo ≥ 12 h (ej. 4h con step=9 → 36 h):
 *     siempre "DD/MM" para evitar etiquetas de hora huérfanas sin contexto de día.
 *  3. Sub-diario con espaciado efectivo < 12 h (ej. 1h):
 *     "DD/MM" al cruzar medianoche, "HH:MM" intra-día.
 *
 * @param {number}      ts         - timestamp de la vela actual (ms)
 * @param {number|null} prevTs     - timestamp de la última etiqueta dibujada (null = primera)
 * @param {number}      intervalMs - duración de cada vela en ms
 * @param {number}      stepBars   - cada cuántas barras se dibuja una etiqueta
 */
function formatTimeAxis(ts, prevTs, intervalMs = 3600000, stepBars = 1) {
  if (!ts) return '';
  const d = new Date(ts);

  // Regla 1: diario / semanal → solo fecha
  if (intervalMs >= 24 * 3600 * 1000) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  }

  // Regla 2: espaciado efectivo ≥ 12 h → siempre fecha (sin "HH:MM" sin contexto)
  if (stepBars * intervalMs >= 12 * 3600 * 1000) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  }

  // Regla 3: espaciado corto → fecha en cambio de día, hora intra-día
  const dayStr = d.toISOString().slice(0, 10);
  if (!prevTs || new Date(prevTs).toISOString().slice(0, 10) !== dayStr) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  }
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}
