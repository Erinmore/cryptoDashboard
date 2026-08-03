# Reorientación — lista cerrada del punto cero 6

> **Estado:** ✅ **ACORDADO Y EN EJECUCIÓN.** La v1 del producto está **entregada y desplegada**;
> lo que queda está congelado a propósito (§7-bis). La regla de §0 sigue mandando: **un solo
> punto cero, lista cerrada ANTES de empezar** — y de momento **no ha hecho falta ninguno**.
>
> **Fecha:** 2026-08-03 (macro-sesión) · Muestra del periodo 5 declarada **cumplida** (§0).
> · **Relato cronológico y motivo de la reorientación:** [`SESSION_STATE.md` §0-R](../SESSION_STATE.md)
> · **Porqué histórico de cada ítem:** `SESSION_STATE.md` §0 y §6
> · Aquí está el **qué, en qué orden, con qué requisito previo y en qué estado**.

---

## 0. Por qué la muestra en curso se da por cumplida

No es impaciencia: es que las tres preguntas más caras ya tienen respuesta, y seguir daría más
ejemplos del mismo hallazgo.

| Pregunta | Respuesta obtenida | Con qué |
|---|---|---|
| **D6** · ¿es `has_executable_setup` una cuarta puerta? | **No: es la sombra de las otras tres.** Gatillo y puertas no han coincidido **ni una vez en 11**, y hay mecanismo | 11 análisis + velas 4h reales |
| **C1** · ¿es el prompt el cuello de botella? | **Desmentida.** El modelo no está impedido; el estado que cumple el gatillo es un estado donde la rúbrica es muda | idem |
| **A8-bis** · ¿aguanta la rúbrica en muestra viva? | **8 de 11 `no_signal`** (calca el 69,4 % histórico) · `new_money_long` **0 de 11**: la única puerta de compra no se ha ejercitado | idem |

**Lo que sobrevive al punto cero** (son hechos de mercado, no decisiones): `history_series`
completo —incluida la serie horaria sembrada hoy, que la API ya no servirá dentro de 90 días—,
las métricas de recorrido, las excursiones y los clusters. **Lo que muere:** las decisiones, sus
scores y sus outcomes. Nada de esto exige volver a pedir un dato a ninguna API.

---

## 1. Dos permisos que NO son el mismo

La confusión más cara posible en este momento:

- **Punto cero** = permiso para **tocar la ruta de decisión** e invalidar la muestra.
- **Regla de calibración** = ninguna constante de corte se escribe sin medir antes su
  distribución. **Un punto cero NO levanta esta regla.**

Varios ítems de abajo son "cinco líneas de código **más una medición**". El coste real está en la
medición, y por eso el cubo 2 existe.

---

## 1-bis. ▶ RE-ORDENACIÓN TRAS LA FASE 0 (2026-08-03, mismo día)

La fase 0 salió **NO-GO** (detalle en [`FASE_0_BIAS_ESPECIFICACION.md`](FASE_0_BIAS_ESPECIFICACION.md)),
y eso cambia tres cosas de esta lista. **Manda esta sección sobre las de abajo.**

**(a) El cubo 0 NO se archiva.** Se iba a evaporar si `bias` sustituía a las puertas
conjuntivas; sin rediseño direccional, sus cinco ítems siguen vivos y hay que decidirlos por
otra vía. Pero **bajan de prioridad**: son ajustes a una ruta de decisión que ya no es el
titular del producto.

**(b) El producto honesto NO EXIGE PUNTO CERO.** Es la consecuencia más importante y no era
obvia. Lo que describe el §6 (lectura + geometría condicional + los tres números medidos +
el registro del shadow trade en la misma pantalla) es **presentación de cosas que el backend
ya calcula y ya persiste**. No mueve un umbral, no cambia una puerta, no toca la rúbrica.
Se puede construir **sin invalidar nada** — y por tanto sin esperar a cerrar ninguna lista.

**(c) Se re-clasifican por "¿lo necesita el producto?" y no por coste.**

| Ítem | Antes | Ahora | Por qué |
|---|---|---|---|
| ~~**B3**~~ vigencias | punto cero, fontanería | ✅ **HECHA** (era 🔼 alta) | "Válido hasta X" pasa a ser una promesa VISIBLE en el panel principal |
| **P3** `SHADOW_FILL_RULE` | condicional | ⏳ **desbloqueado, espera muestra** (era 🔼 alta) | El registro del shadow trade se enseña; su regla de llenado no puede diferir en silencio de lo que se le pide al usuario |
| ~~**P1**~~ `risk_score` | necesita rúbrica medida | ✅ **RETIRADO del panel** | Lleva un 7 en los 4 últimos análisis y no tiene regla. Con el producto nuevo se sustituye por lo YA medido (equilibrio del R:R, ATR% para tamaño) en vez de inventarle una rúbrica |
| **B5** refactor controller | "sólo si el punto cero es largo" | ↔️ **Sigue justificado, por otro motivo** | El punto cero se encogió, pero el controller es donde se ensambla la respuesta y el producto nuevo lo toca igual |
| **B1** dos ATR | punto cero firme | ↔️ **Sube en riesgo** | Los números del panel salen del ATR de 19 y la banda del de 180. En pantalla, dos ATR con el mismo nombre es un peligro de correctitud visible |
| ~~**P5**~~ retirar `Preparar` | bloqueado por A3 | ✅ **HECHO** (`v9_1_no_preparar`) | L2 (versionado por fila) se hizo hoy |
| **B2**, **B4**, **F1** | punto cero | 🔽 **Baja** | Correctitud real, sin impacto en el producto. Se agrupan para cuando toque |
| **Cubo 0** entero | se evapora | 🔽 **Baja, y sin decisor** | Ya no lo resuelve el rediseño |

**(d) Entran dos mediciones nuevas, M8 y M9**, definidas en §4 (un solo dueño por ítem).
▸ **Las dos se ejecutaron el mismo día.** M8 se reformuló al escribirla —la pregunta literal ya
estaba contestada— y M9 salió **NO-GO**, cerrando lo direccional por segunda vía independiente.

---

## 2. CUBO 0 — ~~Se evaporan si el rediseño va adelante~~ · 🔽 VIVOS Y DESPRIORIZADOS

> ⚠️ **ACTUALIZADO: la fase 0 (M6) YA SE EJECUTÓ y salió NO-GO**, así que estos cinco ítems **no
> se evaporan** — el rediseño direccional que los habría disuelto no va. Siguen vivos, pero
> **despriorizados**: son ajustes a una ruta de decisión que ya no es el titular del producto.
> La columna de abajo conserva el argumento original por el que se habrían evaporado.

| # | Ítem | Por qué se evapora |
|---|---|---|
| **D6/C1** | La fila bajista muda cierra `sell_gate` | Un 0 en una **suma** no cierra nada. El bloqueo por identidad desaparece |
| **C4** | Puerta de contradicciones `>=3` → `>=2` | La puerta desaparece si las contradicciones pasan a **descontar confianza** |
| **C7** | ¿Debe poder venderse una caída ordenada? | Misma disolución. Ya medido además que el mercado no da señal para venderla (+2,1 pt, IC cruzando la base) |
| **C9** | 6ª contradicción (depende de scores del LLM) | Cambia de naturaleza: con el score en backend deja de ser inmedible |
| **C5** | Refuerzo de la puerta de COMPRA con OI condicionado | Deja de ser "abrir una puerta" y pasa a ser **el peso de un sumando** — otra pregunta, con otra medición |

**Decisor:** era la fase 0 (M6) → **ejecutada, NO-GO**. Congelados en §7-bis, sin decisor nuevo.

---

## 3. CUBO 1 — LIBRES · se hacen ya, no gastan punto cero

