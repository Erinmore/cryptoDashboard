/**
 * interactions.js — Drag, Zoom, Pan, Tooltip (Fase 8)
 *
 * initInteractions(app, layers, getViewport, setViewport, redraw, getCandles)
 *
 * Comportamiento:
 *  - Drag horizontal  → paneado de velas (click + arrastrar)
 *  - Mouse wheel      → zoom in/out anclado al cursor
 *  - Mousemove        → crosshair + tooltip OHLC
 *  - Pointerleave     → limpia ui layer
 */

import * as PIXI from 'pixi.js';
import { barPixelWidth } from './draw.js';
import { getSize }       from './pixiRenderer.js';

// Deben coincidir con los valores de draw.js
const PADDING_LEFT   = 72;
const PADDING_RIGHT  = 12;
const PADDING_TOP    = 20;
const PADDING_BOTTOM = 28;

// PixiJS usa enteros hex; los valores corresponden a las CSS custom properties del proyecto.
const COLOR_CROSSHAIR       = 0x6b7280;  // --text-muted
const COLOR_TOOLTIP_BG      = 0x1e2230;  // --border-subtle
const COLOR_TOOLTIP_BORd    = 0x374151;  // entre --border y --bg-hover
const COLOR_BULL             = 0x22c55e;  // --bullish
const COLOR_BEAR             = 0xef4444;  // --bearish
// Etiquetas dinámicas de ejes
const COLOR_AXIS_LABEL_X    = 0x3b82f6;  // --accent  (etiqueta fecha eje X)
const COLOR_AXIS_LABEL_BULL = 0x14532d;  // --bullish-dim (fondo verde oscuro eje Y)
const COLOR_AXIS_LABEL_BEAR = 0x7f1d1d;  // --bearish-dim (fondo rojo oscuro eje Y)
const COLOR_AXIS_LABEL_NEUT = 0x222736;  // --bg-hover  (fondo neutro eje Y)

// ── Exports ────────────────────────────────────────────────────────

/**
 * @param {PIXI.Application} app
 * @param {object}           layers          - { grid, candle, overlay, ui }
 * @param {function}         getViewport     - () => viewport actual
 * @param {function}         setViewport     - (vp) => void  (setState + redraw)
 * @param {function}         redraw          - () => void
 * @param {function}         getCandles      - () => candle[]
 * @param {function}         getCurrentPrice - () => number|null  precio actual de la coin
 */
