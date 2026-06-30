# Cryptex — Briefing de Deficiencias: Dataset + Prompt

**Activo:** BTC · **TF primario:** 4H · **Fecha del dataset:** 2026-04-27  
**Destinatario:** Modelo LLM encargado de corregir dataset y prompt  
**Fuentes:** Auditoría automatizada (Claude Opus) + análisis post-ejecución del modelo analítico + revisión externa (tercera IA) con evaluación crítica de severidad

---

## Propósito de este documento

Este briefing consolida **todas las deficiencias identificadas** en el dataset JSON y en el prompt del sistema analítico Cryptex. Cada punto incluye: descripción exacta del problema, evidencia directa del dataset actual, impacto en el análisis, y solución propuesta. El objetivo es que un modelo LLM pueda aplicar las correcciones de forma autónoma y sin ambigüedad.

Las deficiencias están organizadas por severidad y capa (Dataset / Prompt / Ambos).

---

## Resumen ejecutivo

| ID | Severidad | Capa | Título |
|----|-----------|------|--------|
| D1 | 🔴 CRÍTICA | Dataset | Severity "normal" para funding -0.8659% — etiqueta activamente incorrecta |
| D2 | 🔴 CRÍTICA | Dataset | CVD 1D: divergence="none" inconsistente con los datos reales |
| D3 | 🔴 CRÍTICA | Dataset | Volume Profile 1D y 4H fuera del rango activo de precio |
| D4 | 🔴 CRÍTICA | Dataset | CVD 4H sin contexto histórico — valor puntual ininterpretable |
| D5 | 🔴 CRÍTICA | Dataset | Liquidation clusters: unidades de escala rotas |
| P1 | 🔴 CRÍTICA | Prompt | Sin regla para funding negativo extremo como señal de squeeze alcista |
| P2 | 🔴 CRÍTICA | Prompt | Sin regla de BOS no confirmado post-retroceso |
| D6 | 🟡 IMPORTANTE | Dataset | Fibonacci sin anclas de swing declaradas |
| D7 | 🟡 IMPORTANTE | Dataset | Long/Short Ratio sin campo de fuente (exchange) |
| D8 | 🟡 IMPORTANTE | Dataset | ETF flows con 3 días de retraso sin campo de freshness |
| D9 | 🟡 IMPORTANTE | Dataset | Exchange netflow ausente (null) |
| D10 | 🟡 IMPORTANTE | Ambos | CHoCH alcista → BOS bajista posterior: secuencia trampa sin regla |
| P3 | 🟡 IMPORTANTE | Prompt | Sin fallback cuando todos los VPs del TF primario están fuera de rango |
| P4 | 🟡 IMPORTANTE | Prompt | VWAP presente en dataset sin ninguna regla de interpretación en el prompt |
| P5 | 🟡 IMPORTANTE | Prompt | Sin estado "PREPARAR" — gap entre ESPERAR y COMPRAR |
| P6 | 🟡 IMPORTANTE | Prompt | ETF Flows × Funding sin regla de interacción multiplicativa |
| D11 | 🟢 MENOR | Dataset | Liquidation history 7d idéntico al 24h — cálculo roto |
| D12 | 🟢 MENOR | Dataset | volume_history.cvd: change_pct = 0 y period_min = period_max |
| P7 | 🟢 MENOR | Prompt | Nomenclatura de TFs inconsistente entre prompt (mayúsculas) y dataset (mixto) |
| D13 | 🟡 IMPORTANTE | Dataset | Campo `trend` mezcla tendencia estructural y momentum sin distinción |
| D14 | 🟢 MENOR | Dataset | Bollinger Bands sin campo `bollinger_window` — período de cálculo no declarado |
| D15 | 🟢 MENOR | Dataset | Falta campo `macro_regime` sintetizado (risk_on / risk_off / mixed) |
| D16 | 🟢 MENOR | Dataset | Falta ratio vol ETH/BTC como señal de rotación (útil principalmente en ETH/SOL) |
| D17 | 🟢 MENOR | Dataset | Falta variación temporal de BTC dominance para inferir market breadth |
| D18 | 🟢 MENOR | Dataset | Falta campo `data_quality` por sección del dataset |
| D19 | 🟢 MENOR | Dataset | Falta `timestamp` específico por TF — todos los datos usan timestamp global |
| D20 | 🟢 MENOR | Dataset | Falta `price_change` por TF (1H, 4H, 7D) — solo existe variación 24H global |
| D21 | 🟡 IMPORTANTE | Dataset | Falta `last_bos_valid` en SMC — extensión al dataset de la regla P2 |
| D22 | 🟡 IMPORTANTE | Dataset | Falta `exchange_used_for_price` — fuente del precio de referencia no declarad
| D23 | 🟢 MENOR | Dataset | Falta lista `indicators_diverging` por TF — descriptivo, sin score numérico |

---

## Deficiencias Críticas 🔴

---

### D1 — Severity "normal" para funding -0.8659%

**Capa:** Dataset  
**Evidencia directa:**
```json
"funding_rate": {
  "rate_pct": -0.8659,
  "annualized_pct": -948.16,
  "severity": "normal",
  "signal": "shorts_overloaded"
}
```

