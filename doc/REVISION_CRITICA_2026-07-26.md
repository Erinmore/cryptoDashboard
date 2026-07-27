# Revisión crítica de CRYPTEX — 2026-07-26

> Revisión **solo lectura** solicitada al inicio de la fase de recogida. Ninguna línea de
> código tocada. Cada hallazgo lleva **evidencia reproducible** y un **triage** explícito:
> **(A)** seguro de arreglar durante la recogida · **(B)** toca la decisión → esperar al
> checkpoint · **(C)** descartado, con motivo.
>
> Evidencia base: payload real de producción (`SOL/4h`, 2026-07-26 21:18 UTC), BBDD de la Pi,
> crontab en vivo, klines de Binance recalculadas a mano.

---

## 0. Encuadre: ¿qué se está midiendo aquí?

Hay una pregunta que el proyecto nunca se ha hecho por escrito: **qué sería "funciona"**.

CRYPTEX está construido, auditado dos veces y desplegado. Lo que no tiene es un **criterio de
éxito falsable**. Y la revisión ha encontrado que, además, en su estado actual **no tiene forma
de fallar visiblemente**:

- Todas las decisiones observadas son `Esperar`.
- `Esperar` no se puede evaluar como acierto ni como error — no genera PnL, no cruza un TP ni un stop.
- `MIN_DIRECTIONAL_SAMPLE = 20` se mide sobre direccionales, así que el win-rate nunca reportará.

**Un sistema que solo dice "espera" es inmune a la refutación.** La fase de recogida, tal y como
está planteada, puede terminar con 28 observaciones y **cero capacidad de concluir nada** — no por
falta de muestra, sino porque la salida no es evaluable. Los hallazgos C1 y C2 explican por qué
esto no es casualidad.

> **Supuesto que asumo** (no llegaste a responder a la pregunta del plan): que el objetivo es
> **decidir mejor sobre SOL**, no construir ingeniería por el gusto de construirla. Si el objetivo
> real fuera el segundo, C1/C2 dejan de ser críticos y pasan a curiosidades. Corrígeme y reordeno.

---

## C1 · CRÍTICO — El veto determinista es estructuralmente inalcanzable

**El veto nunca ha disparado en producción. La causa no es el mercado: es un umbral mal calibrado.**