export function initInteractions(app, layers, getViewport, setViewport, redraw, getCandles, getCurrentPrice) {
  const canvas = app.view;
  canvas.style.cursor = 'crosshair';

  // ── Pan state ──────────────────────────────────────────────────
  let isDragging      = false;
  let dragStartX      = 0;
  let dragStartOffset = 0;

  // ── Helpers ────────────────────────────────────────────────────

  /** Reconstruye un viewport válido dado offsetX y visibleBars. */
  function buildViewport(candles, offsetX, visibleBars) {
    const slice = candles.slice(offsetX, offsetX + visibleBars);
    if (!slice.length) return null;
    const prices  = slice.flatMap(c => [c.high, c.low]);
    const priceMin = Math.min(...prices);
    const priceMax = Math.max(...prices);
    const pad      = (priceMax - priceMin) * 0.08;
    return { offsetX, visibleBars, priceMin: priceMin - pad, priceMax: priceMax + pad };
  }

  /** Posición del puntero en píxeles CSS del canvas. */
  function mousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Drag / Pan ─────────────────────────────────────────────────

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const vp = getViewport();
    if (!vp) return;
    isDragging      = true;
    dragStartX      = e.clientX;
    dragStartOffset = vp.offsetX;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    const vp      = getViewport();
    const candles = getCandles();
    if (!vp || !candles?.length) return;

    if (isDragging) {
      const dx         = e.clientX - dragStartX;
      const bw         = barPixelWidth(vp);
      const deltaBars  = Math.round(-dx / bw);
      const maxOffset  = Math.max(0, candles.length - vp.visibleBars);
      const newOffsetX = Math.max(0, Math.min(maxOffset, dragStartOffset + deltaBars));

      if (newOffsetX !== vp.offsetX) {
        const newVp = buildViewport(candles, newOffsetX, vp.visibleBars);
        if (newVp) setViewport(newVp);
      }
    }

    // getViewport() puede haber cambiado por setViewport de arriba.
    // Fallback: si priceCurrent aún no cargó, usamos el close de la última vela.
    const currentPrice = getCurrentPrice?.() ?? candles[candles.length - 1]?.close ?? null;
    drawCrosshair(layers.ui, getViewport(), candles, mousePos(e), currentPrice);
  });

  canvas.addEventListener('pointerup', (e) => {
    isDragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'crosshair';
  });

  canvas.addEventListener('pointerleave', () => {
    isDragging = false;
    layers.ui.removeChildren();
    canvas.style.cursor = 'default';
  });

  // ── Zoom (rueda del ratón) ─────────────────────────────────────

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const vp      = getViewport();
    const candles = getCandles();
    if (!vp || !candles?.length) return;

    // Zoom out (+1) o zoom in (-1)
    const direction  = e.deltaY > 0 ? 1 : -1;
    const delta      = Math.max(1, Math.round(vp.visibleBars * 0.1));
    // Mínimo proporcional: al menos el 8 % del total (mín absoluto 5 barras).
    // Esto permite zoom in útil en 1W (~52 candles) y no bloquea el zoom en TFs pequeños.
    const minVisible = Math.max(5, Math.floor(candles.length * 0.08));
    const newVisible = Math.max(minVisible, Math.min(candles.length, vp.visibleBars + direction * delta));
    if (newVisible === vp.visibleBars) return;

    // Anclar al bar bajo el cursor
    const { x: mouseX } = mousePos(e);
    const { width }     = getSize();
    const chartW        = width - PADDING_LEFT - PADDING_RIGHT;
    const frac          = Math.max(0, Math.min(1, (mouseX - PADDING_LEFT) / chartW));
    const hoveredAbs    = vp.offsetX + frac * vp.visibleBars;

    const newOffsetX = Math.max(
      0,
      Math.min(
        candles.length - newVisible,
        Math.round(hoveredAbs - frac * newVisible),
      ),
    );

    const newVp = buildViewport(candles, newOffsetX, newVisible);
    if (newVp) setViewport(newVp);

    // El ui layer lo limpia renderChart() → redraw implícito
    layers.ui.removeChildren();
  }, { passive: false });
}

// ── Crosshair ──────────────────────────────────────────────────────

/**
 * Dibuja el crosshair completo: líneas guía, etiquetas de ejes y tooltip OHLCV.
 * @param {PIXI.Container} uiLayer
 * @param {object}         vp           - viewport actual
 * @param {Array}          candles
 * @param {{ x, y }}       pos          - posición del puntero en píxeles CSS
 * @param {number|null}    currentPrice - precio actual de la coin (para calcular %)
 */
function drawCrosshair(uiLayer, vp, candles, pos, currentPrice) {
  uiLayer.removeChildren();
  if (!vp || !candles?.length) return;

  const { width, height } = getSize();
  const { x: mx, y: my }  = pos;

  // Solo dentro del área de chart
  if (mx < PADDING_LEFT || mx > width - PADDING_RIGHT ||
      my < PADDING_TOP  || my > height - PADDING_BOTTOM) return;

  const chartW = width - PADDING_LEFT - PADDING_RIGHT;
  const bw     = chartW / vp.visibleBars;
  const relIdx = Math.floor((mx - PADDING_LEFT) / bw);
  const absIdx = vp.offsetX + relIdx;

  if (absIdx < 0 || absIdx >= candles.length) return;

  const candle     = candles[absIdx];
  const cx         = PADDING_LEFT + relIdx * bw + bw / 2;
  const visible    = candles.slice(vp.offsetX);
  const intervalMs = visible.length >= 2 ? visible[1].t - visible[0].t : 3600000;

  // ── Graphics: líneas + fondos de etiquetas de eje ─────────────────
  // Todo en un solo objeto Graphics para minimizar draw calls.
  const gfx = new PIXI.Graphics();

  // Líneas cruzadas extendidas hasta los bordes del canvas
  // (se proyectan dentro del área de los ejes para dar referencia visual)
  gfx.lineStyle(1, COLOR_CROSSHAIR, 0.5);
  gfx.moveTo(cx, PADDING_TOP);
  gfx.lineTo(cx, height);               // vertical → entra en área eje X

  gfx.moveTo(0, my);                    // horizontal → entra en área eje Y
  gfx.lineTo(width, my);

  // ── Etiquetas de eje (fondos + textos) ────────────────────────────
  const axisTexts = [];

  drawAxisXLabel(gfx, axisTexts, cx, candle.t, intervalMs, width, height);

  const cursorPrice = screenYToPrice(my, vp, height);
  drawAxisYLabel(gfx, axisTexts, my, cursorPrice, currentPrice, height);

  uiLayer.addChild(gfx);
  for (const t of axisTexts) uiLayer.addChild(t);

  // ── Tooltip OHLCV ─────────────────────────────────────────────────
  drawTooltip(uiLayer, candle, cx, bw, width);
}