**Problema:** El funding es -0.8659% por período de 8h (≈ -948% anualizado). La tabla de severity del prompt cubre únicamente el lado positivo (longs pagando). Para funding negativo no existe clasificación, por lo que el sistema asigna "normal" por defecto. Resultado: el modelo no activa ninguna alerta de riesgo y pierde la señal de presión de squeeze más potente del dataset. El campo `signal: "shorts_overloaded"` intenta compensarlo, pero el `severity` domina en el scoring engine del prompt y anula la señal.

**Impacto en el análisis:** El Derivatives Score no refleja correctamente la presión de short squeeze. Una de las señales más potentes del dataset queda neutralizada por una etiqueta incorrecta.

**Solución — Dataset:**
```json
"severity": "normal",
"severity_negative": "extreme_short_overload"
```
Añadir escala simétrica de severity para funding negativo:
- `> -0.05%`: `elevated_short_overload`
- `> -0.2%`: `high_short_overload`
- `> -0.5%`: `extreme_short_overload`

**Solución — Prompt:** Ver P1.

---

### D2 — CVD 1D: divergence="none" inconsistente con los datos

**Capa:** Dataset  
**Evidencia directa:**
```json
"1D": {
  "cvd": {
    "value": -45591.63,
    "trend": "falling",
    "divergence": "none"
  }
}
```
Precio actual: $77,752. Precio hace ~20 días: ~$74,000. El precio subió +5% mientras el CVD 1D es profundamente negativo y en tendencia bajista. Eso es, por definición, una divergencia bajista.

**Problema:** El campo `divergence` parece calcularse sobre una ventana temporal muy corta o con un método heurístico que no captura la divergencia estructural. El modelo recibe `divergence: "none"` y no activa el flag de advertencia que el prompt exige cuando el CVD 1D diverge del precio.

**Impacto en el análisis:** El VETO LONG del prompt requiere como primera condición `CVD 1D con divergence="bearish"`. Con `divergence: "none"`, el veto nunca se activa aunque la condición semántica esté presente. El modelo tuvo que resolver este conflicto manualmente en lugar de seguir el flujo del sistema.

**Solución — Dataset:**
```json
"cvd": {
  "value": -45591.63,
  "trend": "falling",
  "divergence": "bearish",
  "divergence_window_candles": 20,
  "price_change_pct_window": 4.2,
  "cvd_change_pct_window": -12.3
}
```
El cálculo de divergencia debe comparar CVD y precio sobre una ventana explícita de N velas, no una heurística de corto plazo.

---

### D3 — Volume Profile 1D y 4H fuera del rango activo de precio

**Capa:** Dataset  
**Evidencia directa:**
```json
"4h": { "volume_profile": { "poc": 66883.14, "vah": 75284.82, "val": 66014 } },
"1D": { "volume_profile": { "poc": 68262, "vah": 73770, "val": 65814 } }
```
Precio actual: $77,752.

**Problema:** El VP 4H tiene su POC a $66,883 — un 14.1% por debajo del precio actual. El VP 1D tiene su POC a $68,262 — un 12.2% por debajo. Ambos fueron calculados sobre el rango histórico completo del TF, que incluye el mínimo del ciclo (~$65K). No representan el rango de precio activo. El único VP tácticamente útil del dataset es el 1H (POC: $77,715, dentro del value area actual).

**Impacto en el análisis:** El prompt tiene la regla "si el POC está más del 5% alejado del precio, ignorar como referencia táctica" — lo que descarta el VP primario (4H) completo. Pero no especifica qué usar como sustituto (ver P3). El modelo tuvo que decidir autónomamente escalar al VP 1H.

**Solución — Dataset:** Añadir flag de validez y metadata de periodo:
```json
"volume_profile": {
  "poc": 66883.14,
  "valid": false,
  "invalid_reason": "poc_distance_pct_exceeds_threshold",
  "poc_distance_pct": 14.1,
  "period_start": "2026-01-15",
  "period_end": "2026-04-27",
  "candles_covered": 178
}
```
O calcular el VP sobre una ventana fija de N velas recientes (ej. últimas 60-90 velas del TF).

---

### D4 — CVD 4H sin contexto histórico

**Capa:** Dataset  
**Evidencia directa:**
```json
"4h": {
  "cvd": {
    "value": 3694.35,
    "trend": "falling",
    "divergence": "none",
    "source": "taker_real"
  }
}
```

**Problema:** El valor absoluto 3694.35 BTC es ininterpretable sin referencia histórica. No se puede saber si es un CVD alto o bajo, si viene de un pico reciente o si lleva semanas en caída. Comparado con el CVD 1D acumulado (-45,591 BTC), el 4H parece positivo, pero sin su propio rango histórico no es posible determinar si representa absorción real o residuo puntual de un movimiento.

**Impacto en el análisis:** El modelo no puede aplicar correctamente la regla de detección de absorción vs. distribución para el TF primario. La señal táctica más importante del sistema queda degradada a "tendencia bajista" sin cuantificación de la magnitud.

