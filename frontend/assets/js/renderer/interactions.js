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

const COLOR_CROSSHAIR    = 0x6b7280;
const COLOR_TOOLTIP_BG   = 0x1e2230;
const COLOR_TOOLTIP_BORd = 0x374151;
const COLOR_BULL         = 0x22c55e;
const COLOR_BEAR         = 0xef4444;

// ── Exports ────────────────────────────────────────────────────────

/**
 * @param {PIXI.Application} app
 * @param {object}           layers        - { grid, candle, overlay, ui }
 * @param {function}         getViewport   - () => viewport actual
 * @param {function}         setViewport   - (vp) => void  (setState + redraw)
 * @param {function}         redraw        - () => void
 * @param {function}         getCandles    - () => candle[]
 */
export function initInteractions(app, layers, getViewport, setViewport, redraw, getCandles) {
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

    // getViewport() puede haber cambiado por setViewport de arriba
    drawCrosshair(layers.ui, getViewport(), candles, mousePos(e));
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
    const direction = e.deltaY > 0 ? 1 : -1;
    const delta     = Math.max(1, Math.round(vp.visibleBars * 0.1));
    const newVisible = Math.max(20, Math.min(candles.length, vp.visibleBars + direction * delta));
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

function drawCrosshair(uiLayer, vp, candles, pos) {
  uiLayer.removeChildren();
  if (!vp || !candles?.length) return;

  const { width, height } = getSize();
  const { x: mx, y: my } = pos;

  // Solo dentro del área de chart
  if (mx < PADDING_LEFT || mx > width - PADDING_RIGHT ||
      my < PADDING_TOP  || my > height - PADDING_BOTTOM) return;

  const chartW = width - PADDING_LEFT - PADDING_RIGHT;
  const bw     = chartW / vp.visibleBars;
  const relIdx = Math.floor((mx - PADDING_LEFT) / bw);
  const absIdx = vp.offsetX + relIdx;

  if (absIdx < 0 || absIdx >= candles.length) return;
  const candle = candles[absIdx];
  const cx     = PADDING_LEFT + relIdx * bw + bw / 2;

  // Líneas cruzadas
  const gfx = new PIXI.Graphics();
  gfx.lineStyle(1, COLOR_CROSSHAIR, 0.55);

  gfx.moveTo(cx, PADDING_TOP);
  gfx.lineTo(cx, height - PADDING_BOTTOM);

  gfx.moveTo(PADDING_LEFT, my);
  gfx.lineTo(width - PADDING_RIGHT, my);

  uiLayer.addChild(gfx);

  // Tooltip OHLCV
  drawTooltip(uiLayer, candle, cx, bw, width);
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
