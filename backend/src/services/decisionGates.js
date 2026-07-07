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
 * @returns {{ structured: object, validation: object, degraded: boolean, hardGate: boolean }}
 */
export function applyDecisionGates(rawStructured, gating, failsafeEnabled, failClosedOnMissing = true) {
  const vetoActive = !!(gating?.veto_long || gating?.veto_short);
  // H2 · Fail-closed: datos críticos ausentes bloquean trades DIRECCIONALES (Comprar/Vender).
  // No bloquea Preparar/Esperar (no abren posición inmediata). Es un hard gate del backend.
  const directional = rawStructured?.action === 'Comprar' || rawStructured?.action === 'Vender';
  const dataInsufficientGate =
    !!failClosedOnMissing && !!gating?.data_insufficient && directional;

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
  });

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