**Solución — Dataset:**
```json
"cvd": {
  "value": 3694.35,
  "trend": "falling",
  "divergence": "none",
  "change_pct_24h": -8.1,
  "change_pct_5d": -23.4,
  "high_7d": 5200.0,
  "low_7d": 3100.0,
  "source": "taker_real"
}
```

---

### D5 — Liquidation clusters: unidades de escala rotas

**Capa:** Dataset  
**Evidencia directa:**
```json
"long_clusters": [
  { "price": 77524.36, "total_usd": 182.74, "count": 15 },
  { "price": 75706.57, "total_usd": 93.95, "count": 4 }
]
```

**Problema:** Con BTC a $77K y Open Interest en ~$97B, un clúster de liquidación de $182.74 USD con 15 posiciones es matemáticamente imposible como dato real. Los valores están casi con certeza expresados en miles o millones de USD sin etiqueta de escala, o en BTC sin conversión. La fuente es `coinalyze_inferred` (proxy basado en liquidaciones históricas, no datos en tiempo real de CoinGlass), lo que añade incertidumbre adicional.

**Impacto en el análisis:** El `nearest_long_cluster_pct: -0.16%` indica una zona magnética crítica a 0.16% del precio actual. Si el volumen implicado es irrelevante (como sugiere el valor literal), esta zona no tiene fuerza de mercado real. Si son millones, es una de las señales más importantes del dataset. La ambigüedad hace inutilizable la cuantificación del squeeze.

**Solución — Dataset:**
```json
"long_clusters": [
  {
    "price": 77524.36,
    "total_usd": 182740000,
    "total_usd_display": "182.74M",
    "unit": "usd",
    "count": 15
  }
]
```
Alternativamente, usar una fuente con datos verificables (CoinGlass API) y añadir campo `source_reliability: "estimated" | "real_time"`.

---

### P1 — Sin regla para funding negativo extremo como señal de squeeze alcista

**Capa:** Prompt  
**Problema:** El prompt define FUNDING SEVERITY RULE exclusivamente para funding positivo (longs pagando → riesgo de liquidation cascade). No existe la regla simétrica: funding negativo extremo = shorts sobreextendidos = squeeze alcista potencial. En el dataset actual, funding de -0.8659% con OI creciendo (+1.23%) y precio lateral es una configuración clásica de short squeeze en construcción. El modelo puede inferirlo, pero no tiene instrucción explícita sobre cómo pesarlo ni qué threshold activa la alerta.

**Impacto en el análisis:** El Derivatives Score no tiene base formal para subir por esta condición. El modelo argumenta el squeeze manualmente fuera del scoring engine, lo que reduce reproducibilidad y consistencia entre análisis.

**Solución — Prompt:** Añadir sección simétrica tras FUNDING SEVERITY RULE:

```
FUNDING NEGATIVO — SEVERITY RULE (señal de short squeeze)

severity_negative="elevated_short_overload" (< -0.05%): mercado cargado de shorts. 
  Usar como filtro de contexto.
  
severity_negative="high_short_overload" (< -0.2%): coste de carry agresivo para shorts. 
  Señal de squeeze potencial si existe trigger. Añadir +1 al Derivatives Score.
  
severity_negative="extreme_short_overload" (< -0.5%): squeeze de shorts estadísticamente 
  probable si existe trigger de ruptura. Añadir +2 al Derivatives Score. Reducir 
  convicción SHORT a mínimo.

REGLA: Si funding negativo extremo persiste sin expansión de OI ni trigger de ruptura, 
mantener el score pero no ejecutar — el squeeze puede tardar o no materializarse.
```

---

### P2 — Sin regla de BOS no confirmado post-retroceso

**Capa:** Prompt  
**Evidencia directa del dataset:**
```json
"1D": {
  "smc": {
    "last_bos": {
      "direction": "bullish",
      "broken_swing_price": 78333,
      "close": 78657.55,
      "candles_ago": 1
    }
  }
}
```
Precio actual: $77,752 — por debajo del nivel roto ($78,333).

**Problema:** El precio rompió el BOS 1D bullish en $78,333 con cierre en $78,657, pero el precio actual ($77,752) ha retrocedido por debajo del nivel roto. El prompt no define qué hacer en este caso: ¿es un retest válido? ¿un failed BOS? ¿la señal sigue activa? El tratamiento analítico de cada escenario es radicalmente diferente.

**Impacto en el análisis:** El modelo debe decidir autónomamente si el BOS sigue siendo señal táctica activa. Sin regla explícita, diferentes instancias del modelo pueden resolver este caso de forma inconsistente.

**Solución — Prompt:** Añadir regla tras la sección de SMC:

```
BOS POST-RETROCESO — REGLA DE CONFIRMACIÓN

Si el precio post-BOS retrocede por debajo del nivel roto antes de que cierre 
la siguiente vela del mismo TF:
→ Degradar BOS a status "unconfirmed"
→ Reducir Structure Score en 1
→ Exigir segundo cierre por encima del nivel roto antes de usar como señal táctica

Si el retroceso supera el 50% del impulso original del BOS:
→ Degradar BOS a "failed"
→ No usar como señal estructural
→ Tratar como potencial trampa de liquidez
```

---

## Deficiencias Importantes 🟡

---

### D6 — Fibonacci sin anclas de swing declaradas

