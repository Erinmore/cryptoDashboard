# Scripts obsoletos — archivados tras el pivot a ayudante de riesgo

Los 19 scripts de esta carpeta quedaron rotos el 2026-08-1X, cuando CRYPTEX pivotó de un
sistema que intentaba emitir un dictamen direccional (Comprar/Vender/Esperar, con gating
determinista, scoring del LLM, setup condicional y shadow trades) a un ayudante de lectura +
geometría de riesgo simétrica. Ver CLAUDE.md §REORIENTACIÓN y §"Punto Cero 6" para el motivo:
tras ~20 hipótesis direccionales medidas con rigor (anclajes disjuntos, IC de Wilson, réplica
en 3 monedas), no hay ventaja direccional medible con estos datos y este método.

Todos importan literalmente uno o más de los módulos que ese pivot borró:
`src/utils/gating.js`, `src/utils/shadowTrade.js`, `src/utils/expectedScores.js`. Ninguno de
esos módulos existe ya, así que **cualquiera de estos scripts crashea con
`ERR_MODULE_NOT_FOUND` si se ejecuta tal cual** — no se han reescrito para seguir corriendo,
porque lo que medían (frecuencia del veto, línea base del shadow trade, guardia de divergencia
de scores, geometría del `conditional_setup`...) ya no existe en el sistema.

**No se pierde conocimiento**: las conclusiones de cada script ya están fijadas por escrito en
CLAUDE.md (sección "Estado ACTUAL" y el historial de lotes), que es la fuente de verdad sobre
qué se midió y qué se concluyó. Estos ficheros se conservan como registro histórico de CÓMO se
midió, no como herramientas operativas.

Los scripts de mantenimiento activo (`dbStats.mjs`, `dbClear.mjs`, `backfillHistorySeries.mjs`,
`backfillLiquidationsHourly.mjs`, `backfillSampleReason.mjs`, `backfillLiquidationClusters.mjs`
y el resto de `audit*.mjs` que NO están aquí) siguen en `backend/scripts/` y no están afectados
por este pivot.

## Inventario

| Script | Qué medía (ya obsoleto) |
|---|---|
| `auditBarrierTies.mjs` | Empates de barrera en el evaluador de setup/shadow trade |
| `auditThresholds.mjs` | Calibración de umbrales del gating (T1-T6) |
| `auditConfirmedRejectionVsProximity.mjs` | Rechazo de nivel S/R vs proximidad, para la pata de gating |
| `auditOrderlyDecline.mjs` | Continuación bajista condicionada, contra la guardia de scores esperados |
| `auditFillRule.mjs` | Regla de llenado del setup/shadow trade |
| `backfillContradictionBlocks.mjs` | Backfill de `analyses.contradiction_blocks` (columna retirada de la ruta de escritura) |
| `auditLevelRejectionVsBreakout.mjs` | Rechazo vs ruptura de nivel, para la pata de gating |
| `auditAtrRounding.mjs` | Redondeo de ATR contra los topes de `dynamicNearLevelPct` (gating) |
| `auditExpectancyCurve.mjs` | Curva de expectativa del shadow trade |
| `auditEntryGeometry.mjs` | Geometría de entrada del setup/shadow trade |
| `auditGateConjunction.mjs` | Conjunción de puertas de gating + guardia de scores esperados |
| `auditBaseRateConditioning.mjs` | Condicionamiento de tasas base del shadow trade |
| `auditDirectionalBias.mjs` | Bias direccional determinista (Fase 0 de la reorientación) |
| `auditVolumeGuardSymmetry.mjs` | Simetría de la guardia de volumen esperado (C2) |
| `auditBearishContinuationPower.mjs` | Poder predictivo bajista, contra la guardia de scores esperados |
| `auditDerivativesScore.mjs` | Calibración original del Derivatives Score que motivó v9_0 |
| `auditShadowBaseline.mjs` | Línea base de expectativa del shadow trade |
| `auditConditionalRR.mjs` | Umbral de R:R del `conditional_setup` |
| `auditVetoFrequency.mjs` | Frecuencia del veto de gating |
