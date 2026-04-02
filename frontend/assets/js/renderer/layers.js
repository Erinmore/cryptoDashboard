/**
 * layers.js — Jerarquía de contenedores PixiJS
 *
 * Orden de renderizado (Z-order, de fondo a frente):
 *   gridLayer       — grid de precio y tiempo
 *   candleLayer     — cuerpos y mechas de velas
 *   overlayLayer    — SuperTrend, Fibonacci, S/R
 *   uiLayer         — crosshair, tooltip
 */

import * as PIXI from 'pixi.js';

export const layers = {
  grid:    null,
  candle:  null,
  overlay: null,
  ui:      null,
};

/**
 * Crea los contenedores de capas y los añade a la stage.
 * @param {PIXI.Application} app
 */
export function initLayers(app) {
  layers.grid    = new PIXI.Container();
  layers.candle  = new PIXI.Container();
  layers.overlay = new PIXI.Container();
  layers.ui      = new PIXI.Container();

  app.stage.addChild(layers.grid);
  app.stage.addChild(layers.candle);
  app.stage.addChild(layers.overlay);
  app.stage.addChild(layers.ui);
}

/**
 * Limpia el contenido de todas las capas (sin eliminar los contenedores).
 */
export function clearLayers() {
  for (const layer of Object.values(layers)) {
    layer?.removeChildren();
  }
}