**Capa:** Dataset  
**Problema:** Los Fibonacci de cada TF tienen niveles calculados pero no declaran cuáles son los swings usados como ancla. El Fib 4H tiene `level_0: 79485.66` y `level_1: 65000`; el Fib 1D tiene `level_0: 90600` y `level_1: 60000`. Sin saber si son swings del mismo período, es imposible verificar si el nivel 0.382 del 4H ($77,658) y el 0.382 del 1D ($78,910) son confluencias reales o niveles independientes sin relación estructural.

**Solución — Dataset:**
```json
"fibonacci": {
  "swing_high": 79485.66,
  "swing_low": 65000,
  "swing_high_date": "2026-04-21",
  "swing_low_date": "2026-04-07",
  "type": "retracement",
  "levels": [...]
}
```

---

### D7 — Long/Short Ratio sin campo de fuente (exchange)

**Capa:** Dataset  
**Problema:** `long_pct: 45.7`, `short_pct: 54.3` sin campo `source`. El L/S ratio varía entre 10-15 puntos porcentuales entre Binance, OKX y Bybit. Todos los demás campos del dataset tienen fuente declarada. Este no.

**Solución — Dataset:**
```json
"long_short_ratio": {
  "long_pct": 45.7,
  "short_pct": 54.3,
  "source": "binance",
  "signal": "balanced"
}
```

---

### D8 — ETF flows con 3 días de retraso sin campo de freshness

**Capa:** Dataset  
**Evidencia directa:**
```json
"etf_flows": {
  "as_of": "2026-04-24",
  "daily_net_inflow_usd_yesterday": 14448891.92
}
```
Dataset generado: 2026-04-27.

**Problema:** Los datos de ETF tienen 3 días de retraso estructural (limitación de SoSoValue). El campo `daily_net_inflow_usd_yesterday` referencia el 23 de abril, no el 26. El prompt usa estos datos como señal de "demanda institucional real" sin tener en cuenta el lag. Para un análisis 4H, 3 días de retraso en flujos institucionales puede llevar a conclusiones erróneas sobre el momentum actual.

**Solución — Dataset:**
```json
"etf_flows": {
  "as_of": "2026-04-24",
  "data_lag_days": 3,
  "data_freshness": "stale",
  "freshness_warning": "ETF flow data is 3 days old. Use for structural context only, not short-term signal."
}
```

---

### D9 — Exchange netflow ausente (null)

**Capa:** Dataset  
**Evidencia directa:**
```json
"onchain": {
  "exchange_netflow_24h_btc": null
}
```

**Problema:** El exchange netflow es uno de los indicadores on-chain más útiles para distinguir acumulación real de distribución. Con flujos ETF de +$1.5B semanal disponibles en el dataset, cruzar esa cifra con el netflow de exchanges permitiría determinar si el BTC comprado por ETFs está saliendo de exchanges (acumulación real) o si hay reposición activa (distribución encubierta). Con `null`, este cruce es imposible.

**Solución — Dataset:** Hacer este campo obligatorio. Si la fuente no tiene el dato, declarar la fuente alternativa o el motivo de ausencia:
```json
"exchange_netflow_24h_btc": -1240.5,
"exchange_netflow_source": "glassnode"
```
Si no disponible:
```json
"exchange_netflow_24h_btc": null,
"exchange_netflow_unavailable_reason": "api_limit"
```

---

### D10 — CHoCH alcista → BOS bajista posterior: secuencia trampa sin regla

**Capa:** Ambos  
**Evidencia directa:**
```json
"1h": {
  "smc": {
    "last_bos": { "direction": "bearish", "candles_ago": 5 },
    "last_choch": { "direction": "bullish", "candles_ago": 11 }
  }
}
```

**Problema:** Hubo un CHoCH alcista (candles_ago: 11) seguido de un BOS bajista posterior (candles_ago: 5). Esta secuencia específica — ruptura de estructura alcista seguida de re-ruptura bajista — es una señal de trampa estructural. El prompt tiene la regla "priorizar CHoCH si contradice BOS y ambos dentro del umbral", pero aquí el BOS (5 velas) es **más reciente** que el CHoCH (11 velas), y ambos apuntan en direcciones opuestas. La regla del prompt cubre el caso inverso (CHoCH más reciente que BOS), no este.

**Impacto en el análisis:** El modelo puede interpretar erróneamente la secuencia, priorizando el CHoCH alcista cuando la señal estructural neta es bajista (el mercado intentó girar al alza y falló).

**Solución — Prompt:** Añadir regla específica para esta secuencia:

```
SECUENCIA CHoCH → BOS OPUESTO (trampa estructural):

Si last_choch.direction ≠ last_bos.direction Y last_bos.candles_ago < last_choch.candles_ago 
(BOS más reciente que CHoCH):
→ El CHoCH previo queda invalidado por el BOS posterior
→ Priorizar la dirección del BOS como señal estructural dominante
→ Marcar como "failed reversal" — señal de trampa de liquidez
→ Reducir Structure Score en 1 adicional
```

---

### P3 — Sin fallback cuando todos los VPs del TF primario están fuera de rango

