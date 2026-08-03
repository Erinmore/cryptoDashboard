/**
 * disjointAnchors.mjs — cadena de anclajes con ventanas futuras DISJUNTAS + Wilson.
 *
 * POR QUÉ EXISTE ESTE MÓDULO. Los scripts de auditoría recorren la historia con anclajes
 * consecutivos (uno por vela de 4h) y miden qué pasa DESPUÉS de cada uno. Dos anclajes
 * separados 4h con horizonte de 24h comparten 5/6 de su futuro, así que no son observaciones
 * independientes y un IC calculado sobre los n crudos sale ~√6 veces demasiado estrecho.
 * Ese mismo fallo de denominador ya mató cuatro cifras publicadas de este proyecto (el
 * 24-42 % de `volatility_state`, el 0,225R de la expectativa, el 45,6 % de la tasa base por
 * cuartil y el "+10 pt del skew"). Tener UN solo dueño de "qué es una muestra independiente"
 * es lo que impide que la quinta se cuele por otra puerta.
 *
 * ⚠️ EL CRITERIO ES POR TIEMPO, NO POR POSICIÓN (corrección A8, 2026-08-03). Submuestrear
 * "1 de cada 6" por índice dentro de un subconjunto YA FILTRADO no compra independencia: si
 * el subconjunto es disperso (una celda del cuadro OI×precio, una cascada, un veto activo),
 * sus elementos ya distan mucho más de 24h entre sí y tirar 5 de cada 6 regala n a cambio de
 * nada. Se acepta un ancla si su ventana futura no toca la de la última aceptada, que es
 * exactamente la condición que hace falta y ni una más.
 *
 * SOLO LECTURA: no toca BBDD ni producción.
 */

import { wilsonInterval } from '../../src/utils/stats.js';

/**
 * Cadena de anclajes cuyas ventanas futuras no se tocan.
 *
 * @param {Array<{t:number}>} sorted - anclajes ORDENADOS por `t` (segundos epoch)
 * @param {number} startIdx - por dónde empezar; el arranque es arbitrario y cambia el
 *   resultado, de ahí que `disjointRate` los recorra todos
 * @param {number} horizonSec - duración de la ventana futura que se mide
 * @returns {Array} subconjunto con separación >= horizonSec entre elementos consecutivos
 */
export function disjointChain(sorted, startIdx, horizonSec) {
  const out = [];
  let lastT = -Infinity;
  for (let i = startIdx; i < sorted.length; i++) {
    if (sorted[i].t - lastT >= horizonSec) { out.push(sorted[i]); lastT = sorted[i].t; }
  }
  // Guarda viva: si esto se rompiera, TODOS los IC seguirían imprimiéndose con buen aspecto
  // y serían demasiado estrechos, sin ninguna señal externa. Coste ~0.
  for (let i = 1; i < out.length; i++) {
    if (out[i].t - out[i - 1].t < horizonSec) {
      console.log('   ⚠️ BUG: la cadena "disjunta" contiene ventanas solapadas — IC no válidos.');
      break;
    }
  }
  return out;
}

/**
 * Proporción con IC de Wilson sobre anclajes independientes.
 *
 * Como el punto de partida de la cadena es arbitrario y mueve el resultado, se recorren
 * `stride` arranques: se reporta el de mayor n_ef y el RANGO de los puntos. Si el intervalo
 * y el rango de arranques no se parecen, el número no es estable y hay que decirlo.
 *
 * @param {Array<{t:number}>} sel - población a medir
 * @param {(r:any)=>boolean} hit - qué cuenta como éxito
 * @param {{horizonSec:number, stride:number}} opts
 * @returns {{n_eff:number, point:number, low:number, high:number, spread:[number,number]}|null}
 */
export function disjointRate(sel, hit, { horizonSec, stride }) {
  const sorted = [...sel].sort((a, b) => a.t - b.t);
  const rates = [];
  let bestW = null;
  for (let off = 0; off < stride; off++) {
    const sub = disjointChain(sorted, off, horizonSec);
    if (sub.length < 2) continue;
    // `wilsonInterval` ya devuelve PORCENTAJES (0-100), no proporciones.
    const w = wilsonInterval(sub.filter(hit).length, sub.length);
    rates.push(w.point);
    if (!bestW || sub.length > bestW.n) bestW = { ...w, n: sub.length };
  }
  if (!bestW) return null;
  return {
    n_eff: bestW.n,
    point: bestW.point,
    low: bestW.low,
    high: bestW.high,
    spread: rates.length ? [Math.min(...rates), Math.max(...rates)] : null,
  };
}

/**
 * Veredicto de una comparación subconjunto ↔ SU COMPLEMENTO.
 *
 * Por qué el complemento y no la base: la base CONTIENE al subconjunto, así que sus dos
 * intervalos comparten observaciones y no son comparables por solape.
 *
 * Dos conservadurismos declarados, ambos en la dirección segura:
 *   · el no-solape de dos IC es MÁS ESTRICTO que un contraste de diferencia de proporciones,
 *     así que "solapa" NO significa "no hay efecto", significa NO DEMOSTRADO;
 *   · cada población se adelgaza por separado, luego un ancla del subconjunto y otra del
 *     complemento pueden distar 4h y compartir futuro. Esa correlación es POSITIVA, o sea
 *     que la varianza real de la diferencia es MENOR que la que implica tratarlas como
 *     independientes → el criterio peca de exigente, nunca de laxo.
 */
export function verdictCI(a, b) {
  if (!a || !b) return { separated: null, side: null };
  if (a.low > b.high) return { separated: true, side: 'above' };
  if (a.high < b.low) return { separated: true, side: 'below' };
  return { separated: false, side: null };
}
