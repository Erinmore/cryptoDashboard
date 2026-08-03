# Fase 0 — ¿existe una señal direccional determinista? · ESPECIFICACIÓN PRE-REGISTRADA

---

## ▶ RESULTADO — ejecutada el 2026-08-03 · **NO-GO**

`backend/scripts/auditDirectionalBias.mjs` · 4h · 90 d · horizonte 24 h · barreras 2×/1× ·
1.033 anclas (348 SOL · 343 BTC · 342 ETH) · IC de Wilson sobre anclajes disjuntos.

| Brazo | SOL | BTC | ETH |
|---|---|---|---|
| **A · azar** | 23,4 % [13,6–37,2] | 26,7 % [16,0–41,0] | 15,9 % [7,9–29,4] |
| **B · BIAS** | **16,3 %** [8,1–30,0] | **11,6 %** [5,1–24,5] | **15,6 %** [7,7–28,8] |
| **C · deriva** | 27,3 % [16,3–41,8] | 19,0 % [10,0–33,3] | 16,3 % [8,1–30,0] |
| **D · oráculo** | 39,5 % | 52,6 % | 55,0 % |

**Veredicto según el criterio pre-registrado: NO-GO en las tres monedas.** El punto del bias
queda **por debajo del azar en 3 de 3** y **no supera a la deriva en ninguna**. La condición de
NO-GO escrita antes de ejecutar era exactamente *"el punto de `bias_full` no supera a C"*.

**Lo que NO dice:** que los brazos sean estadísticamente distinguibles. Los IC solapan (n_ef
43-45), así que esto no demuestra que el bias sea *peor* que el azar — demuestra que **no hay
ninguna evidencia de que sea mejor**, que es lo que hacía falta para justificar el rediseño.

**Cinco lecturas que sobreviven:**

1. **El techo es alto: el oráculo saca 39,5-55,0 % contra un azar del 16-27 %.** El juego es
   ancho — hay mucha señal direccional disponible. Lo que no la encuentra son estos sumandos.
2. **In-sample y aun así pierde.** El sumando de derivados se calibró sobre estos mismos 90
   días; el sobreajuste sólo puede INFLAR la cifra. Perder en su propia ventana de ajuste es
   el resultado más contundente posible.
3. **No es culpa de un solo sumando.** `bias_klines` (sin derivados) da 16,7 / 11,6 / 15,6 y
   `bias_noexec` (sin ejecución) 20,0 / 18,8 / 21,2 — todas por debajo del azar.
4. **`|bias| = 1` es activamente MALO** (9,1 / 12,9 / 16,1 %) y es la mayoría de los casos
   (36-38 %). La monotonía existe en SOL (9,1 → 27,3 → 44,4) y en ETH (16,1 → 23,1 → 27,3),
   pero se rompe en BTC (12,9 → 23,5 → 21,4) y los n_ef de `|bias|>=3` son 9-14.
5. **K2 confirma C8 en vivo:** el bias sale bajista con más frecuencia que alcista en las tres
   (BTC 44,3 % vs 26,8 %), consistente con la asimetría medida del proxy de volumen.

**Contra-periodo: no se ejecuta, y no hace falta.** Sólo aplicaría a `bias_klines`, que ya
pierde **dentro** de muestra; una ventana fuera de muestra no puede rescatar eso.

> ⚠️ **Bug encontrado durante la ejecución, y lo cazó un control.** El brazo del azar daba
> 8,5 % contra el 24,1 % de la mezcla exacta. Causa: la dirección se alternaba por paridad del
> índice y la cadena disjunta toma 1 de cada 6 anclas (24 h ÷ 4 h) → **dirección constante
> dentro de la cadena**. Es el mismo BLOQUEO DE FASE que documentó `auditVolatilityState`
> (muestrear 1h con paso de 168 velas = 7 días exactos → 85,6 % `squeeze`). Corregido con un
> hash del instante. **Sin el control de la mezcla exacta, este informe habría publicado un
> azar del 8,5 % y el bias habría "ganado" por 8 puntos.**

**Consecuencia para el backlog:** el cubo 0 de
[`REORIENTACION_LISTA_CERRADA.md`](REORIENTACION_LISTA_CERRADA.md) **no se archiva por
rediseño** — hay que decidirlo por otra vía. Y el producto direccional con ventaja medida
**no está justificado hoy**.

