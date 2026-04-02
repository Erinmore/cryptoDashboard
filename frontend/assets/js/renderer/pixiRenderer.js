/**
 * pixiRenderer.js — PixiJS v7 Application setup y resize
 *
 * Responsabilidades:
 *  - Crear y montar PIXI.Application
 *  - Gestionar resize del canvas (ResizeObserver)
 *  - Exponer `app` y `getSize()` al resto del sistema
 */

import * as PIXI from 'pixi.js';

let app = null;

/**
 * Inicializa la aplicación PixiJS y la monta en el contenedor.
 * @param {HTMLElement} container
 * @returns {PIXI.Application}
 */
export function initPixi(container) {
  const { width, height } = container.getBoundingClientRect();

  app = new PIXI.Application({
    width:           Math.max(width,  400),
    height:          Math.max(height, 300),
    backgroundColor: 0x0d0f14,      // --bg-app
    antialias:       true,
    resolution:      window.devicePixelRatio || 1,
    autoDensity:     true,
  });

  container.appendChild(app.view);

  // Resize dinámico con ResizeObserver
  const ro = new ResizeObserver(() => {
    const { width: w, height: h } = container.getBoundingClientRect();
    if (w > 0 && h > 0) {
      app.renderer.resize(w, h);
    }
  });
  ro.observe(container);

  return app;
}

/**
 * Devuelve las dimensiones actuales del renderer.
 * @returns {{ width: number, height: number }}
 */
export function getSize() {
  if (!app) return { width: 0, height: 0 };
  return { width: app.screen.width, height: app.screen.height };
}

/** Acceso directo a la instancia de la app (puede ser null antes de initPixi). */
export { app };