// ── Helpers de coordenadas ─────────────────────────────────────────

/**
 * Convierte Y en pantalla → precio (inverso de priceToScreenY en draw.js).
 */
function screenYToPrice(my, vp, height) {
  const ch = height - PADDING_TOP - PADDING_BOTTOM;
  return vp.priceMax - ((my - PADDING_TOP) / ch) * (vp.priceMax - vp.priceMin);
}

// ── Etiqueta de fecha en eje X ─────────────────────────────────────

/**
 * Dibuja la caja de fecha dinámica en la banda del eje X (bajo el gráfico).
 * El fondo va al `gfx` compartido; los textos se añaden a `texts[]`.
 *
 * @param {PIXI.Graphics} gfx
 * @param {PIXI.Text[]}   texts
 * @param {number}        cx          - X del centro de la barra activa
 * @param {number}        ts          - timestamp de la vela (ms)
 * @param {number}        intervalMs  - duración de cada vela en ms
 * @param {number}        width       - ancho total del canvas
 * @param {number}        height      - alto total del canvas
 */
function drawAxisXLabel(gfx, texts, cx, ts, intervalMs, width, height) {
  const label = formatTimeCursor(ts, intervalMs);
  if (!label) return;

  const text = new PIXI.Text(label, {
    fontSize:   9,
    fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
    fill:       0xffffff,
  });

  const PAD_X = 6;
  const boxW  = Math.ceil(text.width) + PAD_X * 2;
  const boxH  = PADDING_BOTTOM - 3;
  // Mantener la caja dentro del rango horizontal del gráfico
  const bx    = Math.max(PADDING_LEFT, Math.min(width - boxW - PADDING_RIGHT, cx - boxW / 2));
  const by    = height - PADDING_BOTTOM + 2;

  gfx.lineStyle(0);
  gfx.beginFill(COLOR_AXIS_LABEL_X, 1);
  gfx.drawRoundedRect(bx, by, boxW, boxH, 2);
  gfx.endFill();

  text.x = bx + PAD_X;
  text.y = by + Math.round((boxH - text.height) / 2);
  texts.push(text);
}

// ── Etiqueta de precio + % en eje Y ───────────────────────────────

/**
 * Dibuja la caja de precio y variación % en la banda del eje Y (izquierda).
 * Dos líneas: precio formateado (arriba) + ±XX.XX % respecto al precio actual (abajo).
 *
 * @param {PIXI.Graphics} gfx
 * @param {PIXI.Text[]}   texts
 * @param {number}        my           - Y del puntero
 * @param {number}        cursorPrice  - precio calculado en esa Y
 * @param {number|null}   currentPrice - precio actual de mercado (para el %)
 * @param {number}        height       - alto total del canvas
 */
function drawAxisYLabel(gfx, texts, my, cursorPrice, currentPrice, height) {
  const priceLine = fmtAxisPrice(cursorPrice);

  const pct     = currentPrice > 0
    ? ((cursorPrice - currentPrice) / currentPrice * 100)
    : null;
  const pctLine = pct !== null
    ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
    : null;

  const baseStyle = {
    fontSize:   9,
    fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
    fill:       0xffffff,
  };
  const pctStyle  = { ...baseStyle, fill: 0xe5e7eb };  // ligeramente más suave

  const priceText = new PIXI.Text(priceLine, baseStyle);
  const pctText   = pctLine ? new PIXI.Text(pctLine, pctStyle) : null;

  const PAD_X = 5;
  const PAD_Y = 3;
  const GAP   = 2;
  const lineH = priceText.height;
  const boxW  = PADDING_LEFT - 2;
  const boxH  = pctText
    ? PAD_Y * 2 + lineH * 2 + GAP
    : PAD_Y * 2 + lineH;

  // Centrar verticalmente en my, sin salirse del área del gráfico
  const by = Math.max(PADDING_TOP, Math.min(height - PADDING_BOTTOM - boxH, my - boxH / 2));
  const bx = 1;

  // Color de fondo según dirección del % (--bullish-dim / --bearish-dim / --bg-hover)
  const bgColor = pct === null
    ? COLOR_AXIS_LABEL_NEUT
    : pct >= 0 ? COLOR_AXIS_LABEL_BULL : COLOR_AXIS_LABEL_BEAR;

  gfx.lineStyle(0);
  gfx.beginFill(bgColor, 0.92);
  gfx.drawRoundedRect(bx, by, boxW, boxH, 2);
  gfx.endFill();

  // Texto alineado a la derecha dentro de la caja
  priceText.x = bx + boxW - PAD_X - priceText.width;
  priceText.y = by + PAD_Y;
  texts.push(priceText);

  if (pctText) {
    pctText.x = bx + boxW - PAD_X - pctText.width;
    pctText.y = by + PAD_Y + lineH + GAP;
    texts.push(pctText);
  }
}