Aditivos, telemetría o fuera de la ruta de decisión. No invalidan nada.
**Estado al 2026-08-03: L1 y L2 hechos. Quedan L3 (1 min), L4 y L5.**

| # | Ítem | Coste | Nota |
|---|---|---|---|
| ~~**L1**~~ ✅ | **Renombrar `liquidations` → `liquidations_1d`** (+ `addLiquidationsDailyEntry`, clave de `LIMITS`, comentario de `db.js`) con **migración de datos idempotente** inline en `db.js` | 30 min | **Riesgo nulo verificado**: nadie lee esa métrica de vuelta (`loadSeries` sólo se invoca para CVD/VWAP) → es archivo write-only. Se hace porque `liquidations` junto a `liquidations_1h` es la trampa de nombres que ya mordió 4 veces (`top_long_clusters`, `longs_usd` en monedas, dos `atr_pct`, dos `regime`) |
| ~~**L2**~~ ✅ | **A3 · Versionado por fila** (`gate_version`, `rubric_version`, `feature_version`) | bajo | **Prerrequisito del propio rediseño**: sin esto, comparar el antes y el después es arqueología de commits. Y es lo que permite retirar `Preparar` sin romper las filas viejas |
| **L3** ⏳ | **A9 · Verificar clusters en vivo** (`reconstructed = 0` en el próximo análisis) | 1 min | Las 100 filas actuales son reconstruidas; el camino en vivo no se ha ejercitado |
| **L4** ⏳ | **Lecciones aprendidas** — extraer de CLAUDE.md/SESSION_STATE las **constantes medidas con su alcance y fecha**, y las **retractadas** | medio | Ver §7. Lo reutilizable son los números y su scope, no la narrativa |
| **L5** ⏸️ | **A4 · Observatorio** (consolidar `/api/outcome/stats` + modal + `auditStats`) | medio | Valor real cuando haya dos periodos que comparar → **después** |

---

## 4. CUBO 2 — MEDICIONES PREVIAS · solo lectura, habilitan el cubo 3

Todas se pueden ejecutar **hoy, con la Pi corriendo**, sin comprometer nada. Cada una es
requisito de un ítem concreto: sin ella, ese ítem no se puede escribir.

| # | Medición | Habilita | Notas |
|---|---|---|---|
| ~~**M6**~~ | **FASE 0** · ¿bate el `bias` determinista al azar **y a la deriva**? Cuatro brazos: azar, bias, deriva, oráculo | **Todo el cubo 0** + la decisión de rediseño | ✅ **EJECUTADA · NO-GO en 3 de 3.**  Espec., resultado y criterios en [`FASE_0_BIAS_ESPECIFICACION.md`](FASE_0_BIAS_ESPECIFICACION.md). ⚠️ Su §1.1 documenta un hallazgo que sigue vivo: **el IC del 26,5 % publicado en `auditPathWinRate` está mal calculado** (doble conteo + solape) y se rehízo con `disjointRate` sólo dentro de la fase 0 — **el script original no está corregido** |
| **M1** | **Huecos de la ventana rodante**: comparar ventana **posicional** (24 velas) contra **temporal** (`[t-24h, t)`, huecos = 0) sobre los 88 días horarios ya archivados | El arreglo de los huecos (F1) | **Posible desde hoy** gracias a `liquidations_1h`. Predicción firmada: la posicional infla las ventanas tranquilas → sube la mediana → **hace la cascada más difícil de disparar**. Numerador y denominador se inflan a la vez, así que el cociente cancela en parte |
| **M5** | **Re-medir los cortes de la cascada** (`cascade_magnitude_mult: 2`, `cascade_skew_max: -0.5`) sobre la ventana corregida | idem (F1) | Se calibraron con la implementación posicional. Cambiar la ventana desplaza la distribución que bucketizan |
| **M4** | **Re-ejecutar `auditTriggerBaseRate`** sobre el eje de ATR unificado | **B1** | Cada curva medida forma pareja con su eje (`TRIGGER_BASE_RATE`↔19 velas, `TARGET_REACHABILITY`↔180) |
| **M2** | **Validar la rúbrica de Execution** contra outcomes (5 votos, RSI 55/45, tabla suma→score) | Incluir/excluir Execution del `bias` | **Nunca medida.** Escrita a mano en v8_0 — misma clase de constante que la regla prohíbe |
| **M3** | **Definir y medir `risk_score`** — hoy la única regla en todo el sistema es *"entero entre 1 y 10"* | **P1** | Antes de medir hay que decidir **qué magnitud es**. Ver §5 |
| ~~**M8**~~ | **Geometría de ENTRADA del producto: ¿rotura o retroceso?** (reformulada — la pregunta literal ya estaba contestada) | La forma del producto | ✅ **RESUELTA el 2026-08-03** · `scripts/auditEntryGeometry.mjs`. Resultado y método abajo (▶ M8) |
| **M10** | **La línea base de la expectativa NO es un número, es una CURVA** indexada por `anchura_de_barrera / √vigencia` | Poder enseñar `expectancy_r` en el panel | ⚠️ **Sale de M8 y es la consecuencia más importante del día.** La expectativa la gobierna la anchura de las barreras relativa a la vigencia — no la entrada, ni la dirección, ni el R:R (plano, `auditConditionalRR`). Un setup con barreras estrechas sale a −0,3R **por pura geometría**, y compararlo contra un +0,004R constante lo haría parecer un desastre siendo sólo otra forma. **Es la TERCERA curva de la misma familia**: `TRIGGER_BASE_RATE` y `TARGET_REACHABILITY` ya colapsaron con `d = distancia/(ATR%·√velas)`; ésta debe colapsar igual. ▸ **NO bloquea el producto v1 si no se enseña `expectancy_r`** (ver §7-bis) |
| **M11** | **Gradiente de entrada: ¿rotura o retroceso?** | Si el prompt debe pedir un estilo de entrada u otro | Medido en M8 con la geometría real: rotura −0,02/−0,09 · mercado +0,02 · retroceso +0,07/+0,16. Monótono y replicado, pero **ningún IC separa de 0** → sugerente. **El sistema emite el extremo peor.** Necesita más muestra o un periodo más largo, no un cambio ya |
| ~~**M9**~~ | **Condicionado a que HUBO movimiento limpio, ¿algo predice su DIRECCIÓN?** (reformulada: la versión original era una expedición de pesca, y su otra mitad —cuándo ofrece el mercado— ya la contestó `auditOpportunityRegimeCurve`) | Si el producto puede ser direccional | ✅ **RESUELTA el 2026-08-03 · NO-GO** · `scripts/auditCleanMoveDirection.mjs`. Detalle abajo (▶ M9) |
| ~~**M7**~~ | **Coste de la regla de llenado** (toque intravela vs cierre de vela) | **P3** | ✅ **HECHA el 2026-08-03** · `scripts/auditFillRule.mjs`. Resultado y consecuencia abajo (▶ M7) |

### ▶ M8 · Resultado (2026-08-03) — geometría de entrada

**Por qué se reformuló.** La pregunta literal (*"¿bate una geometría determinista a +0,004R?"*)
estaba ya casi contestada: `auditShadowBaseline` +0,004R · `auditConditionalRR` plano en R:R ·
fase 0 NO-GO. Dirección sin ventaja + parámetros sin ventaja ⇒ ≈0R. Lo que **sí** faltaba:
`auditConditionalRR` midió entradas a **RETROCESO** (`ENTRY_K=0.75` ⇒ short vendiendo más
alto), pero los `conditional_setup` reales son de **ROTURA** (entrada 0,73-1,47 % por debajo
del precio en shorts). **Se había medido la geometría opuesta a la que el producto va a
enseñar.**

**Resultado** (90 d × 3 monedas, anclas disjuntas, ambas direcciones agregadas para cancelar
deriva, con la geometría REAL de barreras 1,7×/3,4×ATR):

