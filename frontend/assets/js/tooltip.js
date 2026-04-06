/**
 * tooltip.js — Sistema de tooltips flotantes para CRYPTEX
 *
 * Uso: añadir `data-tooltip="texto\n\npárrafo"` a cualquier elemento.
 * El contenido soporta:
 *   \n  → salto de línea (<br>)
 *   \n\n → párrafo (espacio visual entre bloques)
 *
 * Se inicializa automáticamente en DOMContentLoaded.
 */

const OFFSET_X = 14;   // px a la derecha del cursor
const OFFSET_Y = 10;   // px por debajo del cursor

let bubble = null;

function createBubble() {
  const el = document.createElement('div');
  el.className = 'tooltip-bubble';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  return el;
}

function showTooltip(e) {
  const raw = this.getAttribute('data-tooltip');
  if (!raw) return;

  if (!bubble) bubble = createBubble();

  // Convertir \n\n en separador de párrafo y \n en salto de línea
  const html = raw
    .split('\\n\\n')
    .map(para => `<p>${para.replace(/\\n/g, '<br>')}</p>`)
    .join('');

  bubble.innerHTML = html;
  bubble.classList.add('visible');
  positionBubble(e);
}

function hideTooltip() {
  if (bubble) bubble.classList.remove('visible');
}

function positionBubble(e) {
  if (!bubble) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;

  let x = e.clientX + OFFSET_X;
  let y = e.clientY + OFFSET_Y;

  // Evitar que se salga por la derecha
  if (x + bw > vw - 8) x = e.clientX - bw - OFFSET_X;
  // Evitar que se salga por abajo
  if (y + bh > vh - 8) y = e.clientY - bh - OFFSET_Y;

  bubble.style.left = `${x}px`;
  bubble.style.top  = `${y}px`;
}

export function initTooltips() {
  document.addEventListener('mouseover', function (e) {
    const target = e.target.closest('[data-tooltip]');
    if (target) {
      target.addEventListener('mousemove', positionBubble);
      showTooltip.call(target, e);
    }
  });

  document.addEventListener('mouseout', function (e) {
    const target = e.target.closest('[data-tooltip]');
    if (target) {
      target.removeEventListener('mousemove', positionBubble);
      hideTooltip();
    }
  });
}