**Capa:** Prompt  
**Problema:** El prompt define la regla de descarte ("ignorar VP si POC > 5% del precio"), pero no especifica qué referencia usar como sustituto. En el dataset actual, tanto el VP 4H como el VP 1D son inútiles como referencia táctica. El modelo tuvo que decidir autónomamente usar el VP 1H, lo que introduce inconsistencia entre análisis.

**Solución — Prompt:** Añadir regla de fallback explícita tras la REGLA DE EXCURSIÓN DE PRECIO:

```
FALLBACK DE VOLUME PROFILE:

Si el VP del TF primario es inválido (POC > 5% del precio):
1. Usar el VP del TF inmediatamente inferior como sustituto táctico.
2. Indicar explícitamente en el análisis que el VP primario fue descartado y cuál se usa como referencia.
3. Reducir la convicción de los niveles VP en un grado (de soporte/resistencia fuerte a referencia orientativa).
4. Si todos los VPs disponibles son inválidos: operar sin referencia de VP y señalarlo en el Risk Score.
```

---

### P4 — VWAP en dataset sin regla de interpretación en el prompt

**Capa:** Prompt  
**Evidencia directa:**
```json
"1D": { "vwap": { "value": 74953.62, "trend": "rising", "divergence": "bearish" } },
"1h": { "vwap": { "value": 78369.28, "trend": "falling", "divergence": "bullish" } }
```
Precio actual: $77,752. Precio está 3.7% por encima del VWAP 1D.

**Problema:** El dataset incluye VWAP con valores y divergencias en todos los TFs, pero el prompt no menciona VWAP en ninguna regla de scoring. El modelo lo puede incluir arbitrariamente en el análisis sin base metodológica, o ignorarlo completamente. Con precio un 3.7% sobre VWAP 1D, hay información útil que queda sin procesar.

**Solución — Prompt:** Añadir subregla en la sección de Volume Flow o Structure:

```
VWAP — REGLA DE CONTEXTO (no scoring directo):

Precio > VWAP 1D: confirma momentum alcista diario. Refuerza bias alcista si Structure Score ≥ +1.
Precio < VWAP 1D: señal de debilidad. Añade cautela a cualquier bias alcista.
VWAP divergence="bearish" en 1D con precio subiendo: bandera de advertencia equivalente 
  a CVD 1D divergente. Reduce convicción LONG en 1 nivel.
VWAP no puntúa directamente en ningún score. Solo ajusta conviction.
```

---

### P5 — Sin estado "PREPARAR" — gap entre ESPERAR y COMPRAR

**Capa:** Prompt  
**Problema:** El prompt define tres estados de output: COMPRAR, VENDER, ESPERAR. No existe un estado intermedio que refleje la situación más frecuente en mesas profesionales de derivados: condiciones favorables establecidas pero trigger pendiente. En el dataset actual (funding extremo negativo, OI estable, estructura 1D alcista), el análisis correcto no es "ESPERAR" genérico sino "condiciones de squeeze cargadas, esperando trigger de ruptura". Esa distinción es operacionalmente relevante y actualmente se pierde.

**Solución — Prompt:** Añadir cuarto estado de output:

```
PREPARAR:
Usar cuando:
- Derivatives Score ≥ +1 Y condición de squeeze identificada
- Structure Score ≥ 0
- Falta trigger de entrada confirmado
- El setup puede activarse en la ventana de validez definida

Output de PREPARAR incluye:
- Condición exacta de activación (precio, volumen, cierre de vela)
- Tamaño de posición reducido (50% del tamaño nominal)
- Precio de activación condicional (limit order o stop-limit)
- Ventana de validez
- Condición de cancelación si el setup se invalida antes de activarse
```

---

### P6 — ETF Flows × Funding sin regla de interacción multiplicativa

**Capa:** Prompt  
**Problema:** El prompt trata ETF Flows como ajuste de conviction aislado (+0.5 / -0.5). No define qué ocurre cuando ETF Flows y Funding apuntan en la misma dirección. En el dataset actual, ETF Flows son acumuladores (+$1.5B semanal, +0.5 conviction) y Funding es extreme_short_overload (señal alcista de squeeze). La suma aritmética de dos señales independientes no captura la co-ocurrencia, que es estadísticamente más significativa.

**Solución — Prompt:**

```
INTERACCIÓN ETF FLOWS × FUNDING:

Si etf_flows.trend_7d="accumulating" Y funding_severity_negative ∈ {"high", "extreme"}:
→ Añadir +0.5 adicional al conviction global (no al score de derivados)
→ Señalar en el análisis como "confluencia institucional + presión de squeeze"

Si etf_flows.trend_7d="distributing" Y funding_severity ∈ {"high", "extreme"} (positivo):
→ Restar -0.5 adicional al conviction global
→ Señalar como "presión de distribución institucional + riesgo de liquidation cascade"
```

---

## Deficiencias Menores 🟢

---

### D11 — Liquidation history 7d idéntico al 24h

**Capa:** Dataset  
**Evidencia directa:**
```json
"liquidations_24h": {
  "longs_usd": 230.92,
  "history": {
    "last_24h_longs_usd": 230.92,
    "7d_total_longs_usd": 230.92,
    "7d_avg_daily_longs_usd": 230.92
  }
}
```