| Entrada | E[R] por oportunidad |
|---|---|
| **Rotura** ← lo que el sistema emite | −0,02 a −0,09R |
| A mercado | +0,02R |
| **Retroceso** | +0,07 a +0,16R |

Monótono y replicado, pero **ningún IC separa del cero → «sugerente, no establecido»** (mismo
veredicto que C3 y C5). **Lo que sí queda firme: el sistema emite sistemáticamente el extremo
PEOR del gradiente.** Seguimiento en **M11**.

**La discrepancia de 0,3R con `auditShadowBaseline`: RESUELTA, y no era un bug.** Medían
geometrías distintas. Las formas reales llevan stop a ~1,7×ATR y TP a ~3,4×ATR; la primera
versión de este script puso 1×/2×. Experimento controlado sobre las MISMAS anclas: con 1×/2×
la rotura da −0,22/−0,35R (IC excluyendo 0); con 1,7×/3,4× da −0,02/−0,09R (IC cruzando 0),
que es el +0,004R de `auditShadowBaseline`. **Los dos números son correctos, cada uno para su
geometría.** Mecanismo: barreras estrechas para la vigencia ⇒ casi todo se RESUELVE y la
asimetría 2:1 muerde (27 %×2 − 73 %×1 ≈ −0,19); barreras anchas ⇒ la mayoría **caduca**, y un
caducado renta ≈0R. **Consecuencia → M10** (la línea base es una curva, no un número).

⚠️ **Dos bugs cazados durante la ejecución, los dos por controles puestos a propósito:**
(a) el punto salía de la muestra completa y el IC de la cadena disjunta — dos muestras en la
misma línea; (b) la cadena disjunta **colapsaba a una sola dirección** (las dos direcciones de
un ancla comparten `tMs`, así que la segunda se descartaba siempre), destruyendo el control de
deriva: −0,758R contra −0,251R de la muestra completa. Misma familia que el bloqueo de fase
del brazo de azar en la fase 0.

### ▶ M9 · Resultado (2026-08-03) — **NO-GO**, y lo mató el contra-periodo

**Pregunta:** entre las anclas donde el mercado SÍ ofreció un movimiento limpio (2×ATR antes
de 1×ATR en contra, 24 h), ¿alguna feature predice su SIGNO? **Nulo declarado: la CLASE
MAYORITARIA**, no el 50 % — adivinar siempre la dirección dominante del periodo es gratis.
Siete features cerradas antes de ejecutar; criterio de hallazgo: IC sin solapar **Y** réplica
en 3 monedas **Y** contra-periodo.

**Periodo principal (180 d):** las 7 quedan por DEBAJO del nulo y **6 de 7 replican en signo**
— `st_4h` −8,9/−18,2/−14,1 · `smc_bos` −16,1/−14,7/−13,7 · `mom_24h` −11,6/−16,4/−11,5 ·
`st_1d` −12,3/−9,9/−8,5 · `rsi_side` −11,6/−18,2/−12,4 · `bb_pos` −0,8/−6,4/−2,6. Todas las
features de CONTINUACIÓN salen anti-predictivas: parecía una firma de reversión a la media
coherente con M8 (retroceso > rotura) y con el `ENTRY_K` de `auditConditionalRR`.

**Contra-periodo (−270 d): NO SOBREVIVE.** `st_4h` **cambia de signo** (+2,5/+9,4/0,0),
`smc_bos` **cambia de signo** (+2,3/+2,8/+5,2), `rsi_side`, `sr_side`, `bb_pos` y `mom_24h`
dejan de replicar. La única que mantiene el signo en los dos periodos es `st_1d`
(−3,4/−10,3/−3,2), con magnitud pequeña e IC solapando. **Ninguna pasa las tres condiciones.**

> ⚠️ **ESTE ES EL CASO DE ESTUDIO DEL PRE-REGISTRO.** Sin la condición (c) escrita ANTES, este
> informe habría publicado *"6 de 7 features replican en signo; la continuación es
> anti-predictiva a 24 h; el mercado revierte"* — un hallazgo coherente, replicado en tres
> monedas, alineado con dos mediciones anteriores… y **falso**. Es exactamente el resultado
> que una expedición de pesca produce, y el contra-periodo es lo único que lo detectó.

**Consecuencia:** con la fase 0 (NO-GO) y M9 (NO-GO), **el producto direccional con ventaja
medida queda cerrado por dos vías independientes**. Lo que queda vivo es el techo del oráculo
(39,5-55,0 % contra un azar del 16-27 %): la señal existe, pero ninguna feature de las
probadas —ni las del bias, ni estas siete— la captura. Reabrir exige features de otra
naturaleza, no otro ajuste de las mismas.

### ▶ B3 · Seis copias, y lo que NO se unificó

**Se midió la duplicación antes de tocar: SEIS copias** de "cuánto dura una vela" —
`TIMEFRAME_MINUTES` (constants) · `TF_DURATION_MS` (outcome) · `TF_MS` (episodes) · `TF_HOURS`
(derivativesScore) · `TF_HOURS_STATS` (stats) · `TF_MS` (conditionalPlan). **Las seis
coincidían** → no había bug, había **superficie de bug**. Síntoma revelador: `TF_DURATION_MS`
estaba **exportada y no la importaba nadie** — alguien la hizo pública para que fuera el dueño
y los demás siguieron escribiendo la suya.

Ahora `TF_DURATION_MS` / `TF_DURATION_HOURS` se **derivan de `TIMEFRAME_MINUTES`** en
`config/constants.js` (un solo juego de números: no pueden discrepar ni aunque alguien edite
uno) y los cinco consumidores importan. **Guarda** que detecta una séptima copia nombrando
fichero y línea, verificada reintroduciendo una.

⚠️ **El hallazgo de fondo fue otro:** `conditionalPlan` —el que pinta la caducidad **en
pantalla**— replicaba la aritmética en vez de usar `setupExpiryMs`, la del **evaluador**. Eso no
es duplicar una constante: es que el panel pudiera decir *"válido hasta el jueves"* mientras el
shadow trade cerró el miércoles, **sin que nada avisara**. Ahora delega, y hay un test que fija
esa igualdad sobre cuatro combinaciones de TF y vigencia.

---

De las "cuatro vigencias" que la ficha original nombraba, **solo dos eran la misma cosa**:

| Vigencia | ¿Se unifica? | Por qué |
|---|---|---|
| **Episodio** (1 vela del TF primario) | ✅ sí | Se apoya en la duración de vela → dueño único |
| **Vigencia del setup** (`validity_candles` × TF) | ✅ sí | Ídem, y además el panel delega en `setupExpiryMs` |
| **Freno del oportunista** (2 h) | ❌ **no** | Vive en `collectOpportunistic.sh`. Es **cadencia operativa**, no ventana de medición: responde a "cada cuánto gasto una llamada al LLM", no a "cuánto vale una declaración" |
| **Cadencia fija** (12 h) | ❌ **no** | Ídem, en el crontab. Depende del cambio de hora CEST/CET y del coste diario, no de la geometría del mercado |

**Forzar las cuatro bajo un dueño habría sido abstracción por sí misma**, y encima peligrosa:
juntar cadencia operativa con ventana de medición invita a que alguien cambie el cron y mueva
sin querer la definición de episodio. Los **horizontes de medición** (1h/4h/24h/7d + barrera)
tampoco entran: son constantes calibradas con su propia medición y su propia pareja de eje
(`OPPORTUNITY_BY_HORIZON`), no derivadas de la duración de vela.

**La lección:** "unificar las cuatro vigencias" era el enunciado equivocado. Lo que había que
unificar era la **primitiva** sobre la que dos de ellas se construyen; las otras dos son otro
eje y deben seguir separadas.

### ▶ Guardas nuevas contra fallos que se repitieron