// ── Tooltip ────────────────────────────────────────────────────────

function drawTooltip(uiLayer, candle, cx, bw, totalWidth) {
  const isBull  = candle.close >= candle.open;
  const accent  = isBull ? COLOR_BULL : COLOR_BEAR;

  const lines = [
    { label: 'O', value: fmt(candle.open)   },
    { label: 'H', value: fmt(candle.high)   },
    { label: 'L', value: fmt(candle.low)    },
    { label: 'C', value: fmt(candle.close)  },
    { label: 'V', value: fmtVol(candle.volume) },
  ];

  const textStyle = {
    fontSize:   11,
    fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
    fill:       0xd1d5db,
    lineHeight: 17,
  };
  const labelStyle = { ...textStyle, fill: 0x6b7280 };

  const PAD_X    = 10;
  const PAD_Y    = 8;
  const LINE_H   = 17;
  const TOOLTIP_W = 128;
  const TOOLTIP_H = lines.length * LINE_H + PAD_Y * 2;
  const MARGIN   = 8;

  // Posición: preferir a la derecha, flipar si no cabe
  let tx = cx + bw / 2 + MARGIN;
  if (tx + TOOLTIP_W > totalWidth - PADDING_RIGHT) {
    tx = cx - bw / 2 - MARGIN - TOOLTIP_W;
  }
  const ty = PADDING_TOP + 8;

  // Fondo
  const bg = new PIXI.Graphics();
  bg.lineStyle(1, COLOR_TOOLTIP_BORd, 1);
  bg.beginFill(COLOR_TOOLTIP_BG, 0.95);
  bg.drawRoundedRect(tx, ty, TOOLTIP_W, TOOLTIP_H, 4);
  bg.endFill();

  // Barra de acento izquierda
  bg.lineStyle(0);
  bg.beginFill(accent, 1);
  bg.drawRect(tx, ty, 3, TOOLTIP_H);
  bg.endFill();

  uiLayer.addChild(bg);

  // Líneas de texto
  lines.forEach(({ label, value }, i) => {
    const y = ty + PAD_Y + i * LINE_H;

    const lbl = new PIXI.Text(`${label}`, labelStyle);
    lbl.x = tx + PAD_X;
    lbl.y = y;
    uiLayer.addChild(lbl);

    const val = new PIXI.Text(value, textStyle);
    val.x = tx + TOOLTIP_W - PAD_X - val.width;
    val.y = y;
    uiLayer.addChild(val);
  });
}

// ── Formato ────────────────────────────────────────────────────────

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 100)   return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function fmtVol(vol) {
  if (!vol) return '—';
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
  if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
  return vol.toFixed(2);
}

/**
 * Formatea un precio para la etiqueta del eje Y (mismo criterio que fmt).
 */
function fmtAxisPrice(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 100)   return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * Formatea un timestamp para la etiqueta dinámica del eje X.
 * Muestra más detalle que formatTime (que solo muestra hora O fecha, no ambas).
 *
 * Sub-diario (<24 h por vela): "DD/MM HH:MM"
 * Diario o semanal (≥24 h):   "DD/MM/YYYY"
 */
function formatTimeCursor(ts, intervalMs = 3600000) {
  if (!ts) return '';
  const d = new Date(ts);
  if (intervalMs >= 24 * 3600 * 1000) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  const date = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}