**Problema:** Los campos de historial 7d son idénticos al valor 24h. Casi con certeza es un bug de cálculo donde el campo 7d es un alias del 24h. El prompt usa el historial de liquidaciones para detectar tendencias de crowding y comparar presión actual vs. histórica reciente. Con datos idénticos, esa comparación es imposible.

**Solución — Dataset:** Corregir el cálculo del rolling 7d para que acumule los últimos 7 períodos diarios independientemente del valor actual.

---

### D12 — volume_history.cvd: change_pct = 0 y period_min = period_max

**Capa:** Dataset  
**Evidencia directa:**
```json
"volume_history": {
  "cvd": {
    "current_value": -45591.63,
    "change_pct_7d": 0,
    "change_pct_30d": 0,
    "period_min": -45591.63,
    "period_max": -45591.63,
    "trend_30d": "flat"
  }
}
```

**Problema:** `period_min` = `period_max` = `current_value` y todos los cambios porcentuales son 0. Esto indica que el campo no está calculando un rolling histórico sino devolviendo el valor actual como único punto de datos. El CVD histórico es estructuralmente inútil como contexto de ciclo. El mismo bug afecta a `volume_history.vwap`.

**Solución — Dataset:** Corregir el cálculo para que `period_min` y `period_max` reflejen el rango real del período cubierto, y `change_pct_7d` / `change_pct_30d` comparen con los valores reales de hace 7 y 30 días.

---

### P7 — Nomenclatura de TFs inconsistente entre prompt y dataset

**Capa:** Prompt  
**Evidencia directa:**
- Prompt usa: `technical["1D"]`, `technical["1H"]`
- Dataset usa: `"1h"`, `"4h"`, `"1D"`, `"1W"` (minúsculas para intradía, mayúsculas para diario/semanal)

**Problema:** La inconsistencia de capitalización entre el prompt y el dataset puede causar fallos silenciosos si el sistema se implementa con acceso directo a las claves JSON. Como instrucción para LLM, es una fuente de ambigüedad que puede llevar a referencias incorrectas.

**Solución:** Estandarizar el dataset a mayúsculas consistentes (`"1H"`, `"4H"`, `"1D"`, `"1W"`) y actualizar el prompt para reflejar esa nomenclatura. O, alternativamente, normalizar a minúsculas en ambos lados.

---

---

## Deficiencias de la revisión externa — evaluadas y filtradas

> Las siguientes deficiencias provienen de una revisión externa adicional. Se incluyen únicamente las que superaron evaluación crítica. Se documentan también los puntos **rechazados** con justificación, para evitar que futuras revisiones los reintroduzcan.

---

### D13 — Campo `trend` mezcla tendencia estructural y momentum sin distinción

**Capa:** Dataset · **Severidad:** 🟡 IMPORTANTE  
**Evidencia directa:**
```json
"4h": {
  "trend": "bullish",
  "macd.momentum_state": "bearish_accelerating",
  "cvd.trend": "falling",
  "stoch_rsi.signal": "neutral"
}
```

**Problema:** El campo `trend` en 4H es "bullish" porque refleja la estructura de swings (HH/HL), mientras que todos los indicadores de momentum (MACD, CVD, Stoch RSI) son bajistas o neutrales. Son conceptos distintos — *tendencia estructural* vs. *momentum actual* — comprimidos en un único campo sin distinción. El prompt y el modelo pueden interpretar `trend: "bullish"` como señal táctica cuando en realidad es solo un descriptor de estructura histórica.

**Impacto:** El Structure Score puede inflarse artificialmente si el modelo confía en el campo `trend` sin cruzarlo con los indicadores de momentum subyacentes. No es un error del dato — es una ambigüedad semántica que genera confusión sistemática.

**Nota de severidad:** La revisión externa lo clasificó como 🔴 crítico. Se rebaja a 🟡 importante porque el prompt ya tiene jerarquía para resolver este conflicto (Structure Score separado de Execution Score). Es un problema de claridad del dataset, no un error que invalide el análisis.

**Solución — Dataset:**
```json
"trend": "bullish",
"trend_basis": "swing_structure",
"trend_method": "ema_cross + swing_hl",
"momentum_alignment": false,
"trend_conflict_note": "Structural trend bullish but momentum indicators bearish — pullback in uptrend"
```

---

### D14 — Bollinger Bands sin campo `bollinger_window`

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** Las Bollinger Bands se calculan con un período configurable (habitualmente 20 velas, pero puede variar). El dataset no declara el período usado. Si el período es muy largo, la `position` dentro de las bandas puede ser engañosa para análisis de corto plazo. No es un error del valor — es ausencia de metadata de cálculo.

**Solución — Dataset:**
```json
"bollinger_bands": {
  "window": 20,
  "std_dev": 2.0,
  "upper": 78753.42,
  "position": 0.4376
}
```

---

### D15 — Falta campo `macro_regime` sintetizado

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** El dataset incluye DXY, SPX y Gold individualmente, pero no un campo que sintetice el régimen macro. El prompt instruye al modelo a inferirlo manualmente desde los tres campos. Un campo precalculado reduciría varianza entre análisis.