Dos clases de error se cometieron **tres veces cada una** en la misma sesión, así que dejaron de
depender de la memoria:

| Guarda | Qué caza | Por qué hacía falta |
|---|---|---|
| `tests/sqlTemplateLiterals.test.js` | (a) backticks en comentarios SQL · (b) **`node --check` sobre TODO `src/`** | Un backtick dentro de un template literal —el prompt, una consulta— rompe el módulo entero y **tumba 7-16 suites que no tienen nada que ver**, con un stack de Babel. Pasó 3 veces. ⚠️ La 1ª versión hacía `import()` de cada módulo y **se colgó**: importar `index.js` arranca el servidor. Un test de sintaxis no puede tener efectos secundarios |
| `tests/timeframeOwnership.test.js` | Una séptima tabla de duración por TF, y que la caducidad **pintada** sea la que el evaluador **aplica** | Ver ▶ B3 |

### ▶ M7 · Resultado (2026-08-03) — y el hallazgo no es el que se buscaba

**Método:** las 11 formas reales de producción aplicadas a cada anclaje de 4h de 120 días × 3
monedas (23.787 réplicas). **Las dos ramas usan `evaluateShadowTrade` REAL**; sólo cambia lo
que se le pasa (precedente: `auditBarrierTies`). La rama CIERRE busca la primera vela 4h que
cierra más allá de la entrada y evalúa desde ahí con `entry_price` = ese cierre.

| | llenado | tp1 | stop | caducó | **R:R real** | **E[R]/oportunidad** |
|---|---|---|---|---|---|---|
| **A · toque** (actual) | 56,9 % | 6,4 % | 16,8 % | 33,6 % | **2,00** | −0,012 |
| **B · cierre** (lo declarado) | **40,4 %** | 6,4 % | **5,8 %** | 28,2 % | **1,15** | +0,004 |

**Replica en las tres monedas** (llenado −16 a −19 pt · stop cae a un tercio · tp1 IDÉNTICO).

**Lo que NO pasa:** la expectativa no está inflada. Las dos ramas salen ≈0 y la estricta sale
marginalmente MEJOR — exigir cierre filtra las mechas que sólo rozan la entrada y se dan la
vuelta, que son justo las que acaban en stop (16,8 % → 5,8 %). Menos operaciones, pero menos
malas.

**Lo que SÍ pasa, y es de pantalla:**
 1. **La tasa de llenado del registro está inflada 16-19 pt.** Donde el panel dice *"en 3 de 9
    el precio llegó a la entrada"*, bajo la regla declarada serían ~2 de 9.
 2. **El R:R que enseña el panel es el de la regla de TOQUE, no el de la regla que el modelo
    declara**: 2,11 frente a ~1,15 realizado. Y `breakeven_win_rate_pct` se DERIVA de él, así
    que el panel dice *"acertar >32,2 % para empatar"* cuando bajo el gatillo declarado el
    listón real estaría cerca del **47 %**. Esa sí es una cifra engañosa en pantalla.

> ❌ **RETRACTADO EL MISMO DÍA — ver la tabla de tres ramas abajo.** Lo que sigue en este
> párrafo se escribió con solo dos ramas medidas (A y B) y la conclusión era FALSA.
>
> ~~⚠️ **EL HALLAZGO DE FONDO: el `conditional_setup` es INTERNAMENTE INCOHERENTE.**~~ Declara dos
> métodos de ejecución incompatibles a la vez — un **gatillo** que pide *cierre de vela más
> allá del nivel* (entrada por confirmación, o sea a mercado tras el cierre) y un
> **`entry_price` fijo** que solo tiene sentido con una orden límite. Si el usuario pone el
> límite en 71,90, se llena al toque y el gatillo sobra; si espera al cierre, entra en ~71,27 y
> el `entry_price` declarado es ficción. **No es que el evaluador sea laxo: es que el setup
> pide dos cosas distintas.** El evaluador eligió una de las dos, razonablemente.
>
> **Consecuencia para P3: es un arreglo de PROMPT, no de evaluador.** O el gatillo describe una
> entrada límite (y entonces la regla de toque es la correcta y no hay nada que cambiar), o la
> entrada es "al cierre de la vela de confirmación" (y entonces `entry_price` no se puede
> prefijar, y el R:R declarado tampoco). Elegir una de las dos es la decisión; hasta entonces
> el panel **no debe presentar el R:R declarado como si fuera el realizable**.

#### ▶ M7-bis · La tercera rama, y la retractación

**Se midió la rama equivocada.** Con solo A (toque) y B (cierre) se concluyó que el setup era
incoherente. Al releer un caso real —gatillo *cierre 4h < 72,09*, entrada **71,90**, o sea un
nivel MÁS ABAJO— se ve que **no lo es**: describe *confirmar la rotura y luego entrar con límite
un poco mejor*, que es break-and-retest de manual. Eso es la rama **C**, y no estaba medida.

| rama | llenado | stop | **R:R real** | **E[R]/oportunidad** |
|---|---|---|---|---|
| **A · toque** (evaluador actual) | 56,9 % | 16,8 % | 2,00 | −0,012 |
| **B · cierre** (mal planteada) | 40,4 % | 5,8 % | 1,15 | +0,004 |
| **C · confirma + límite** ← lo que el setup DICE | **30,6 %** | 5,8 % | **2,00** | **+0,039** |

**Lo que se retracta:** que el R:R del panel engañe. Bajo la regla C el R:R declarado **es el
realizable** (2,00 en A y en C), así que el equilibrio que enseña el panel no miente.

**Lo que queda en pie, y es el hallazgo útil:** el registro **infla la ACTIVIDAD casi al doble**
(56,9 % de llenados contra 30,6 %). El seguimiento cuenta operaciones que el usuario, siguiendo
el disparo al pie de la letra, no habría hecho.

**P3 · BLOQUEADO POR UN CAMPO QUE NO EXISTE.** Para exigir la confirmación, el evaluador
necesita el NIVEL que la confirma — y ese nivel vive en el **texto libre** del `trigger`, que no
se parsea. No es un arreglo de evaluador ni de prompt: es un campo de esquema.
**Hecho el 2026-08-03: `trigger_price` añadido al `conditional_setup`** (`v9_2_trigger_price`),
con la regla de extracción y la distinción explícita frente a `entry_price`. A partir de ahora
los análisis lo emiten; **cuando haya muestra suficiente, el evaluador podrá implementar C.**
Hasta entonces el panel avisa de la inflación con la cifra medida.

⚠️ Los IC de la tabla NO están corregidos por solape (las 11 formas comparten anclajes), así que
el `+0,039` de C indica ORDEN DE MAGNITUD, no un signo afirmable.

### ▶ 0-bis · Recogida de 3 monedas ACTIVA (2026-08-03)

| Cron | Minutos (local CEST) | UTC | Monedas |
|---|---|---|---|
| **Fijo** (muestra planificada) | 10:05 / 10:11 / 10:17 y 22:0x | **08:05-17 / 20:05-17** | SOL · BTC · ETH |
| **Oportunista** (dirigido por evento) | HH:33 / HH:39 / HH:45 | HH:33-45 | SOL · BTC · ETH |

**Separación de 6 minutos, no 2.** Un análisis tarda ~55 s observados, pero el techo real es
60 s de payload + 240 s de `--max-time` = **300 s**. Con 2 min bastaba una ralentización al
doble para que dos corrieran a la vez sobre la misma Pi; con 6 el solape es **imposible aunque
los dos agoten su timeout**. El desfase de 12 min entre monedas es irrelevante para una vela
de 4h y cada moneda es su propia observación.

