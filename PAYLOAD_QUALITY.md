# Payload JSON Quality Standards

Documento que define los estándares de calidad aplicados al payload que se descarga desde `/api/analyze/payload` para ser enviado al LLM.

---

## 1. SuperTrend: Política de valores null

**Comportamiento:** `support` es `null` cuando `trend === 'DOWN'` y `resistance` es `null` cuando `trend === 'UP'`.

**Razón:** SuperTrend solo tiene un nivel activo a la vez (soporte en tendencia alcista, resistencia en tendencia bajista). Incluir el nivel inactivo sería semánticamente incorrecto.

**Impacto en LLM:** El modelo puede interpretar `null` correctamente como "no aplica en esta dirección" y no considera el campo ausente como error.

**Status:** ✅ Comportamiento correcto, no requiere cambios.

---

## 2. Redondeo de porcentajes: 2 decimales

**Campos afectados:**
- `price_change_24h_pct` — cambio de precio en 24h
- `global_market.market_cap_change_24h_pct` — cambio de cap de mercado
- `coin_market.ath_change_pct` — cambio desde máximo histórico
- `coin_market.atl_change_pct` — cambio desde mínimo histórico

**Antes:** `3.6715685674729137` (demasiados decimales)  
**Después:** `3.67` (2 decimales)

**Aplicación:** En `backend/src/controllers/analysisController.js` línea ~294-314, función `buildAnalyzeContext`.

**Patrón usado:**
```javascript
value != null ? parseFloat(value.toFixed(2)) : null
```

**Status:** ✅ Implementado (commit 2026-04-06).

---

## 3. Volume History: `change_pct_7d` null cuando base es 0

**Campos afectados:**
- `volume_history.cvd.change_pct_7d`
- `volume_history.obv.change_pct_7d`

**Comportamiento:** Devuelve `null` cuando `prev7d.value === 0` (división por cero imposible).

**Razón:** Cambio de porcentaje desde un valor base de 0 no tiene sentido matemático.

**Impacto en LLM:** El modelo interpreta `null` como "dato no disponible" y evita cálculos basados en este campo.

**Status:** ✅ Comportamiento correcto, no requiere cambios.

---

## 4. Normalización de timeframes: '1h', '4h' vs '1H', '4H'

**Estado actual:** `['1h', '4h', '1D', '1W']` — mezcla de mayúsculas/minúsculas.

**Propuesta rechazada:** Uniformizar a `['1H', '4H', '1D', '1W']`.

**Razones para rechazar:**
1. **Alto impacto en frontend:** Cambiaría selector de TF en UI
2. **localStorage roto:** Claves actuales usan TF en el key (`cryptex_state_BTC`). Sin migración, perdería persistencia
3. **Bajo beneficio:** El LLM entiende `'1h'` igual que `'1H'`
4. **Riesgo de regresión:** Afectaría validación en todos los controllers

**Status:** ⏭️ Descartado por ahora. Si en el futuro se justifica (p.ej., nuevo estándar corporativo), requeriría:
- Migración de localStorage
- Actualización de frontend y backend en paralelo
- Tests de regresión exhaustivos

---

## Verificación del payload

Para inspeccionar el payload actual:

```bash
curl -s "http://localhost:3000/api/analyze/payload?coin=BTC&primary_tf=4h" | jq '.'
```

Verificar que los porcentajes tienen máximo 2 decimales:

```bash
curl -s "http://localhost:3000/api/analyze/payload?coin=BTC&primary_tf=4h" | jq '{
  price_change: .payload.price_change_24h_pct,
  market_cap_change: .payload.global_market.market_cap_change_24h_pct,
  ath_change: .payload.coin_market.ath_change_pct,
  atl_change: .payload.coin_market.atl_change_pct
}'
```

---

## Cambios históricos

| Fecha | Cambio | Commit |
|-------|--------|--------|
| 2026-04-06 | Redondeo de porcentajes a 2 decimales | [Próximo] |
| 2026-04-06 | Documentación de políticas de calidad | PAYLOAD_QUALITY.md |