El `VETO LONG/SHORT` exige la conjunción de tres patas
([gating.js:176-213](../backend/src/utils/gating.js#L176-L213)). Dos de ellas se cumplen
habitualmente; la tercera —la divergencia CVD del 1D con `cvd_strength` no-marginal— es el
cuello de botella único. En el payload de hoy:

```
gating.conditions.long : cvd_1d_bearish=false · oi_not_expanding=true · near_resistance_3plus_touches=true
gating.conditions.short: cvd_1d_bullish=false · oi_not_expanding=true · near_support_3plus_touches=true
```

Dos de tres, en ambas direcciones. Siempre falla la misma pata. El motivo está en el umbral:

`cvdStrength()` ([indicatorService.js:27-29](../backend/src/services/indicatorService.js#L27-L29))
bucketiza `cvd_delta_vs_volume_pct` con cortes **fijos** — `<2% marginal`, `2-8% moderate`,
`>8% strong` — y los aplica **igual a los cuatro timeframes**. Medido hoy:

| TF | `cvd_delta_vs_volume_pct` | `cvd_strength` |
|---|---|---|
| 1h | 5.36 % | moderate |
| 4h | −0.25 % | marginal |
| **1D** | **0.86 %** | **marginal** |
| 1W | 0.92 % | marginal |

Sobre 20 velas de 1D (20 días) el desequilibrio neto se cancela por reversión a la media y el
ratio se aplasta contra cero; sobre 20 velas de 1h (20 horas) no. Un corte pensado para
intradía, aplicado al diario, **clasifica como "ruido" prácticamente todo**.

**Consecuencias en cadena:**

1. El veto no puede dispararse salvo en un evento extremo del 1D.
2. La contradicción `cvd_1d_divergence` exige el mismo criterio → **el bloque `volume` nunca
   aporta contradicciones** (ver C2).
3. El **cron B oportunista está cazando un evento que el código no puede producir**. Paga un
   chequeo horario por algo estructuralmente improbable.
4. Al final de la recogida, si los caminos endurecidos siguen sin ejercitarse, la lectura
   natural será *"el mercado no dio la condición"* — y sería **falsa**. Es el umbral.

**Triage: (B)** — toca `indicatorService`/`gating`. No tocar hasta el checkpoint. Pero **hay que
saberlo ya**, porque cambia lo que la recogida puede llegar a demostrar.

### C1-bis · CORRECCIÓN con datos históricos (añadida tras medir)

La afirmación *"estructuralmente inalcanzable"* de arriba es **demasiado fuerte**. Medido con la
fórmula exacta del backend (`cvdDelta / windowVolume`, ventana rodante de 20 velas) sobre el
histórico completo de SOL en Binance:

| TF | ventanas | `marginal` (<2 %) | `moderate` (2-8 %) | `strong` (>8 %) | mediana \|ratio\| |
|---|---|---|---|---|---|
| 1h | 481 | 34,7 % | 55,9 % | 9,4 % | 3,04 % |
| **4h** | 481 | **50,3 %** | **49,7 %** | **0,0 %** | **1,99 %** |
| 1D | 481 | 68,0 % | 32,0 % | 0,0 % | 1,42 % |
| 1W | 292 | 98,3 % | 1,7 % | 0,0 % | 0,59 % |

Correcciones que imponen estos datos:

1. **La pata CVD 1D del veto está disponible el 32 % del tiempo**, no el 0 %. Sigue siendo el
   cuello de botella (necesita además que la divergencia exista y apunte en la dirección
   correcta), pero el veto **no es imposible**: es infrecuente. C1 se rebaja de "inalcanzable" a
   "raro por umbral, no por mercado". La conclusión práctica (el cron B rinde menos de lo
   previsto) se mantiene.
2. **El hallazgo real está en el 4h, el TF primario de la recogida.** La mediana del ratio es
   **1,99 %** y el umbral es **2 %**: el corte cae exactamente sobre la mediana de la
   distribución. `cvd_strength` en 4h es, literalmente, **una moneda al aire** — 50,3 % / 49,7 %.
   No discrimina nada; parte la muestra por la mitad en un punto arbitrario.
3. **El bucket `strong` no existe** por encima de 1h: 0,0 % en 4h, 1D y 1W. La regla del prompt
   *"strong: refuerza la lectura en un nivel"* es **código muerto** para el TF de la recogida.

---

## C3 · CRÍTICO — La puerta que SÍ está viva: `volume >= +1` es una moneda al aire

Esta es la que responde de verdad a *"¿solo va a decir Esperar?"*, y —al contrario que C1 y C2—
**no está inerte**. Encadena tres piezas:

**1 · El prompt anula el score de volumen cuando el CVD es marginal.** Literal, sección B:

> `cvd_strength="marginal"`: presión neta marginal. **La dirección del CVD es ruido de fondo, no
> aporta convicción al Volume Flow Score** aunque `trend` sea "rising"/"falling".

Y unas líneas antes: *"CVD del TF primario = SEÑAL PRIMARIA. **Define el signo del Volume Flow
Score**"*. Si la señal primaria es ruido, el Volume Flow Score se queda en **0**.

**2 · El validador exige `volume` distinto de 0 para operar**
([analysisValidator.js:108-115](../backend/src/services/analysisValidator.js#L108-L115)):

```
Comprar → exige derivatives >= +1  Y  volume >= +1     (severe)
Vender  → exige derivatives <= -1  Y  volume <= -1     (severe)
```

**3 · El fail-safe está activo.** `analysisFailsafeEnabled` es `true` por defecto
([env.js:44](../backend/src/config/env.js#L44)) y **el `.env` de la Pi no lo sobrescribe**
(verificado: 0 apariciones). Así que un `Comprar` con `volume=0` se degrada a `Esperar`.

**Encadenado: CVD 4h marginal ⇒ volume 0 ⇒ `Comprar`/`Vender` mecánicamente imposibles**, pasara
lo que pasara con la estructura, los derivados o el on-chain.

Y por C1-bis sabemos con qué frecuencia ocurre: **el 50,3 % del tiempo**. Hoy, `−0,25 %` → puerta
cerrada.

**Esta es la respuesta a la pregunta.** El sistema no está condenado a `Esperar`: la puerta está
abierta aproximadamente la mitad del tiempo. Pero **lo que decide si está abierta no es un juicio
de mercado, es un único número cruzando un umbral que cae justo en la mediana de su propia
distribución.** Media moneda al aire, medio análisis.

Matiz: `B2. Order Book Imbalance` permite un ajuste de ±0,5 al Volume Flow Score, pero `scores.volume`
debe ser **entero** en `[-2,+2]` (validado), así que un ±0,5 sobre 0 no alcanza el +1 por sí solo.

**Triage: (B)** — es la primera pieza a tocar en el checkpoint, por delante de C1 y C2.

---

## C2 · CRÍTICO — La puerta CONVICTION DECAY no puede dispararse

Tras el dedupe por bloque (2026-07-10), `contradiction_count` cuenta **bloques analíticos
distintos**, máximo 3 ([gating.js:78-89](../backend/src/utils/gating.js#L78-L89)):

| Bloque | Códigos posibles |
|---|---|
| `volume` | `cvd_1d_divergence` — **1 solo**, bloqueado por C1 |
| `derivatives` | `oi_flat_or_falling` — **1 solo** |
| `structure` | `price_near_key_level`, `htf_conflict_1w_1d`, `smc_structural_conflict` |

La puerta exige `>= 3` ([analysisValidator.js:100-105](../backend/src/services/analysisValidator.js#L100-L105)).
Con `volume` inhabilitado por C1, el backend **tope realista = 2** (derivatives + structure), que
es exactamente lo observado hoy y en el baseline del 26-jul.

La única vía restante es la 6ª contradicción, que suma +1 si los scores del LLM tienen signos
opuestos (`volume<0 ∧ structure>0`, o al revés). Pero los análisis observados traen
**`scores {0,0,0,0}`** → la condición es falsa por construcción.

**Resultado: la puerta de CONVICTION DECAY está inerte.** Sumado a C1 (veto inerte) y a
`data_insufficient=false`, se llega a la conclusión que reordena toda la lectura del proyecto:

> **Ninguna de las puertas deterministas está vinculando ninguna decisión.**
> El `gating_active=0` del único análisis en BBDD no es "el gate aprobó": es "el gate no existió".
> El 100 % `Esperar` **no viene del sistema de gating** — viene íntegramente del juicio del LLM.

Esto **invierte la hipótesis H4** del protocolo. No hay sesgo estructural a `Esperar` impuesto por
el backend: hay un modelo que dice `Esperar` por su cuenta, con toda la maquinaria de contención
desactivada detrás. Las dos auditorías endurecieron las puertas hasta dejarlas sin efecto.

Nota adicional: la señal H3 que ya habías marcado (`scores {0,0,0,0}`) no es solo un síntoma de
pereza del modelo — **es lo que desactiva la 6ª contradicción**. H3 y C2 son el mismo problema.

**Triage: (B)** — es la conclusión más importante del checkpoint, no un fix inmediato.

---

## H1 · ALTO — No existe ningún backup de la base de datos

Verificado en la Pi: `~/backup*`, `~/cryptex/backup*`, `/var/backups/cryptex*` → **nada**.

`history_series` acumula CVD y VWAP a razón de **1 fila por día y moneda** (confirmado: hoy hay
exactamente 1 fila de `cvd` por coin, `ts_key=1785024000` = 2026-07-26 00:00 UTC). Son las dos
únicas series **irreconstruibles**: ninguna API las sirve retroactivamente.

Riesgo real: un `dbClear` mal tecleado, un fallo del NVMe o una migración fallida **borran la fase
de recogida entera** sin vuelta atrás. El coste de mitigarlo es un `VACUUM INTO` diario a un
directorio aparte, con rotación de 7 días. Diez líneas.

Atenuante encontrado: el almacenamiento es **NVMe, no tarjeta SD** (`/dev/nvme0n1p3`, 43 % de 33 G),
así que el modo de fallo clásico de la Pi no aplica. Sigue sin haber copia.

**Triage: (A)** — arreglable ahora. No toca nada de decisión.

---

## H2 · ALTO — La recogida falla en silencio

`collect.sh` ante error escribe una línea `ERROR` en `collect.log` y termina (correcto: no
reintenta, para no meter observaciones casi duplicadas). Pero **nadie lee ese log**.

Escenario concreto: el servicio se cae un viernes por la noche. Cron A dispara cuatro veces
durante el fin de semana, escribe cuatro `ERROR curl_rc=7`, y el lunes hay **cuatro observaciones
perdidas** que nadie sabe que faltan. Con una muestra objetivo de 15-28, perder 4 es perder el
15-25 % del experimento.

Lo mismo aplica a la continuidad de CVD/VWAP: la Pi lleva **1 h 24 min de uptime** (reinició hoy
~22:01 CEST). Un reinicio no rompe nada, pero un apagado de varios días sí, y tampoco avisaría.

**Triage: (A)** — un chequeo diario que compare análisis esperados vs registrados y avise. No
toca decisión.

---

## H3 · ALTO — Deriva silenciosa entre el repo y la Pi

`deploy.sh` sincroniza `backend/src/`, `frontend/dist/` y los manifests. **No sincroniza
`scripts/` ni `backend/scripts/`.**

Ya está anotado en SESSION_STATE para `auditStats.mjs`, pero ahora el problema es mayor: los dos
scripts que **gobiernan la recogida entera** (`collect.sh`, `collectOpportunistic.sh`) viven en la
Pi por un `rsync` manual de una sola vez. Cualquier corrección futura en el repo **no llegará**, y
un `deploy.sh` no lo delatará.

Verificado: los ficheros de la Pi coinciden en tamaño y fecha con los del repo (4215 / 2491 bytes,
26-jul 22:40). Están sincronizados **hoy**. La cuestión es que nada garantiza que sigan estándolo.

**Triage: (A)** — ampliar `deploy.sh` o dejar constancia explícita del paso manual.

---

## H4 · ALTO — El 8 % del prompt y dos bloques del payload son inertes para SOL

El protocolo fija **SOL** para toda la recogida. Para SOL:

```json
"onchain":   {"available": false, "unavailable_reason": "not_supported_for_asset"}
"etf_flows": {"available": false, "unavailable_reason": "not_supported_for_asset"}
"volatility": { "btc_dvol": {...}, "eth_dvol": {...}, "sol_dvol": null }
```

Y el SYSTEM_PROMPT dedica a esos bloques:

| Sección | Líneas | Estado para SOL |
|---|---|---|
| `E. On-Chain Score (-2 a +2) — solo BTC` | 291-320 (30) | inerte |
| `F2. ETF Flows (solo BTC y ETH spot ETF)` | 335-355 (21) | inerte |
| `F3. Volatility Index — DVOL (solo BTC y ETH)` | 356-365 (10) | parcial (llegan BTC/ETH como contexto) |

≈ **61 de 733 líneas** de instrucciones que no pueden aplicarse, más los bloques `not_supported`
viajando en el dataset. Se paga en cada uno de los ~28 análisis de la recogida.

**Triage: (B)** — recortar el prompt cambia el input del LLM y por tanto invalida la
comparabilidad de la muestra. Anotado para después del checkpoint.

---

## M1 · MEDIO — `contradictions_raw_count` no cuenta lo que su nombre dice

En el payload de hoy conviven:

```json
"contradictions": [ 3 elementos ],
"contradiction_count": 2,
"contradictions_raw_count": 2
```

No es un bug de lógica: [gating.js:378](../backend/src/utils/gating.js#L378) calcula
`countBlocks(contra.contradictions)`, y el docstring lo declara ("conteo de **bloques** ANTES del
dedupe por veto"). Es un **problema de nombre y de cobertura**: `raw` sugiere señales crudas, y
**no existe ningún campo que reporte el número de señales crudas**.

Segundo agujero, más relevante: `deduped_by_veto` **no se persiste**.
[analysisController.js:820](../backend/src/controllers/analysisController.js#L820) guarda
`contradiction_codes` desde la lista **post-dedupe**. Hoy no importa (sin veto activo, la lista es
completa y H1 sigue siendo medible: 3 códigos vs count 2). Pero **el día que el veto por fin
dispare** —el evento raro que el cron B está pagando por cazar— se perderá justo el registro de
qué absorbió el veto.

**Triage: (A)** — persistir `deduped_by_veto` y `contradictions_raw_count` corregido es telemetría
pura, no altera ninguna decisión. Conviene hacerlo **antes** de que dispare el primer veto.

---

## M2 · MEDIO — `buy_pressure_pct` es ruido con apariencia de señal

```
volume_delta.buy_pressure_pct = 50.6        (ventana completa: 180 velas)
última vela real (Binance)    = 62.3 %      (taker_buy 18.789 / vol 30.158)
```

El campo se acumula sobre toda la ventana del TF, así que está **estructuralmente clavado en ~50**.
Este mismo problema ya se detectó el 2026-07-10 para `expectedVolumeScore`, y se resolvió
**cambiando la guardia C2 a CVD**. Pero el campo **sigue viajando al LLM** en los cuatro TFs.

El prompt no lo cita (verificado: `buy_pressure_pct` no aparece en las 733 líneas; solo aparece
`buy_pressure` como *valor* de `imbalance_signal`). Es decir: dato sin instrucción, con nombre
sugerente y valor siempre neutro. Es exactamente el tipo de campo que induce una lectura falsa de
"equilibrio".

**Triage: (B)** — quitarlo cambia el dataset. Anotado.

---

## M3 · MEDIO — El resumen de CVD llega vacío al LLM

```json
"volume_history": { "cvd": null, "vwap": { "current_value": 77.11, "change_pct_7d": null, ... } }
```

Causa: la regla D11/D12 devuelve `null` con menos de 2 puntos históricos, y `history_series` tiene
**1 fila de CVD** (la BBDD se vació ayer). Se arreglará solo mañana.

Lo que importa señalar: los resúmenes de **7d y 30d** no estarán poblados hasta el día 7 y el día
30 respectivamente. **Buena parte de la recogida transcurrirá con el LLM sin la serie temporal de
CVD** — que es precisamente la serie por la que la Pi tiene que quedarse encendida. Es un sesgo
conocido a anotar al interpretar los primeros análisis, no un bug.

**Triage: (C)** — nada que arreglar, pero debe constar en el checkpoint como caveat.

---

## B1 · BAJO — Las instrucciones pesan más que los datos

```
SYSTEM_PROMPT : 35.000 chars · 733 líneas
DATASET       : 34.297 chars
```

El modelo recibe más texto prescriptivo que evidencia. Y el dataset está a su vez dominado por
`technical`: **13.972 de 19.916 bytes (70 %)** son los cuatro bloques de TF con 24 claves cada uno.

De los **197 nombres de campo distintos** del payload, **122 no aparecen ni una vez en el prompt**
(el modelo puede leerlos igualmente — "no citado" no es "muerto"— pero un prompt de 733 líneas que
dicta reglas de scoring exactas difícilmente los usará de forma consistente).

Esto es compatible con la señal H3 que ya habías detectado: ante un formulario de 733 líneas, un
modelo tiende a **rellenar el formulario** (`scores {0,0,0,0}`, conviction baja, `Esperar`) en vez
de analizar. No lo demuestra, pero es la hipótesis barata que explica los datos.

**Triage: (B)**.

---

## M4 · MEDIO — Lo único que el sistema tiene que decir, no se muestra

`structured.missing_confirmations[]` —el campo que la 1ª auditoría añadió expresamente como
*"explicación en lenguaje claro de qué falta para operar"*— se calcula, se persiste como columna
JSON en `analyses` y lo devuelve `getAnalysisHistory()`. **Y no se pinta en ningún sitio:**

```
missing_confirmations   → history.js: 0 apariciones · sidebar.js: 0 apariciones
contradiction_count     → history.js: 0 · sidebar.js: 0
contradiction_codes     → history.js: 0 · sidebar.js: 0
conviction              → history.js: 0 · sidebar.js: 1
```

En un sistema cuya salida es **siempre `Esperar`**, "qué falta para poder operar" es literalmente
la única información accionable que produce. Está en la base de datos y no llega a la pantalla.

`conviction` es el segundo caso llamativo: con `scores {0,0,0,0}`, la convicción (0,30 / 0,35) es
**la única variable que está discriminando algo entre análisis** — y el modal de historial, que es
donde se comparan los análisis entre sí, no la muestra.

**Triage: (A)** — es frontend puro, no toca la decisión ni el dataset. Y mejora directamente el
material del checkpoint.

---

## Verificaciones limpias (comprobado, sin hallazgo)

Tan importante como lo que falla es lo que **no** falla. Todo esto se verificó contra producción:

| Qué | Resultado |
|---|---|
| **Leak de `expected_scores` al LLM** | **Cerrado** ✅ — ausente del `llm_request` real. También ausentes `score_*_expected` y el texto del `basis`. La corrección de la Fase 1 funciona en producción. |
| **`temperature`** | Ausente del request ✅, como documenta el escape hatch. |
| **ATR 4h** | Recalculado Wilder-14 sobre 180 klines de Binance: **0,70 / 0,93 %** — coincide exacto con el payload. |
| **RSI 4h** | payload 50,31 vs recalculado 51,07. La diferencia la explica la vela en curso (payload a $75,35, cierre actual $75,50). **No es un bug.** |
| **Reglas huérfanas en el prompt** | **Ninguna.** De 97 tokens con forma de campo, los 45 sin correspondencia en el payload son todos campos del `OUTPUT FORMAT` (`tp1_price`, `smart_money_read`…) o valores de enum (`risk_on`, `above_vah`, `taker_real`). El prompt está bien mantenido en ese eje. |
| **Servicio** | `active`, **0 reinicios**, sin errores en el journal de 24 h, `cron.err` vacío. |
| **Almacenamiento** | NVMe (no SD), 43 % de 33 G. |
| **Cron** | Instalado tal y como documenta §2, `CRON_TZ=UTC`, sin tareas huérfanas. |
| **Frenos del oportunista** | Lógica correcta: marcador diario + consulta a BBDD (no al log) para el freno de 2 h, así respeta también los disparos manuales desde la UI. |
| **IC de Wilson en el modal** | Se muestra correctamente ✅ (`win_rate_ci_low/high`, y `muestra insuf. (n/20)` cuando no llega). Lo que documenta SESSION_STATE es exacto. |

---

## Auditoría de umbrales (2026-07-26) — resultados

Herramienta: [`backend/scripts/auditThresholds.mjs`](../backend/scripts/auditThresholds.mjs).
Importa las funciones **reales** del backend y las evalúa sobre ventanas rodantes **del mismo
tamaño que usa producción** en cada TF (168/180/90/52), con klines de Binance. SOL + BTC y ETH
como control. ~830 ventanas por TF en 1h/4h, ~910 en 1D.

Criterio de lectura: si el corte cae en el **percentil ~50**, parte la muestra por la mitad y no
discrimina nada. Si un bucket sale al **0 %**, esa rama del código nunca se ejecuta.

### T1 · `REGIME_ATR_MULTIPLIER = 2` → rama muerta

`high_volatility` sale **0,0 % en las 12 combinaciones** coin × TF. Sin una sola excepción en
~9.000 ventanas. `detectMarketRegime` nunca puede devolver ese régimen: el ATR actual jamás
supera 2× la SMA(ATR) de las últimas 20 velas, porque el propio ATR es una media suavizada de
Wilder — está autocorrelacionado con su propia media, así que la ratio no se despega.

**Es código muerto, no un umbral mal puesto.** O baja a ~1,3-1,5, o se retira el régimen.

### T2 · `ADX_TRENDING_THRESHOLD = 25` → moneda al aire

Percentil del corte: **53,1 / 49,9 / 55,3 / 53,1** (SOL 1h/4h/1D/1W). En BTC y ETH, igual: 10 de
las 12 combinaciones caen entre el 40 % y el 60 %.

Importa más de lo que parece: `computeTrend` **excluye la contribución de ADX cuando el régimen
es `ranging`**. O sea que una moneda al aire decide si el bloque estructural pondera ADX o no.

### T3 · `cvd_strength` 2 % / 8 % → confirmado, y peor en TFs largos

Con la ventana real de divergencia (20 velas) de `calculateCVD`:

| TF | marginal | moderate | strong | p33 | p67 |
|---|---|---|---|---|---|
| 1h | 34 % | 57 % | 9 % | 1,90 | 4,26 |
| **4h** | **55 %** | 45 % | **0 %** | **1,17** | **2,63** |
| 1D | 79 % | 21 % | **0 %** | 0,72 | 1,62 |
| 1W | 98 % | 2 % | **0 %** | 0,40 | 0,81 |

El bucket `strong` **no existe** por encima de 1h. Y el corte del 4h replica en las tres monedas
(SOL 52,5 % · BTC 53,2 % · ETH 50,3 %): no es una peculiaridad de SOL, es el umbral.

Las columnas p33/p67 son los cortes por terciles que **sí** separarían.

### T4 · `MIN_TOUCHES = 3` (nivel "fuerte") → no filtra

Fracción de niveles S/R que superan cada umbral de toques:

| TF | >=2 | >=3 | >=4 |
|---|---|---|---|
| 1h | 100 % | **90,1 %** | 82,9 % |
| 4h | 100 % | **89,1 %** | 80,5 % |
| 1D | 100 % | 64,5 % | 40,0 % |
| 1W | 100 % | 26,2 % | 6,4 % |

En el TF primario de la recogida, **el 89 % de los niveles detectados califican como "fuertes"**.
El filtro que debía distinguir un nivel probado de un pivote menor admite a casi todos. Explica
por qué `near_resistance_3plus_touches` y `near_support_3plus_touches` salían **ambos true** en el
payload de hoy: no es que el precio esté en una zona especial, es que casi cualquier nivel pasa.

Replicado en BTC (91,9 % en 4h) y ETH (90,0 %). El umbral tendría que subir a 6-8 toques en 4h
para seleccionar el tercio superior — o normalizarse por TF, como todo lo demás.

### T5 · Clamp de `dynamicNearLevelPct` → saturado en TFs largos

El umbral ATR-normalizado de la Fase 4 (`1.5 × ATR%`, recortado a `[0,5 %, 3 %]`):

| TF | bajo mínimo | dentro del rango | **saturado al máximo** |
|---|---|---|---|
| 1h | 0 % | 100 % | 0 % |
| **4h** | 0 % | 68,7 % | **31,3 %** |
| 1D | 0 % | 0 % | **100 %** |
| 1W | 0 % | 0 % | **100 %** |

En 1D y 1W el clamp devuelve **siempre** 3 %: la normalización por volatilidad que introdujo la
Fase 4 es, en esos TFs, una constante disfrazada. En el 4h muerde un tercio del tiempo. Mismo
patrón en BTC (99,6 % saturado en 1D) y ETH (100 %).

El techo del 3 % se fijó pensando en el 4h; el ATR% mediano de SOL en 1D es **6,26 %** (→ 9,39 %
antes de recortar) y en 1W **20,57 %**. El tope tendría que escalar con el TF.

### T6 · Banda `price_vs_vwap` de ±0,05 % → demasiado estrecha

El estado `at` (precio "en" el VWAP) sale al **2,5 / 1,5 / 0,3 / 0,0 %** por TF. El campo es de
facto binario above/below, con la frontera en un punto arbitrario. Poco daño —no alimenta ninguna
puerta— pero es ruido presentado como categoría.

### Lo que salió sano

- **Decay SMC** (`ACTIVE_CANDLES_AGO_BY_TF`): reparto sensato en los 4 TFs — 4h da `active`
  27,6 % / `context` 26,3 % / sin señal 46,0 %. **Bien calibrado.**
- **Mitigación de FVG (40 / 70)**: 60,6 % / 11,9 % / 27,4 % en 4h. Los tres buckets vivos y con
  masa. **Bien calibrado.**
- **`ADX_RANGING_THRESHOLD = 20`**: percentil 26-30 %. Discrimina correctamente. El problema es
  solo el corte de 25, no el de 20.
- **StochRSI 20/80**: percentiles 26 % / 74 %. Razonable.

> ⚠️ Un falso positivo detectado durante la propia auditoría: la primera pasada daba `context` y
> `expired` al 0 % en el decay SMC. Era un bug **del script**, que pasaba `{ tf }` cuando
> `calculateSMC` espera `{ timeframe }` → caía al default `activeMax = Infinity`. Corregido antes
> de sacar conclusiones. Queda anotado porque es exactamente el tipo de error que convierte una
> auditoría en un informe falso.

### Balance

De **13 umbrales medibles**: 5 mal calibrados (T1-T5, uno de ellos rama muerta), 1 cosmético
(T6), 4 sanos, 3 no medibles sin datos de Coinalyze (funding severity, LSR contrarian,
`SCORE_WEIGHTS`) — pendientes, requieren histórico de derivados.

El patrón es consistente: **los umbrales que alguien revisó con un caso concreto delante (decay
SMC, mitigación FVG, ADX ranging) están bien; los que se eligieron por ser números redondos
(2 %, 8 %, 25, 3 toques, 2×, 3 % de techo) están mal.** No es un problema de criterio analítico,
es que nadie miró nunca la distribución.

---

## Segunda tanda de mediciones (2026-07-27) — veto, derivados y puerta de decay

Herramienta: [`backend/scripts/auditVetoFrequency.mjs`](../backend/scripts/auditVetoFrequency.mjs).
Reconstruye la conjunción COMPLETA del veto sobre **90 días reales** (klines + Coinalyze) y mide
el grupo 2 de la auditoría, que no se podía medir solo con klines.

### V1 · La recalibración NO se pasó de laxa

Era mi principal preocupación tras ver el veto activo en 2 de 2 análisis. **Medido: 8,2 %.**

| | |
|---|---|
| **Veto activo** | **8,2 %** de 534 ventanas (long 0,0 % · short 8,2 %) |
| Pata CVD 1D direccional | 13,5 % ← sigue siendo el cuello de botella |
| Pata OI sin expandir | 71,2 % |
| Pata nivel fuerte cercano | 48,7 % |
| Episodios | 11 rachas en 90 días · media 4 velas · máx 2,3 días |

Que saltara en las primeras consultas fue **coincidencia con una racha**, no un umbral roto. La
preocupación era legítima pero la respuesta estaba medible desde el primer momento.

Y valida el arreglo del cron B: con disparo por transición serían **~11 disparos en 90 días**;
con el de persistencia habrían sido **~44**. El sesgo era real y ahora no existe.

### V2 · `funding severity`: 6 de 8 buckets muertos — pero NO se toca

| bucket | frecuencia |
|---|---|
| `normal` (positivo) | 52,0 % |
| `normal` (negativo) | 48,0 % |
| `elevated` / `high` / `extreme`, ambos signos | **0,0 %** |

El funding de SOL en 90 días: mediana **0,0005 %**, p95 **0,01 %**. El corte de `elevated` está en
0,05 % — **cinco veces por encima del p95**. Las reglas FUNDING SEVERITY y FUNDING NEGATIVO del
prompt (~16 líneas) no se aplican nunca para SOL.

**Decisión: no recalibrar.** Y es importante entender por qué, porque contradice lo que se hizo
con `cvd_strength`: el funding tiene **significado absoluto**. Un 0,5 % por periodo es un coste de
carry insostenible en cualquier activo y en cualquier época. Convertirlo a percentiles llamaría
"extreme" al 0,01 % de SOL, que es funding normal — sería fabricar una alarma. Un umbral se
normaliza cuando la magnitud solo tiene sentido comparada consigo misma; el funding no es ese caso.

*(Unidades verificadas antes de concluir: el histórico de Coinalyze y el `rate_pct` en vivo
coinciden exactamente — 0,008751 en ambos.)*

### V3 · LSR contrarian 60/40: el flag no informaba de nada — CORREGIDO

| | |
|---|---|
| long % de SOL | mediana **72,7 %** · p10 63,4 · p90 77,6 |
| `contrarian_bear` (>60) | **95,7 %** |
| `balanced` | 4,3 % |
| `contrarian_bull` (<40) | **0,0 %** |

El corte fijo daba por supuesto que un libro equilibrado está en el 50 %. En SOL la norma es
**72,7 % de longs**, así que el flag decía "contrarian bear" casi siempre y "contrarian bull"
jamás. Y como es **el único input de `expected_scores.derivatives` cuando el funding es normal**
—que es el 100 % del tiempo, por V2— la guardia C2 de derivados era una **constante de −1**.

Corregido: terciles de la propia serie de 7 días, que es la ventana ya descargada. Aquí sí procede
normalizar, por el motivo inverso al del funding: el posicionamiento **solo** tiene sentido
relativo — no existe un "50 % correcto" universal.

Verificado en producción: `long_pct 71,7 → percentil 51,2 → balanced` (cortes 69,61 / 72,55).
El mismo valor que ayer daba `contrarian_bear` con −1 automático.

### V4 · C2 · La puerta de `>=3` es CORRECTA — decisión cerrada

| `contradiction_count` | frecuencia |
|---|---|
| 0 bloques | 11,5 % |
| 1 bloque | 41,3 % |
| 2 bloques | 44,2 % |
| **>=3 bloques** | **2,9 %** ← la puerta |

Quedaba la duda de si `>=3` era una decisión o un residuo del dedupe. Con los datos: bajarla a
`>=2` haría que la puerta forzara `Esperar` el **47 % del tiempo** — inaceptable. En `>=3` actúa
como lo que debe ser: una confluencia extrema, el 2,9 %. **Se mantiene, ahora sí como decisión
consciente y no por inercia.**

**Hallazgo nuevo (no corregido):** `price_near_key_level` dispara el **77,4 %** de las ventanas,
así que el bloque `structure` está casi siempre activo y `contradiction_count` acaba midiendo de
facto "derivados + volumen". Usa `CONTRADICTION_MIN_TOUCHES=2`, más permisivo que el 3 del veto.
Subirlo a 3 lo dejaría en torno al 22 %. **No lo he tocado**: el resultado agregado (2,9 %) es
sano, y ya se han hecho muchos cambios hoy — cada uno adicional compone riesgo sin evidencia de
que haga falta. Queda anotado para el checkpoint.

### V5 · El régimen por percentil no degeneró `computeTrend`

Era un efecto colateral sin evaluar: al salir `ranging` más a menudo, `computeTrend` excluye ADX
más veces. Medido sobre 208 ventanas — régimen: `ranging` 42,8 % · `weak_trend` 38,0 % ·
`trending` 19,2 %. Distribución de tendencia: `neutral` 57,2 % · `bullish` 28,4 % · `bearish`
14,4 %. **Repartida, sin categoría dominante.** El cambio no rompió nada.

*(Caveat: el script usa un proxy estructural EMA20/50 para la tendencia, no `computeTrend`
completo — mide el eje que alimenta `htf_conflict_1w_1d`, no el score ponderado.)*

---

## Síntesis y orden de trabajo propuesto

### Ahora, durante la recogida — categoría (A), nada toca la decisión

1. **Backup diario de la BBDD** (H1) — `VACUUM INTO` + rotación 7 días. Es el único hallazgo con
   pérdida irreversible detrás.
2. **Aviso de recogida caída** (H2) — chequeo diario de análisis esperados vs registrados.
3. **`deploy.sh` sincroniza `scripts/`** (H3).
4. **Persistir `deduped_by_veto` + arreglar el nombre de `contradictions_raw_count`** (M1) —
   hacerlo antes de que dispare el primer veto, o se pierde su telemetría.
5. **Mostrar `missing_confirmations`, `conviction` y `contradiction_codes` en el modal** (M4) —
   frontend puro, y es el material con el que se va a razonar en el checkpoint.

### En el checkpoint — categoría (B), decisiones de fondo

6. **C3 + C1 · Recalibrar `cvd_strength` por timeframe — lo primero de todo.** Un corte fijo del
   2 % cae sobre la mediana del 4h (1,99 %) y deja el bucket `strong` vacío por encima de 1h. Con
   percentiles por TF (p. ej. terciles de la distribución histórica) el campo pasaría a
   discriminar de verdad, y con él se desbloquean en cascada: la puerta `volume>=+1` (C3), la pata
   CVD del veto (C1) y el bloque `volume` de las contradicciones (C2).
7. **C2 · Decidir qué hacer con CONVICTION DECAY.** Con 3 bloques y umbral `>=3`, la puerta exige
   unanimidad. O baja a `>=2`, o se acepta que solo actúa en casos extremos — pero la decisión
   tiene que ser consciente, no un efecto colateral del dedupe.
8. **H4 · Podar del prompt las secciones inertes para SOL** (~61 líneas).
9. **M2 · Retirar `buy_pressure_pct` del dataset.**
10. **B1 · Revisar la relación prompt/datos** a la luz de H3.

### Recomendación sobre la recogida en curso

**No la pares.** Los hallazgos no invalidan la muestra: C1 y C2 describen puertas que *no actúan*,
así que los análisis recogidos siguen siendo observaciones válidas del juicio del LLM — que ahora
sabemos que es lo **único** que está decidiendo.

Pero sí conviene **reencuadrar qué se está midiendo**: la recogida no está midiendo un sistema de
gating (ese está inerte), está midiendo **a Opus 4.8 analizando SOL con un prompt de 733 líneas**.
Y la pregunta del checkpoint deja de ser *"¿el gate sobre-filtra?"* para ser *"¿este modelo, con
este prompt, es capaz de decir algo distinto de Esperar?"*.

El cron B oportunista, a la luz de C1, **está cazando fantasmas**: sus dos condiciones de máxima
prioridad (`veto_long/short`, `data_insufficient`) no pueden activarse. Sus otras dos (OI > +3 %,
movimiento > 5 %) sí, y siguen valiendo. Merece la pena dejarlo, pero sabiendo que su valor real
es la mitad del previsto.