---

> **Estado:** borrador para aprobación. **Nada de esto se ejecuta hasta que los criterios de
> decisión de §5 estén aceptados.** Escribir el criterio antes de ver el número es lo que ha
> salvado cuatro mediciones de este proyecto; es también lo único que impide que la fase 0
> se convierta en una búsqueda de la variante que gana.
>
> **Fecha:** 2026-08-03 · **No toca la ruta de decisión, ni la BBDD, ni la muestra en curso.**

---

## 0. La pregunta, y lo que NO se pregunta

**Pregunta única:** *¿un dictamen direccional continuo (`bias`), calculado por el backend con
funciones deterministas sobre datos históricos, acierta más que (a) elegir dirección al azar y
(b) seguir la deriva reciente del precio?*

Si la respuesta es no, el rediseño hacia un producto direccional **no se hace**, y se ahorra el
punto cero más grande del proyecto. Si es sí, el rediseño tiene permiso medido.

**Lo que esta fase NO responde**, y conviene tener escrito para que nadie se lo atribuya después:

- No dice si el LLM aporta algo. El `bias` de esta fase es 100 % backend; la aportación del
  modelo solo se puede medir con muestra viva, y el proyecto ya midió que eso es una pregunta
  de **meses** (~181 resueltos para una ventaja moderada, a 0,4-0,7 resueltos/día).
- No calibra pesos. V1 va con pesos iguales, deliberadamente (§3.2).
- No valida la geometría de entrada/salida ni el `risk_score`. Son otras dos preguntas, con sus
  propias mediciones pendientes.
- No mide la accionabilidad. `actionable` sigue siendo un booleano con setup y sigue siendo raro.

---

## 1. Hallazgos de la revisión del código que CAMBIAN el diseño

Esto es la parte crítica del documento. Cinco de estos ocho puntos invalidan algo que se daba
por bueno al plantear la fase.

### 1.1 · ⚠️ El ancla de 26,5 % tiene un IC que NO se puede usar como referencia