**Condiciones que disparan el oportunista** (evaluadas sobre el payload, sin coste de LLM), y
solo en la **TRANSICIÓN** — cuando aparecen, no mientras persisten:
`veto_long` · `veto_short` · `data_insufficient` · OI 24h **> +3 %** · |cambio 24h| **> 5 %**.
Más dos frenos: **uno al día por moneda** y **ninguno si hay análisis de esa moneda en < 2 h**.

**Cómo se separan planificados de oportunistas: `sample_reason`, un HECHO en la fila.** La
primera versión lo deducía de la hora (los fijos aterrizan en `08:05-08:23` UTC, los
oportunistas en `HH:34-50`) y funcionaba, pero era **una convención, no un dato**: un análisis
manual a las 08:06 se habría clasificado como planificado.

Desde el 2026-08-03 el motivo **viaja en la petición y se persiste**:

| Prefijo | Quién lo pone | Ejemplo real |
|---|---|---|
| `fixed` | Cron planificado | `fixed` (10 filas) |
| `opportunistic` | Cron por evento, **con las condiciones que dispararon** | `opportunistic:veto_short` · `opportunistic:oi_expandiendo` |
| `ui` | Botón del panel | — |
| `manual` | Ejecución a mano de `collect.sh` | `manual:verificacion` |
| `adhoc` | Sólo backfill: *"no planificado, origen exacto no registrado"* | — |
| `unknown` | Petición sin motivo, o motivo que no valida | — |

Formato `prefijo` o `prefijo:detalle`; se valida el **prefijo** y el detalle admite `[a-z_+]`,
así que `LIKE 'opportunistic%'` sigue filtrando bien. Es **entrada de usuario que acaba en
BBDD**, así que se valida en vez de confiarse (`utils/sampleReason.js`, dueño único compartido
por la API y el backfill).

⚠️ **El backfill lee el LOG, no la hora.** Al ir a marcar una fila se descubrió que
`collect.log` **registra el motivo de cada ejecución** — o sea que el dato existía, sólo estaba
en otro sitio. **Deducir lo que ya está escrito es inventar donde se puede leer.** Las 13 filas
tienen motivo REGISTRADO y cero inferidas; la heurística horaria queda sólo como respaldo para
filas sin línea de log, y ésas sí irían marcadas `:inferred`.

**Dos bugs corregidos al activarlo, los dos habrían sesgado la comparación entre monedas:**

1. **Colisión de horarios.** El oportunista corría al **minuto 7 de cada hora** y el fijo de BTC
   está en `10:07`/`22:07`: coincidencia EXACTA. Habría hecho indistinguibles los dos tipos por
   hora y creaba una carrera con el freno de 2 h, que consulta si hubo análisis reciente justo
   cuando el fijo aún no había aterrizado. Movido al minuto 33.
2. **⚠️ El estado del disparador era COMPARTIDO.** `last-gating-state` era un fichero único, y
   el oportunista dispara en la TRANSICIÓN (condiciones nuevas frente al chequeo anterior). Con
   tres monedas cada una habría comparado sus condiciones contra las de **la moneda anterior**
   (SOL :33 → BTC :39 → ETH :45), no contra las suyas. Eso no bloquea: **corrompe la detección
   de transición**, inventando condiciones "nuevas" que sólo son diferencias entre monedas y
   tapando las reales cuando coinciden. Ahora es por moneda.
3. **⚠️ El freno diario era GLOBAL, no por moneda.** `last-opportunistic.date` era un fichero
   único: con tres monedas, *"un oportunista al día"* pasaba a ser *"un oportunista al día EN
   TOTAL"*, y **la primera en disparar bloqueaba a las otras dos hasta medianoche**. Como el
   cron va 33/35/37, **SOL habría ganado la carrera SIEMPRE** — sesgo sistemático, no aleatorio,
   justo en la comparación que motiva recoger tres monedas. Ahora el marcador es por moneda.

**Vigilancia:** `checkCollection.sh` comprueba ahora la frescura de **las tres** y añade un
problema por cada una parada. Antes solo miraba SOL: un fallo en BTC se habría descubierto
semanas después, al ir a comparar y encontrar el hueco.

**Coste:** ~1,20 €/día en la muestra fija (3 × 2 análisis con Opus) más lo que dispare el
oportunista, acotado a 1/día por moneda.

> **Los tres bugs de arriba comparten diagnóstico y merece la pena nombrarlo:** eran
> **supuestos de una sola moneda** invisibles mientras sólo se recogía SOL — un marcador
> global, un estado global y una vigilancia de una sola moneda. Los tres habrían sesgado
> **exactamente la comparación entre monedas que motiva recogerlas**, y ninguno habría dado
> un error: habrían dado números plausibles. Activar tres monedas parecía una línea de crontab.

### ▶ Umbrales de INDICADOR que siguen decidiendo sin medición (2026-08-03)

Salió al retirar las 14 constantes huérfanas: se rastreó cada constante superviviente hasta su
sitio de uso, y cinco no tienen su distribución medida — la regla que este proyecto no negocia.

⚠️ **Pero no son equivalentes, y el criterio para separarlas NO es el orden sino QUÉ DECIDEN.**
Verificado el 2026-08-03 contra el código: las puertas direccionales exigen **sólo `derivatives`
y `volume`** (`analysisValidator`), o sea que **Execution no entra en ninguna puerta**. Cuatro
de los cinco umbrales alimentan Execution y por tanto **no gobiernan ninguna decisión hoy**:
son contexto para el LLM y telemetría. Medir el corte de un voto en un score que no gatea nada
no cambiaría nada. El quinto —**U2**— sí decide, y por eso se midió de inmediato.

| # | Constante | Qué decide | Por qué preocupa |
|---|---|---|---|
| **U1** | `WT_OVERBOUGHT = 60` / `WT_OVERSOLD = -60` | El `signal` de WaveTrend, que es **uno de los cinco votos de Execution** | Dos números escritos a mano (defaults de LazyBear) gobiernan **un quinto de un score**. El más expuesto |
| ~~**U2**~~ ✅ **MEDIDO** | `SR_TOLERANCE_PCT = 0.005` | Tolerancia de agrupamiento de S/R: `\|ancla − precio\| / ancla <= 0,005` | **Porcentaje ABSOLUTO, sin normalizar por volatilidad** — el patrón T5 literal. 0,5 % en BTC y en SOL son distancias muy distintas en ATR, y de esos clusters salen los niveles del veto y de `price_near_key_level`. **El más sospechoso**, y el único que NO depende de Execution → se mediría antes |
| **U3** | `RSI_OVERBOUGHT = 70` / `RSI_OVERSOLD = 30` | La etiqueta `overbought`/`oversold` que viaja al LLM | La rúbrica de Execution vota con **55/45**, no con 70/30: **dos vocabularios de "RSI extremo"** conviviendo. No es doble conteo (uno etiqueta, otro vota) pero es la ambigüedad que ya costó cara con `adx.regime` y los dos `atr_pct` |
| **U4** | `VOLUME_PROFILE_VALID_THRESHOLD_PCT` 5/8/12/20 | Validez del POC por TF | El comentario dice "calibrado por TF" pero **no cita medición**, y vuelven a ser porcentajes absolutos |
| **U5** | `SUPERTREND_MULTIPLIER = 3.0` | Base del multiplicador adaptativo | SuperTrend es otro de los cinco votos de Execution |

**Lo que NO preocupa, y conviene decirlo:** los ~15 parámetros canónicos del indicador (RSI 14,
ADX 14, MACD 12/26/9, BB 20/2, StochRSI, WaveTrend 10/21, SuperTrend ATR 14…) **no son cortes de
decisión**: definen *qué es* el indicador. Y hay un argumento positivo para dejarlos en los
valores de consenso — los niveles que mira el resto del mercado se calculan con esos mismos
números, así que desviarse tiene un coste real.