**Solución — Dataset:**
```json
"macro": {
  "macro_regime": "mixed",
  "macro_regime_basis": "SPX rising + DXY flat + Gold falling",
  "dxy": {...},
  "spx": {...},
  "gold": {...}
}
```

---

### D16 — Falta ratio vol ETH/BTC como señal de rotación

**Capa:** Dataset · **Severidad:** 🟢 MENOR (principalmente útil en análisis ETH/SOL)

**Problema:** El dataset incluye `btc_dvol: 40.24` y `eth_dvol: 59.63` por separado. El ratio ETH/BTC DVOL (1.48 en este caso) es una señal de rotación de riesgo — cuando ETH vola mucho más que BTC, el mercado está en modo beta de altcoins. Para análisis BTC puro su utilidad es limitada; para ETH/SOL es relevante.

**Solución — Dataset:**
```json
"volatility": {
  "btc_dvol": {...},
  "eth_dvol": {...},
  "eth_btc_vol_ratio": 1.48,
  "vol_ratio_signal": "altcoin_beta_mode"
}
```

---

### D17 — Falta variación temporal de BTC dominance para inferir market breadth

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** El dataset incluye `btc_dominance_pct: 58.24` como valor estático. Sin la variación temporal (dominance ayer, hace 7 días), el modelo no puede detectar si el capital está rotando hacia altcoins (dominance cayendo) o hacia BTC (dominance subiendo), lo que es una señal clave de breadth.

**Solución — Dataset:**
```json
"global_market": {
  "btc_dominance_pct": 58.24,
  "btc_dominance_change_24h": -0.3,
  "btc_dominance_change_7d": +1.2,
  "breadth_signal": "btc_consolidating"
}
```

---

### D18 — Falta campo `data_quality` por sección

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** Algunas secciones tienen datos completos, otras tienen nulls o inconsistencias (onchain, liquidation clusters, volume_history). No hay un campo que indique al modelo qué secciones son fiables y cuáles deben tratarse con cautela.

**Solución — Dataset:** Añadir al nivel raíz de cada sección principal:
```json
"onchain": {
  "data_quality": "partial",
  "missing_fields": ["exchange_netflow_24h_btc"],
  "mvrv": 1.4628
}
```

---

### D19 — Falta `timestamp` específico por TF

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** El dataset tiene un timestamp global pero los datos de cada TF pueden corresponder a ventanas temporales distintas (la última vela 1H cerró hace menos tiempo que la última vela 1D). Sin timestamps por TF, el modelo no puede saber si está analizando datos de la misma ventana temporal o de cierres distintos.

**Solución — Dataset:**
```json
"4h": {
  "timeframe": "4h",
  "last_candle_close_ts": 1777276800000,
  "last_candle_close_utc": "2026-04-27T08:00:00Z",
  "trend": "bullish"
}
```

---

### D20 — Falta `price_change` por TF

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** El dataset incluye `price_change_24h_pct: -0.39` como único indicador de variación de precio. No hay variación específica por TF (1H, 4H, 7D). El modelo puede inferir rangos aproximados desde Bollinger Bands, SuperTrend y Fibonacci, pero no tiene acceso directo al retorno del precio en cada ventana temporal.

**Nota de severidad:** La revisión externa lo clasificó como 🔴 crítico. Se rebaja a 🟢 menor porque el dataset ya incluye suficiente información por TF (precios de referencia de Fibonacci, VWAP, BB) para que el modelo infiera momentum sin ambigüedad material.

**Solución — Dataset:**
```json
"price_change": {
  "1h_pct": -0.12,
  "4h_pct": -0.35,
  "1d_pct": -0.39,
  "7d_pct": 2.1
}
```

---

### D21 — Falta `last_bos_valid` en SMC (extensión al dataset de P2)

**Capa:** Dataset · **Severidad:** 🟡 IMPORTANTE

**Problema:** La regla P2 del prompt instruye al modelo a degradar un BOS a "unconfirmed" si el precio retrocede por debajo del nivel roto. Esta lógica puede resolverse en el generador del dataset en lugar de delegarla al LLM, reduciendo varianza entre análisis. En el dataset actual, el BOS 1D bullish tiene `broken_swing_price: 78333` y el precio actual es $77,752 — por debajo del nivel roto. El dataset debería marcar este BOS como inválido en origen.

**Relación con P2:** P2 añade la regla al prompt (cómo el LLM debe razonarlo). D21 añade el campo al dataset (resultado precalculado del mismo criterio). Ambos son complementarios, no duplicados.

**Solución — Dataset:**
```json
"smc": {
  "last_bos": {
    "direction": "bullish",
    "broken_swing_price": 78333,
    "close": 78657.55,
    "candles_ago": 1,
    "valid": false,
    "invalid_reason": "price_retraced_below_broken_level",
    "retracement_pct": -1.15
  }
}
```

---

### D22 — Falta `exchange_used_for_price`

**Capa:** Dataset · **Severidad:** 🟡 IMPORTANTE