La cifra viene de [`auditPathWinRate.mjs:232`](../backend/scripts/auditPathWinRate.mjs#L232):

```js
const pool = wilsonInterval(r.up.win + r.down.win, dU + dD);
```

Dos problemas independientes en ese `n`:

**(a) Los anclajes se solapan.** Son anclas cada 4 h con horizonte de 24 h: comparten 5/6 de su
futuro. Es exactamente el fallo que `lib/disjointAnchors.mjs` existe para evitar — y ese módulo
se escribió **el día siguiente** (A8, 03-08), así que nunca se aplicó aquí. Infla el SE ~√6.

**(b) Cada ancla entra DOS veces**: una como `Comprar` y otra como `Vender`, sumadas en un solo
denominador. Esto, curiosamente, empuja al revés: el propio ancla A1 del script demuestra que
**a lo sumo una de las dos direcciones puede ganar**, o sea que el par está negativamente
correlacionado y la varianza real de la proporción es *menor* que la que asume Wilson (factor
≈0,64 en varianza con p≈0,265, o ≈0,8 en SE).

**Neto: el intervalo publicado `[24,7 – 28,3]` es demasiado estrecho, del orden del doble en
SE.** El **punto** (26,5 %) es un estimador correcto y se conserva; **el intervalo no es
utilizable como criterio de separación**. Si la fase 0 compara el IC del bias contra ese IC,
declarará ventaja donde no la hay.

> **Acción:** la fase 0 **recalcula sus tres baselines con `disjointRate`**, sobre la misma
> población de anclas que el bias. El 26,5 % publicado se usa solo como control de cordura del
> punto, no como referencia de decisión.

### 1.2 · ⚠️ No hay validación fuera de muestra posible para el sumando de derivados

La rúbrica de `derivativesScore.js` lo admite en su propia cabecera: *"Está ajustada sobre los
mismos 90 días con los que se mide: sin validación fuera de muestra"*. Y el contra-periodo, que
es como el proyecto ha validado todo lo demás (`OFFSET_DAYS`), **es imposible aquí**: Coinalyze
sirve **90 días y ni uno más** — es el límite duro citado en la propia rúbrica.

Consecuencia dura: **cualquier medición del bias que incluya derivados es in-sample por
construcción, hoy y siempre**, mientras la fuente de OI sea Coinalyze.

> **Acción:** la fase 0 mide **dos bias**, no uno:
> - **`bias_full`** — incluye derivados. In-sample. Es la cota optimista.
> - **`bias_klines`** — solo volumen + ejecución (todo derivable de klines públicas). **Sí
>   admite contra-periodo** (`OFFSET_DAYS=270`, la misma ventana que usó `auditPathWinRate`).
>
> Si solo gana `bias_full` y solo en el periodo de ajuste, esa es la **firma exacta del
> sobreajuste** y el veredicto es NO-GO. Si `bias_klines` gana también fuera de muestra, hay
> señal real aunque sea pequeña.

### 1.3 · ⚠️ La muestra efectiva es de ~58 días, no de 90 — y eso decide qué puede concluir la fase

Tres recortes encadenados sobre los 90 días:

| Recorte | Origen | Efecto |
|---|---|---|
| Coinalyze sirve 90 d | límite de la API | 90 d |
| Calentamiento de la mediana de liquidaciones | `cascade_min_points: 620` (~26 d) descarta anclas | **~58-60 d** |
| Independencia (ventanas de 24 h disjuntas) | `disjointChain` | **~58 anclas/moneda** |

Con 3 monedas son **~174 anclas independientes**, y solo entran al numerador las que tengan
`|bias| >= 1`. A p≈0,30 y n=174 el IC de Wilson es de **±7 puntos**; con n=87 (si el bias habla
la mitad del tiempo), **±10**.

> **Consecuencia que hay que aceptar ANTES de ejecutar: la fase 0 solo puede detectar un efecto
> GRANDE.** Un `INCONCLUSO` no es un fallo del método, es el resultado más probable. Por eso §5
> define qué se decide en ese caso, y lo decide con las comprobaciones de distribución (§4),
> que sí tienen potencia con esta n.

Variante de sensibilidad declarada: con `NO_LIQ_GUARD=1` la cascada se abstiene y se recuperan
los 90 días completos (~90 anclas/moneda). Se reporta como **secundaria**, porque deja de ser la
rúbrica de producción.

### 1.4 · ⚠️ Los dos ATR% vuelven a morder — y aquí decidirían el resultado

Es B1 por tercera vez, y esta vez no es cosmético:

| Uso | Ventana | Dónde |
|---|---|---|
| Banda del eje OI×precio (**decisión**) | **180 velas** | `calculateATR(w4h)` en [`auditGateConjunction.mjs`](../backend/scripts/auditGateConjunction.mjs) |
| Barreras del win-rate (**puntuación**) | **19 velas** (`ATR_PERIOD+5`) | `calculateATR(prev, 14)` en [`auditPathWinRate.mjs:188`](../backend/scripts/auditPathWinRate.mjs#L188) |

El ATR de Wilder es recursivo: con 19 velas la semilla aún domina y con 180 ha convergido. Son
dos números distintos con el mismo nombre.

> **Acción — regla no negociable de la fase 0:** las barreras de puntuación usan **el ATR de 19**,
> porque es el que produjo el 26,5 % y el que usa `atr_pct_at_analysis` en producción. La banda
> de la rúbrica usa **el de 180**, porque es el que calibró la constante `0,5×`. **Ambos se
> nombran explícitamente en el código de la fase** (`atrPct__decision_180` /
> `atrPct__outcome_19`). Mezclarlos invalidaría una de las dos constantes en silencio.

### 1.5 · ⚠️ `Structure` no tiene dueño determinista, y el proxy obvio cuenta TRES veces

De los cuatro scores, solo dos son reproducibles hoy:

| Score | ¿Determinista? | Nota |
|---|---|---|
| **Derivatives** | ✅ `computeDerivativesScore` | Rúbrica medida (in-sample, §1.2) |
| **Volume** | ⚠️ Proxy `expectedVolumeScore` | Conservador: se abstiene ante divergencia y ante `marginal` |
| **Structure** | ❌ **No existe** | En el prompt es prosa: *"+2 = estructura alcista limpia"*. Mismo defecto que Execution pre-v8_0 y Derivatives pre-v9_0 |
| **Execution** | ✅ Reproducible exacto | v8_0 lo convirtió en 5 votos con umbrales explícitos y tabla suma→score |

Y la trampa: el proxy natural para Structure sería `computeTrend`, pero **`computeTrend` pondera
ADX+SuperTrend (50 %), RSI+MACD+WaveTrend+StochRSI (30 %) y volumeDelta (20 %)** — o sea que
contiene **4 de los 5 votos de Execution** y **solapa con el sumando de volumen**. El propio
prompt lo prohíbe explícitamente: *"NO lo re-puntúes aquí — esos osciladores pertenecen al
Execution Score"*.

> **Acción:** `bias` v1 tiene **tres sumandos, no cuatro**: derivados + volumen + ejecución.
> **Structure queda fuera y se declara como hueco conocido.** Meterlo vía `computeTrend` sería
> triple conteo — exactamente la regla B1 que dos auditorías red-team se dedicaron a imponer.

### 1.6 · ⚠️ La rúbrica de Execution nunca se ha medido contra resultados

Es reproducible, pero sus constantes (RSI 55/45, la tabla `+4/+5 → +2`, los cortes de StochRSI
y WaveTrend) **se escribieron a mano en v8_0 y jamás se contrastaron contra outcomes**. Son la
misma clase de constante que la regla del proyecto prohíbe.

> **Acción:** se mide su contribución marginal explícitamente (`bias` con y sin el sumando de
> ejecución). Si el bias solo funciona con Execution dentro, el hallazgo no es "hay señal" sino
> "hay que medir Execution", y eso es otra fase.

### 1.7 · ⚠️ El bias comparte una variable con el baseline de deriva, por construcción

`priceChange24hPct` **es uno de los dos ejes** del cuadro OI×precio. O sea que el sumando de
derivados es en parte una función del momentum de 24 h. Y `auditPathWinRate` ya midió que la
asimetría Comprar−Vender **cambia de signo con la deriva** del periodo (−1,03 % → gana `Vender`
por 5,9 pt; +0,64 % → gana `Comprar` por 7,4 pt, coincidiendo el signo en las 4 celdas).

Súmale C8: `expectedVolumeScore` sale negativo ~2× más que positivo (30,2 % vs 16,2 % en BTC),
propiedad del **dato**, no del código (simetría demostrada al 100,00 % en 50.552 ventanas).

> **Un bias inclinado a bajista, medido en un periodo bajista, ganará sin aportar nada.** El
> baseline de deriva (§3.3) es obligatorio, y el reparto direccional del propio bias se reporta
> siempre al lado del win-rate.

### 1.8 · ⚠️ Nunca comparar el subconjunto seleccionado contra la base global

Cuando el bias habla (`|bias| >= 1`) está seleccionando anclas — probablemente las más
tendenciales o volátiles. Comparar ese subconjunto contra el 26,5 % **global** es el mismo error
que A8 corrigió al exigir comparar cada celda contra **su complemento** y no contra la base (la
base contiene al subconjunto → los intervalos comparten observaciones).

> **Acción:** los tres baselines se calculan **sobre el mismo subconjunto de anclas** en el que
> se evalúa el bias, ancla por ancla. Se reporta además el complemento (`|bias| = 0`).

---

## 2. Población de anclajes

| Parámetro | Valor | Por qué |
|---|---|---|
| Monedas | SOL, BTC, ETH | Réplica en signo entre 3 monedas es el test real; el IC conjunto es optimista (comparten factor mercado) |
| TF primario | **4h** | El de producción; el episodio, la vigencia y la banda dependen de él |
| Ancla | Cierre de cada vela 4h | Igual que `auditGateConjunction`; el análisis ocurre al cierre |
| Ventana | 90 d, recortada a ~58 por `cascade_min_points` | §1.3 |
| Contra-periodo | `OFFSET_DAYS=270` | **Solo aplicable a `bias_klines`** (§1.2) |
| Independencia | `disjointChain`, `horizonSec = 24 h` | Recorriendo todos los arranques (`stride`), reportando `n_ef` y el rango |
| Horizonte | **24 h** primario · 7 d secundario | El de 7 d discrimina mal (67-69 % en el par por defecto) |
| Barreras | `opportunityParamsFor(24)` = 2×/1× ATR | Sin múltiplos nuevos: la rejilla persistida solo tiene 0.5/1/1.5/2/3/4 |
| Censura | `now: null` **explícito** | Historia cerrada. Omitirlo ya rompió dos scripts en silencio |

**Fidelidad a producción:** se heredan íntegras las decisiones ya verificadas en
`auditGateConjunction.mjs` (ventanas 180/90, `taker_buy_base` del índice 9, referencia de 24 h
en la vela `i-5` y no `i-6`, redondeo del ATR% con `toFixed(2)`, ventana de liquidaciones de 30 d
terminada en el ancla, sin lookahead en ningún eje). **No se reimplementa ninguna regla**: se
importan las funciones reales del backend.

---

## 3. Los cuatro brazos — todos sobre las MISMAS anclas

### 3.1 · Brazo A — Azar (piso)
Mezcla exacta de ambas direcciones, sin RNG (sortear añadiría ruido a un número calculable).
**Recalculado con `disjointRate`** (§1.1). Control de cordura: el punto debe caer cerca del
26,5 % publicado y por debajo del techo teórico de ruina del jugador (33,3 % a 24 h).

### 3.2 · Brazo B — `bias` (el sujeto)

```
bias = derivatives + volume + execution        (pesos iguales, sin constantes nuevas)
dirección = signo(bias);  se evalúa solo si |bias| >= 1
```

Tres variantes pre-registradas, **una sola primaria**:

| Variante | Sumandos | Contra-periodo | Papel |
|---|---|---|---|
| **`bias_full`** ← **PRIMARIA** | derivados + volumen + ejecución | ❌ imposible | Cota optimista, in-sample |
| `bias_klines` | volumen + ejecución | ✅ sí | **La única falsable fuera de muestra** |
| `bias_noexec` | derivados + volumen | ❌ | Aísla el aporte de Execution (§1.6) |

Pesos iguales **a propósito**: si hace falta afinarlos para que funcione, con esta n se estaría
ajustando ruido — y A8 ya avisó de que los lifts por bloque no se separan con 90 días.

### 3.3 · Brazo C — Deriva (el baseline que de verdad importa)
`dirección = signo(priceChange24hPct)`, la misma variable que alimenta el eje de la rúbrica.
Es el rival real: **si el bias no bate a esto, es una forma cara de escribir momentum.**

### 3.4 · Brazo D — Oráculo (techo)
Por ancla, la mejor dirección posible según `classifyPathOutcome`. Acota **el ancho entero del
juego**. No se puede derivar restando el 34,8 % de oportunidad al 26,5 % del azar: **están sobre
denominadores distintos** (`offered` sobre todas las anclas evaluables; el win-rate sobre
`win+loss`, excluyendo `flat`). Hay que medirlo, no calcularlo.

> Si el techo del oráculo queda cerca del azar, ninguna ingeniería posterior arregla nada y la
> fase 1 se archiva sin discusión.

---

## 4. Controles obligatorios — se ejecutan ANTES de mirar ningún win-rate

Si alguno falla, el número de arriba no significa nada. En este proyecto todos estos han fallado
al menos una vez.

| # | Control | Qué invalidaría |
|---|---|---|
| **K1** | **¿Habla el bias?** Reparto de `|bias|` = 0/1/2/3+ | Si `|bias| >= 1` sale <5 %, es **rama muerta** y no hay nada que medir (fallo T1, y el propio Derivatives Score al 0,0 %). Esperado a priori: el eje OI calla el ~70 % del tiempo |
| **K2** | **Balance direccional** del bias, por moneda | Un bias que dice `Vender` el 80 % del tiempo en un periodo bajista gana por deriva (§1.7) |
| **K3** | **Identidad A1**: `wins(C) + wins(V) == offered` | Descuadre = bug en `classifyPathOutcome` o en `classifyOpportunity` |
| **K4** | **Guarda de solape viva** (`disjointChain`) | Un IC estrecho sin aviso externo es indistinguible de uno correcto |
| **K5** | **Contador de empates vivo** | Un 0 por rareza y un 0 por bug se parecen demasiado (control de rama muerta del propio `auditPathWinRate`) |
| **K6** | **Cobertura de anclas por brazo** | Los cuatro brazos deben evaluarse sobre el MISMO conjunto (§1.8) |
| **K7** | **Sensibilidad OI apertura-a-cierre vs cierre-a-cierre** | Ya parametrizado en `auditGateConjunction`; verifica que la cifra no es artefacto de esa elección |
| **K8** | **Réplica en signo en las 3 monedas** | El IC conjunto es optimista; la réplica es el test que el proyecto ha usado siempre |

---

## 5. Criterios de decisión — ESCRITOS ANTES DE EJECUTAR

**Métrica primaria:** win-rate de `bias_full` sobre anclas con `|bias| >= 1`, horizonte 24 h,
con IC de Wilson sobre anclajes disjuntos, **contra los brazos A y C calculados sobre esas
mismas anclas**.

**Una sola especificación primaria.** Todo lo demás (7 d, `bias_klines`, `bias_noexec`,
`NO_LIQ_GUARD=1`, cortes de `|bias|`) es **exploratorio y se etiqueta como tal**. Con 15 scripts
de auditoría y cultura de probar variantes, si se prueban ocho definiciones contra el azar, una
gana por casualidad.

| Veredicto | Condición | Qué se hace |
|---|---|---|
| **GO** | El IC de `bias_full` **no solapa** con el de A **y** el punto supera a C, **y** el signo replica en las 3 monedas, **y** `bias_klines` mantiene el signo en el contra-periodo | La fase 1 tiene permiso medido. Se cierra su lista **después**, no antes |
| **NO-GO** | El punto de `bias_full` **no supera a C** (deriva), **o** solo gana `bias_full` y `bias_klines` se cae fuera de muestra | Firma de sobreajuste (§1.2). El rediseño direccional se **archiva** y el producto pasa a ser contexto + geometría condicional |
| **INCONCLUSO** | Los IC solapan pero el punto va en la buena dirección y replica | **El resultado más probable** (§1.3). *No* se construye a ciegas y *no* se archiva: se decide con K1/K2 (¿habla?, ¿está balanceado?) y se define qué muestra viva haría falta |
| **ABORTO** | Falla K3 o K4 | Bug. Se arregla y se repite. No se interpreta ningún número |

> **La monotonía manda sobre el punto.** Si `|bias| = 2` no acierta más que `|bias| = 1`, el
> bias **no ordena**, y entonces su signo da igual por bueno que salga el agregado. Con esta n
> el test es de baja potencia, así que cuenta como **evidencia de apoyo, nunca como prueba** —
> pero una inversión clara de la monotonía sí es motivo de NO-GO por sí sola.

---

## 6. Lo que la fase 0 no podrá decir, pase lo que pase

Escrito aquí para que no se le pidan estas respuestas después:

1. **Si el LLM aporta.** Requiere muestra viva y es cuestión de meses.
2. **Si el sumando de derivados generaliza.** Imposible fuera de muestra con Coinalyze (§1.2).
   La única validación posible es el periodo de recogida posterior.
3. **Si `Structure` aportaría.** No existe como función determinista (§1.5).
4. **Si Execution está bien calibrado.** Sus constantes nunca se midieron (§1.6).
5. **Nada sobre `risk_score` ni sobre la vigencia declarada** — los otros dos números del
   producto pedido, hoy sin dueño medido. Son fases propias.

---

## 7. Entregable y coste

- **Script:** `backend/scripts/auditDirectionalBias.mjs`, solo lectura. Sin BBDD, sin LLM, sin
  API keys nuevas (`COINALYZE_API_KEY` ya está en `.env`). Importa las funciones reales del
  backend y reutiliza `lib/disjointAnchors.mjs`; **no reimplementa ninguna regla**.
- **Reutilización:** ~80 % del arnés ya existe en `auditGateConjunction.mjs` (replay fiel de la
  rúbrica, vetos y proxy de volumen sobre 90 d × 3 monedas, con todas las trampas de lookahead
  ya resueltas y documentadas).
- **Salida:** una tabla por moneda + agregado, con los cuatro brazos, sus `n_ef`, sus IC, el
  rango entre arranques de cadena, y los ocho controles de §4 impresos **antes** que cualquier
  win-rate.
- **Coste:** una tarde. 0 € de API. No invalida la muestra en curso ni exige punto cero.

---

## 8. Recomendación de secuencia

1. Aprobar (o corregir) **§5** — los criterios. Es el único paso que no se puede hacer después.
2. Ejecutar `0-bis` en paralelo: **recoger BTC y ETH ya**. No toca la ruta de decisión, dobla la
   muestra viva y es la única vía para las preguntas que C3 declaró inmedibles con una moneda
   (cada moneda dispara **una sola dirección** del veto en 90 días).
3. Escribir y ejecutar el script.
4. Decidir la fase 1 **con el resultado delante**, cerrando su lista entonces.
