/**
 * decisionGates.js — puertas de decisión sobre el output crudo del LLM.
 *
 * Separa dos niveles de enforcement que antes estaban mezclados en el controller
 * (donde el veto "duro" acababa dependiendo del flag de observación del fail-safe):
 *
 *  1) HARD GATES backend-autoritativos — el veto determinista (gating.veto_long/short)
 *     y el CONVICTION DECAY (>=3 contradicciones). Son conclusiones del backend a partir
 *     de los datos, NO "violaciones del LLM": su autoridad NO puede depender de un flag de
 *     observación. Fuerzan `Esperar` SIEMPRE, con independencia de `failsafeEnabled`.
 *
 *  2) Violaciones de reglas duras del prompt (buy/sell gate, dirección del setup, rangos…):
 *     degradan solo si `failsafeEnabled` (permite apagar el fail-safe para observar el output
 *     crudo del LLM sin que eso desactive también los hard gates).
 *
 * Función orquestadora pura: solo depende de analysisValidator (sin I/O, sin DB, sin red),
 * por lo que se puede testear el cableado veto→acción end-to-end en aislamiento.
 */

import { validateAnalysis, applyFailSafe } from './analysisValidator.js';

/**
 * @param {object} rawStructured - `structured` del LLM. Se le fija `gating_active=true` si
 *   hay veto (mutación deliberada: el header persiste ese flag como autoritativo).
 * @param {object|null} gating - `context.gating` (veto_long/short + veto_reason + contradiction_count + data_insufficient).
 * @param {boolean} failsafeEnabled - `env.analysisFailsafeEnabled`.
 * @param {boolean} [failClosedOnMissing=true] - `env.gatingFailClosedOnMissing` (H2).
 * @param {object|null} [derivativesScore=null] - `context.derivatives_score` (backend, v9_0).
 *   Autoritativo sobre `scores.derivatives`: el prompt ordena COPIARLO, pero las puertas
 *   validan contra la copia — sin esto, una copia infiel contaminaría la muestra en
 *   silencio (inflada abre la puerta sin respaldo determinista; desinflada bloquea un
 *   direccional legítimo y en BBDD parece decisión del modelo).
 * @param {{pct:number, min:number, d:number}|null} [targetReachability=null] - alcanzabilidad
 *   del TP1 del `conditional_setup` dentro de su vigencia, YA calculada por el caller (que es
 *   quien tiene el ATR% y el TF). Viaja calculada porque `analysisValidator` se declara sin
 *   dependencias y la curva medida tiene un único dueño en `utils/stats.js`.
 * @returns {{ structured: object, validation: object, degraded: boolean, hardGate: boolean }}
 */
export function applyDecisionGates(rawStructured, gating, failsafeEnabled, failClosedOnMissing = true, expectedScores = null, currentPrice = null, derivativesScore = null, targetReachability = null) {
  // Derivatives Score: el backend es autoritativo (misma filosofía que gating_active).
  // Se impone ANTES de validar para que buy/sell/prepare_gate y la 6ª contradicción operen
  // siempre sobre el número verdadero, copie bien o mal el modelo. La discrepancia queda en
  // telemetría como warning `minor`: la sobrescritura ya la corrige, no hay que degradar.
  const backendDeriv = derivativesScore?.score;
  let copyMismatch = null;
  if (Number.isFinite(backendDeriv)
      && rawStructured?.scores && typeof rawStructured.scores === 'object'
      && rawStructured.scores.derivatives !== backendDeriv) {
    copyMismatch = {
      rule: 'derivatives_copy_mismatch',
      severity: 'minor',
      message: `scores.derivatives=${rawStructured.scores.derivatives} no es la copia de `
        + `derivatives_score.score=${backendDeriv}; sobrescrito por el backend antes de las puertas`,
    };
    rawStructured.scores.derivatives = backendDeriv;
  }

  const vetoActive = !!(gating?.veto_long || gating?.veto_short);
  // H2 · Fail-closed: datos críticos ausentes bloquean trades DIRECCIONALES (Comprar/Vender)
  // y también un Preparar ACCIONABLE (con setup ejecutable: emite niveles operables
  // condicionales que no deben nacer a ciegas — auditoría #2, hallazgo 5). Un Preparar
  // contemplativo (sin setup) y Esperar no se bloquean.
  const action = rawStructured?.action;
  const directional = action === 'Comprar' || action === 'Vender';
  // `Preparar` retirado (P5, 2026-08-03): ya no hay una tercera acción accionable que
  // proteger. Un `Esperar` no puede llevar setup ejecutable por construcción.
  const preparesSetup = false;
  const dataInsufficientGate =
    !!failClosedOnMissing && !!gating?.data_insufficient && (directional || preparesSetup);

  if (vetoActive || dataInsufficientGate) {
    // Autoritativo: imponer gating_active=true ANTES de validar → el validador dispara
    // `gating_forces_wait` (severo) si el LLM no puso Esperar.
    rawStructured.gating_active = true;
    rawStructured.gating_reason = rawStructured.gating_reason
      ?? gating?.veto_reason
      ?? (dataInsufficientGate ? `datos críticos ausentes: ${(gating?.missing_inputs ?? []).join(', ')}` : null);
  }

  const validation = validateAnalysis(rawStructured, {
    backendContradictionCount: gating?.contradiction_count ?? 0,
    expectedScores,
    currentPrice,
    targetReachability,
  });
  if (copyMismatch) validation.warnings.push(copyMismatch);

  const vetoTriggered = vetoActive && rawStructured.action !== 'Esperar';
  const decayTriggered = validation.warnings.some((w) => w.rule === 'conviction_decay_forces_wait');
  const hardGate = vetoTriggered || dataInsufficientGate || decayTriggered;

  let structured = rawStructured;
  let degraded = false;
  // Un hard gate degrada SIEMPRE; las demás violaciones severas solo bajo el flag.
  if (hardGate || failsafeEnabled) {
    const failSafe = applyFailSafe(rawStructured, validation);
    structured = failSafe.structured;
    degraded = failSafe.applied;
  }

  return { structured, validation, degraded, hardGate };
}