**Y los que sí estaban medidos y documentados en su sitio:** `SR_LOOKBACK`, `SR_MIN_TOUCHES`
(ambos de T4, con sus cifras en el comentario) y `ADX_RANGING_THRESHOLD`. Caso bien resuelto:
`ADX_TRENDING_THRESHOLD = 25` **ya no decide** — T2 lo pilló cayendo en el percentil ~50 (moneda
al aire) y ahora la decisión la toma `bucketByPercentile` por terciles, con el 25 degradado a
*fallback*.

**U1 · U3 · U4 · U5 — CONGELADOS, y el motivo es que NO DECIDEN NADA.** No es "esperan turno":
alimentan el Execution Score, que no entra en ninguna puerta. Se reevalúan **sólo si Execution
pasa a gatear algo**, y entonces el orden sería M2 primero (¿aporta Execution?) y luego sus
cortes. Mientras tanto, medirlos sería trabajo sin consecuencia.

### ▶ U2 · MEDIDO (2026-08-03) — el % absoluto NO es inocuo

`scripts/auditSrTolerance.mjs` · 180 d × 3 monedas × 3 TFs, con la función REAL
(`calculateSupportResistance` ya acepta la tolerancia como 4º argumento, así que el
contrafactual no reimplementa nada).

**Las tres predicciones se firmaron antes de ejecutar. Las tres se cumplen:**

| | Predicción | Medido |
|---|---|---|
| **P1** | La tolerancia en unidades de ATR difiere entre monedas | **×1,55-1,80** (0,25-0,39 ATR en 4h) |
| **P2** | Menos niveles y más fuertes donde más agrupa | ✔ |
| **P3** | La fracción que pasa `touches >= 3` —**el filtro del VETO**— difiere entre monedas | **11,6-12,3 pt** de dispersión en 1h y 4h |

**Y el contrafactual cierra el argumento:** con tolerancia normalizada (`k × ATR%`) la
dispersión entre monedas cae a **1,4-2,5 pt**, o sea ~5× menos. Las diferencias que hoy hay
entre monedas **no vienen del mercado: las mete el umbral**.

> ⚠️ **EL HALLAZGO MAYOR NO ES ENTRE MONEDAS, ES ENTRE TIMEFRAMES.** Con la tolerancia actual,
> la fracción de niveles que pasan `touches >= 3` va **1h 42,9-55,2 % · 4h 18,0-29,5 % · 1D
> 2,9-5,5 %**. En 1D la tolerancia vale 0,08-0,15 ATR: los pivotes casi no se agrupan y casi
> nada llega a "nivel fuerte". Con `k = 0,5` los tres TFs convergen a ~33-41 %.
>
> **Importa porque el TF primario es un PARÁMETRO DE PETICIÓN** (documentado en CLAUDE.md): el
> cron fija 4h, pero un análisis lanzado con el gráfico en 1h tendría **el doble** de niveles
> "fuertes" y por tanto una pata S/R del veto mucho más fácil de disparar. Es el mismo tipo de
> distorsión específica de 1h que ya está en la lista como **B2**.

**Control de cordura:** en 4h sale 18,0-29,5 % (media ~24 %), que replica el **22,1 %** que
midió T4 tras reescribir la función. La medición reproduce el número conocido.

**Consecuencia — entra en el cubo 3 (punto cero) con su medición hecha, no se toca ahora:**
normalizar la tolerancia cambia cuántos niveles son "fuertes" y por tanto **la frecuencia del
veto**, que está medida (8,2 % / 6,6 % según ventana). Ancla propuesta para elegir `k`: **el
valor que deja el comportamiento de 4h SIN CAMBIOS** (~24 % ⇒ `k ≈ 0,35`, entre el 15-17 % de
k=0,25 y el 38-41 % de k=0,5). Así el cambio es un no-op para la muestra ya recogida y sólo
corrige la incoherencia entre TFs y monedas — en vez de mover la puerta y la definición a la vez,
que es lo que la regla de atribución prohíbe.

---

## 5. CUBO 3 — PUNTO CERO · lo que entra en la lista cerrada

### 5.1 · Firmes (medición hecha o trivial)

| # | Ítem | Requisito previo |
|---|---|---|
| **B1** | **Unificar los dos ATR%** — persistir el de decisión (180), retirar la reconstrucción de 19 | **M4** |
| **B2** | **Suelo de `dynamicNearLevelPct` en 1h** (0,5 % muerde el 47,9 % del decil tranquilo en 1h; 0,0 % en 4h) | — (medido) |
| ~~**B3**~~ | **Vigencias con dueño único** | ✅ **HECHA el 2026-08-03** — detalle en ▶ B3 (§4) |
| **B4** | **Banda muerta en la pata ESTRUCTURAL de `computeTrend`** (`neutral` sale 4,4 % y significa "ADX y SuperTrend se contradicen") | — (medido) |
| **B5** | **Refactor `analysisController`** (1.306 líneas) → pipeline por etapas + registro de features con dueño único | — |
| **F1** | **Ventana rodante de 24 h por TIEMPO, no por posición** (huecos = 0) | **M1 + M5** |
| **F2** | **`SR_TOLERANCE_PCT` normalizado por ATR** (`k ≈ 0,35`, anclado a dejar 4h sin cambios) | — ✅ **medido** (§4 ▶ U2). Cambia la frecuencia del veto, así que va en el lote, no suelto |

### 5.2 · Condicionales (entran si su medición lo confirma)

| # | Ítem | Qué lo decide |
|---|---|---|
| **C2** | **Banda del eje OI×precio 0,50× → 0,35×** | Márgenes acumulados en `band_pct`. **No se evapora con el rediseño**: es fuga de señal en la celda con o sin puertas |
| **C6** | **Lote prompt anti-formulario** (output casi idéntico · R:R degradando · gatillos que no disparan) | Calidad del `conditional_setup`, base de todo el shadow trade |
| **C8** | **Asimetría de la guardia de volumen** (bloquea alcistas ~2× más) | **Veredicto vigente: medir, NO tocar.** Es propiedad del dato. Pero como **sumando** inclina el titular diario → entra en M6 |
| **C10** | **Ajustes ±0.5 del prompt** sin respaldo, incl. ETF × Funding | Muestra |
| ~~**C3**~~ | ~~`veto_short` con rechazo confirmado~~ | ❌ **Medido: "sugerente, no establecido" → NO se toca** (3 de 3 en el signo malo, IC solapando, n_ef 8/7/2) |

---

## 6. CUBO 4 — PRODUCTO · lo que se pidió y hoy no tiene dueño

Esto es lo que motivó la reorientación: *"pulso analizar y me dice qué hacer, con % de riesgo,
válido n horas, entrada x, salida y"*. Tres de esos cuatro campos **no tienen respaldo hoy**.