**Problema:** El dataset no declara de qué exchange proviene el precio de referencia (`price_current: 77752`). Esto afecta la consistencia de todos los cálculos de distancia: si el precio viene de un agregador pero el funding, OI y clusters de liquidación vienen de Binance, las distancias calculadas pueden estar sesgadas por diferencias de precio entre venues (típicamente $20-50 en momentos de estrés). El dataset ya declara fuente en campos como `source: "taker_real"` (volumen), `source: "deribit"` (DVOL), `source: "coinalyze_inferred"` (clusters) — pero no para el precio base.

**Solución — Dataset:**
```json
"price_current": 77752,
"price_source": "binance_spot",
"price_timestamp_utc": "2026-04-27T11:12:03Z"
```

---

### D23 — Falta lista `indicators_diverging` por TF

**Capa:** Dataset · **Severidad:** 🟢 MENOR

**Problema:** El dataset incluye múltiples indicadores por TF pero no señaliza cuáles están en conflicto entre sí. Un campo descriptivo simple (lista de indicadores que contradicen el `trend` declarado) ayudaría al modelo a calibrar la convicción sin necesidad de leer y cruzar todos los indicadores manualmente.

**Nota importante:** Se propuso originalmente como `indicator_conflict_score: 0.42` (score numérico). Esa versión fue rechazada porque implica pesos arbitrarios entre indicadores que duplicarían la lógica del prompt. La versión aceptada es puramente descriptiva — lista, no puntuación.

**Solución — Dataset:**
```json
"4h": {
  "trend": "bullish",
  "indicators_diverging": ["macd", "cvd", "stoch_rsi"],
  "indicators_aligned": ["supertrend", "adx_direction"]
}
```

---

### Puntos rechazados de la revisión externa

Los siguientes puntos fueron propuestos por la revisión externa y **rechazados tras evaluación crítica**. Se documentan aquí para que no sean reintroducidos en futuras auditorías.

**C3 — Divergencias RSI/WaveTrend incoherentes entre TFs → RECHAZADO**
La premisa es metodológicamente incorrecta. Las divergencias de RSI son específicas del período y TF calculado. Una divergencia en 1D no tiene por qué reflejarse en 4H — miden patrones en ventanas temporales distintas. No existe inconsistencia real en el dataset.

**C4 — SuperTrend desalineado con SMC → RECHAZADO**
SuperTrend es un indicador rezagado por diseño. SMC detecta rupturas anticipatorias. Su desalineación en puntos de giro es el comportamiento esperado y normal, no una deficiencia. Añadir `supertrend_smc_alignment: "misaligned"` añadiría ruido al análisis.

**C2 — ADX contradictorio con régimen → RECHAZADO (mayoritariamente)**
En el dataset actual, ADX y régimen declarado son coherentes (ADX 28.52 → trending; ADX 17.74 → ranging). La propuesta asume una contradicción que no existe en los datos concretos. Lo que sí falta es `regime_source` (mejora de trazabilidad), incluido en D14 por analogía.

**I1 — Bollinger Bands inconsistentes con contexto → RECHAZADO**
`position: 0.4376` (zona media-baja) con precio cerca de resistencias y momentum bajista es perfectamente coherente — el precio ha caído desde la banda superior. No hay inconsistencia. Se acepta únicamente la mejora de metadata (`bollinger_window`) como D14.

---

## Instrucciones de priorización para implementación

Aplicar en este orden:

**Bloque 1 — Errores activos que distorsionan el scoring (corregir primero):**
1. **D1 + P1** juntos — severity simétrica de funding. Son el mismo problema en dos capas. El dato actual es activamente incorrecto.
2. **D2** — corregir cálculo de divergencia CVD 1D con ventana temporal explícita. Afecta directamente al VETO LONG.
3. **D5** — resolver ambigüedad de unidades en liquidation clusters. El dato actual es ininterpretable.

**Bloque 2 — Datos ausentes que impiden análisis completo:**
4. **D3** — añadir metadata de periodo y flag de validez a Volume Profiles.
5. **D4** — añadir contexto histórico (7d) al CVD del TF primario.
6. **D9** — exchange netflow obligatorio, no null.

**Bloque 3 — Reglas del prompt con gaps de cobertura:**
7. **P2** — regla de BOS no confirmado post-retroceso.
8. **P3** — fallback explícito cuando VP del TF primario está fuera de rango.
9. **D10** — regla de secuencia CHoCH→BOS trampa (dataset + prompt).
10. **P5** — estado PREPARAR como output adicional.

**Bloque 4 — Mejoras de claridad y consistencia:**
11. **D13** — separar `trend` estructural de momentum en el dataset.
12. **P4 + P6** — reglas de VWAP e interacción ETF×Funding en el prompt.
13. **D7 + D8** — fuente del L/S ratio y freshness de ETF flows.
14. **D11 + D12** — corregir cálculos rotos de historial (liquidations 7d, volume_history).
15. **P7** — estandarizar nomenclatura de TFs.

**Bloque 5 — Enriquecimiento del dataset (menor urgencia):**
16. **D6** — anclas de Fibonacci declaradas.
17. **D14 a D19** — metadata adicional (bollinger_window, macro_regime, vol ratio, breadth, data_quality, timestamps por TF).

---

*Documento generado el 2026-04-27. Consolidación de auditoría automatizada + análisis post-ejecución del modelo analítico.*