| # | Ítem | Estado real hoy |
|---|---|---|
| ~~**P4**~~ | ~~Split `bias` / `confidence` / `actionable`~~ ❌ **ARCHIVADO por la fase 0** | Era el gran cambio, y **la medición lo retiró**: sin ventaja direccional demostrable, un `bias` continuo sería una máquina de opiniones. Reabrir exige features de otra naturaleza (§4 ▶ M9). Su beneficio decisivo: **re-etiquetar la historia offline** al mover un corte, sin LLM y sin punto cero. Hoy cada cambio de umbral cuesta un punto cero |
| ~~**P1**~~ | ~~`risk_score` con rúbrica medida~~ → **RETIRADO del panel** ✅ | ⚠️ **Sin dueño, y por eso se retiró en vez de medirse (M3 quedó innecesaria).** Única regla en todo el sistema: entero en [1,10] ([analysisValidator.js:86](../backend/src/services/analysisValidator.js#L86)). Decorativo hoy; **titular del producto mañana**. Mismo defecto que Execution pre-v8_0 y Derivatives pre-v9_0. **Tamaño de posición no existe en ninguna parte** |
| ~~**P2**~~ | **Vigencia como promesa al usuario** ✅ **HECHO** — `expires_at` visible y delegado en `setupExpiryMs` | Ya mordió: el barrier ignoró `setup_validity_candles` hasta el 28-07 |
| **P3** | **Alinear `SHADOW_FILL_RULE` con lo prometido** ⏳ **desbloqueado** | M7 lo midió: el registro **infla la ACTIVIDAD casi al doble** (56,9 % de llenados contra 30,6 % de la regla declarada), pero **el R:R NO engaña**. Faltaba un campo, no una regla: `trigger_price` ya se emite; cuando haya muestra el evaluador podrá exigir la confirmación |
| ~~**P5**~~ | **Retirar `Preparar`** ✅ **HECHO** (`v9_1_no_preparar`) | Exigía L2 antes, que se hizo el mismo día. **0 filas** lo usaban. Escritores dejan de emitirlo; **lectores lo siguen entendiendo** (filtros de abstención, badge del historial) |
| **P6** | **`Structure` sin dueño determinista** | En el prompt es prosa (*"+2 = estructura alcista limpia"*). Y el proxy obvio, `computeTrend`, **contiene 4 de los 5 votos de Execution + volumen** → usarlo sería triple conteo |

---

## 6-bis. 🎯 EL SISTEMA AL QUE VAMOS — definición

> Escrito **después** de las mediciones, no antes. Las tres cosas que este sistema NO afirma
> las retiró un dato, no una preferencia de diseño.

### Lo que se pidió

> *"Pulso analizar para cualquier moneda en cualquier momento y me recomienda: propongo esto,
> con este % de riesgo, válido n horas, entrada x, salida y."*

### Por qué NO puede ser un dictamen direccional

Dos mediciones independientes lo cierran:

- **Fase 0 (M6):** el bias determinista queda **por debajo del azar en las 3 monedas** y no
  supera a la deriva en ninguna. Y pierde **in-sample**, o sea en su propia ventana de ajuste.
- **M9:** entre las anclas donde el mercado SÍ ofreció un movimiento limpio, **ninguna de siete
  features pre-registradas predice su signo** — y las que parecían hacerlo cambiaron de signo
  en el contra-periodo.

**No es un umbral mal puesto.** El techo del oráculo (39,5-55,0 % contra un azar del 16-27 %)
dice que la señal direccional EXISTE en el mercado; lo que no existe, con lo probado, es una
feature que la capture. Reabrirlo exige features de otra naturaleza —microestructura, flujo de
órdenes—, no otro ajuste de las mismas.

### Lo que SÍ es: un cuaderno de trading disciplinado y auditable

Cuatro bloques, con la autoría repartida y visible:

| Bloque | Autor | Respaldo |
|---|---|---|
| **Lectura** — qué está haciendo el mercado | LLM | Su juicio, **SIN MEDIR** (no refutado: no es medible offline, el payload no se reconstruye punto-en-el-tiempo) |
| **Qué falta para operar** — `missing_confirmations` | LLM | Ídem |
| **El plan condicional** — entrada, invalidación, objetivo, **caducidad** | LLM elige la geometría | Ídem |
| **Las cifras que lo califican** | Backend | **MEDIDAS** sobre miles de anclas |

Las tres cifras medidas, y por qué esas:

1. **R:R → equilibrio.** Aritmética pura, no necesita muestra. *"Acertar >32,2 % para empatar."*
2. **P(el disparo se cumpla)** — `TRIGGER_BASE_RATE`, ~3.000 anclas/celda.
3. **P(el objetivo se alcance en la vigencia)** — `TARGET_REACHABILITY`. **La cifra incómoda**:
   en los setups reales sale entre el 5 % y el 18 %, o sea que lo normal es que el plan caduque
   abierto. Enseñarla es la mitad de la honestidad del panel.

Más el **registro crudo** de lo que pasó con los planes anteriores, **en la misma pantalla**.
No en una página de auditoría: un sistema que se usa a diario genera presión para creérselo, y
la única defensa es que el historial esté donde no se pueda no ver.

### Lo que el sistema se NIEGA a decir, y por qué

- **Ninguna probabilidad de acierto direccional.** Fase 0 y M9, por vías independientes.
- **`expectancy_r` no se enseña.** Su línea base **no es un número, es una curva** indexada por
  anchura de barrera ÷ √vigencia (M10). Un setup con barreras estrechas sale a −0,3R por pura
  geometría; compararlo contra una constante lo haría parecer un desastre siendo otra forma.
- **`risk_score` retirado.** Su única regla en todo el sistema era *"entero entre 1 y 10"*, y
  llevaba un 7 en los cuatro últimos análisis. Un número decorativo en el titular de un producto
  es peor que ninguno.
- **La convicción va etiquetada** *"auto-declarada, sin calibrar"*: nadie ha comprobado todavía
  si un 0,3 se comporta distinto de un 0,7 (pregunta D1, abierta).
- **La regla de llenado viaja PEGADA a las cifras**, no en una nota al pie: el registro cuenta
  casi el doble de operaciones de las que saldrían siguiendo el disparo al pie de la letra
  (56,9 % contra 30,6 %, medido en M7).

### La propiedad que lo hace sostenible

**Es falsable desde el primer día sin necesitar estar probado antes.** Un dictamen direccional
no se puede publicar sin demostrarlo —publicar "compra" sin ventaja medida hace daño—, pero un
plan condicional con sus cifras medidas al lado sí. Y cada análisis genera automáticamente un
shadow trade que se evalúa solo: **la evidencia se acumula como subproducto de usarlo, no como
requisito para empezar.**

Con las tres monedas activas, la pregunta que queda abierta —*¿el juicio del LLM vale lo que
cuesta?*— pasa de ser cuestión de un año a serlo de unos tres meses.

---

## 7. Secuencia acordada

```
✅ COMPLETADO EN LA MACRO-SESIÓN DEL 2026-08-03   (764 → 815 tests · 8 despliegues)

  INFRAESTRUCTURA Y LIMPIEZA (nada toca la ruta de decisión)
   ├─ liquidations_1h · serie de archivo + backfill 90 d      6.338 filas
   ├─ L1  renombrado liquidations → liquidations_1d           + migración idempotente
   ├─ L2  versionado por fila (gate/rubric/feature)           A3, desbloquea P5
   ├─ 14 constantes huérfanas retiradas                       contradecían las reglas vivas
   └─ B3  vigencias con dueño único                           6 copias → 1, + guarda

  MEDICIONES (solo lectura, ninguna gasta punto cero)
   ├─ M6  FASE 0 · ¿bate el bias al azar y a la deriva?       ❌ NO-GO en 3 de 3
   ├─ M8  geometría de entrada (rotura vs retroceso)          ✅ + discrepancia 0,3R resuelta
   ├─ M9  ¿algo predice la dirección del movimiento limpio?   ❌ NO-GO (lo mató el contra-periodo)
   └─ M7  coste de la regla de llenado                        ✅ + rama C (autocorrección)

  PRODUCTO v1 — ENTREGADO Y DESPLEGADO
   ├─ Panel: lectura + qué falta + plan condicional + registro del shadow trade
   ├─ P1  risk_score RETIRADO del panel · convicción etiquetada "sin calibrar"
   ├─ P5  `Preparar` retirado                                 v9_1_no_preparar · g2
   ├─ P3  trigger_price al esquema                            v9_2_trigger_price
   └─ Poda: expectancy_r NO se enseña (su base es una curva sin medir → M10)

  RECOGIDA
   ├─ 0-bis  SOL + BTC + ETH, fijo y oportunista               3 bugs de "una sola moneda"
   ├─ sample_reason persistido + backfill DESDE EL LOG         13/13, cero inferidas
   └─ checkCollection vigila las tres

AHORA — la v1 está entregada. Lo único vivo es ACUMULAR MUESTRA.
   · El cron llena trigger_price y el registro del shadow trade solo.
   · Con muestra: cerrar P3 (evaluador exige confirmación) y leer el registro.

DESPUÉS — congelado en §7-bis, y no se abre "porque se ve mal"
   └─ B1 (M4) · F1 (M1+M5) · B5 refactor · B2 · B4 · cubo 0 · M2 · M10 · M11
        └─ PUNTO CERO 6 · mucho más pequeño de lo previsto, y aún sin fecha
```

**Las ONCE mediciones, cada una con su sitio.** Esta tabla existe porque M2, M3 y M7 estuvieron
definidas en §4 y **sin programar en ninguna parte** hasta el 03-08: una medición sin slot no
es una medición pendiente, es una que nadie va a hacer. Si se añade una M12, se añade aquí.

| Medición | Estado | Dónde |
|---|---|---|
| **M6** fase 0 | ✅ hecha · NO-GO | — |
| **M8** geometría de entrada | ✅ hecha | — |
| **M9** dirección del movimiento limpio | ✅ hecha · NO-GO | — |
| **M7** coste del `SHADOW_FILL_RULE` | ✅ **hecha** | Su consecuencia (P3) resultó ser **un campo de esquema que no existía**, no un cambio de evaluador ni de prompt: `trigger_price`, añadido el mismo día. El cierre de P3 espera muestra, no trabajo |
| ~~**M3**~~ `risk_score` | ❌ **INNECESARIA** | Se decidió **RETIRAR** `risk_score` (P1) en vez de medirlo. Medir una magnitud que se va a borrar es trabajo por definición inútil. Reabrir sólo si alguna vez se decide conservarlo |
| **M2** rúbrica de Execution | ⏸️ **CONGELADA** | Su motivo era decidir si Execution entraba en el `bias`; con la fase 0 en NO-GO ese camino está cerrado. Sigue viva como deuda: **4 de los 5 umbrales sin medir alimentan Execution**, así que va ANTES que ellos si algún día se abren |
| **M1** huecos de la ventana rodante | ⏸️ congelada | Requisito de **F1**, que está en el grupo DESPUÉS |
| **M5** cortes de la cascada | ⏸️ congelada | Requisito de **F1**, ídem |
| **M4** `auditTriggerBaseRate` sobre el eje unificado | ⏸️ congelada | Requisito de **B1**, ídem |
| **M10** línea base de expectativa como curva | ⏸️ congelada | Requisito de la **v2**: la v1 no enseña `expectancy_r` (§7-bis) |
| **M11** gradiente de entrada rotura↔retroceso | ⏸️ congelada | Sugerente sin IC que separe. Necesita más muestra, no un cambio |


---

## 7-bis. ✂️ LÍNEA DE CORTE DEL PRODUCTO v1

> **Por qué existe esta sección.** Cada medición genera hallazgos, y cada hallazgo genera
> ítems. Eso es el método funcionando — pero es también, exactamente, cómo se llegó a cinco
> puntos cero con cero días de datos evaluables. La defensa no es medir menos: es **declarar
> qué necesita el producto y congelar el resto**.

**Balance del 2026-08-03 — el día CERRÓ más de lo que abrió**, y cerró lo grande: la fase 0
(NO-GO) retiró el rediseño direccional, que iba a ser *"el lote más grande del proyecto"*, y
con él descolgó los cinco ítems del cubo 0. M8 quedó cerrada con su discrepancia resuelta.
Lo que creció fue el backlog de CORRECTITUD, que no bloquea nada.

**Los SEIS ítems de la v1 — ✅ TODOS ENTREGADOS el 2026-08-03.** Tres eran RETIRAR, no construir:

| # | Ítem | Estado |
|---|---|---|
| **1** | Panel: lectura + qué falta + plan condicional + registro del shadow trade, en la MISMA pantalla | ✅ `utils/conditionalPlan.js` + `sidebar.js`. `missing_confirmations` se emitía desde v9_0 y **no lo pintaba nadie** |
| **2** | **B3** · vigencia con dueño único → "válido hasta X" visible | ✅ y el hallazgo fue mayor: el panel replicaba la aritmética en vez de usar `setupExpiryMs`, o sea que podía **prometer una caducidad distinta de la que aplica el evaluador** |
| **3** | **P3** · alinear `SHADOW_FILL_RULE` con lo prometido | ⏳ **desbloqueado, esperando muestra.** M7 demostró que faltaba un campo (`trigger_price`, ya añadido), no un cambio de regla |
| **4** | **P1** · `risk_score` → RETIRAR | ✅ fuera del panel. Llevaba un 7 en los 4 últimos análisis y su única regla era "entero en [1,10]" |
| **5** | **P5** · retirar `Preparar` | ✅ `v9_1_no_preparar`. **0 filas** lo usaban; los lectores lo siguen entendiendo |
| **6** | Podar del panel lo sin respaldo | ✅ `expectancy_r` no se enseña · convicción etiquetada *"auto-declarada, sin calibrar"* |

**Y una decisión de alcance que DESBLOQUEA M10:** en v1 **no se enseña `expectancy_r`**. Se
enseñan las tres cifras que ya tienen su curva medida y no necesitan línea base nueva —
`P(gatillo)`, `P(TP1 alcanzable)`, equilibrio del R:R— más el **registro crudo** ("de los
últimos 20 planes: 7 dispararon, 2 llegaron al objetivo, 11 caducaron"), que es un hecho y no
necesita respaldo estadístico. M10 deja de bloquear y pasa a ser el requisito de la v2.

**CONGELADO — la v1 ya está entregada, así que esto es el «después»** (correctitud real, ninguno
bloquea): B1, B2, B4, B5, F1, todo el cubo 0, **los 5 umbrales de indicador de §4 ▶ Umbrales** (U1-U5), M2, M10, M11. **No se abren "porque se ven mal".** De las mediciones de estos dos días, dos dijeron *no cambies nada*, una corrigió el
signo de una celda que se iba a escribir al revés, una tumbó el cambio que venía a justificar
y una resolvió una contradicción que parecía un bug y no lo era.

---

**Regla de atribución que no se negocia:** no se cambian el output y los umbrales en el mismo
lote sin poder separarlos después. Si P4 (split del bias) entra, los ajustes de umbral del cubo
3.2 se documentan por separado con `rubric_version` (L2) para poder atribuir.

---

## 8. Sobre empezar de cero en un repo nuevo

Instinto correcto para una parte del código y caro para otra. El análisis está en la respuesta
que acompaña a este documento; el resumen operativo:

- **Reescribir:** ruta de decisión (rúbrica como puerta, gating conjuntivo, secciones del prompt
  que puntúan, `applyDecisionGates`). Es justo lo que el rediseño sustituye.
- **NO reescribir:** la maquinaria de medición (`stats.js`, `pathMetrics.js`, `episodes.js`,
  `shadowTrade.js`, `lib/disjointAnchors.mjs`, los 26 `audit*.mjs` y sus tests). Son ~9 meses de
  correcciones, y **cada una nació de un número plausible pero falso** (cuatro censuras mal
  contadas, el 0,225R, el 24-42 %, el 45,6 %, el "+10 pt del skew"). Tirarlas es re-ganarse esos
  bugs, y esta vez sin la bitácora que los detectó.
- **NO empezar un repo vacío:** se pierde el historial de git — y `L2` existe precisamente porque
  hoy comparar dos periodos ya obliga a arqueología de commits. Mejor rama o reestructura.
- **⚠️ NO empezar con BBDD vacía:** `history_series` contiene datos que **ninguna API volverá a
  servir** (la ventana de Coinalyze rueda). Se acaban de sembrar 6.336 filas horarias hoy
  precisamente por eso. "Proyecto limpio" nunca puede significar "fichero .db nuevo".
