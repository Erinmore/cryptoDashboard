# Constantes medidas y retractaciones — L4

> **Para qué sirve este documento.** La bitácora cuenta *qué pasó*; esto extrae lo **reutilizable**:
> cada constante viva con su **alcance y su fecha**, y —más importante— la lista de números y
> cambios que se **midieron y se descartaron**, para que dentro de tres meses nadie reproponga
> el 45,6 %, la banda al 0,75× o la regla del DVOL creyendo que es una idea nueva.
>
> **Fecha:** 2026-08-04 · Ítem **L4** de [`REORIENTACION_LISTA_CERRADA.md`](REORIENTACION_LISTA_CERRADA.md) §3.

---

## 0. Las dos reglas que gobiernan todo lo de abajo

1. **Ninguna constante de corte se escribe sin medir antes la distribución de la magnitud que
   bucketiza.** Un punto cero NO levanta esta regla: son permisos distintos.
2. **Toda cifra se cita con su fecha y su ventana.** Casi todas se midieron sobre ventanas
   RODANTES de 90-180 días: la misma ejecución un mes después da otro número. Una cifra sin
   fecha es una cifra que alguien va a comparar con otra que no es comparable.

---

## 1. Constantes VIVAS — valor, qué decide, alcance

| Constante | Valor | Qué decide | Alcance de la medición | Cuándo | Aviso |
|---|---|---|---|---|---|
| `OPPORTUNITY_BASE_RATE` | **34,8 %** | Referencia de `offered_pct`: sin ella, la abstención no es evaluable | 90 d × SOL/BTC/ETH · 4h · par 2×/1×ATR a 24h | 2026-07-27 | **Re-confirmada** el 01-08 con clave relativa y anclajes disjuntos: 35,2 % [31,9-38,6], sin dependencia del régimen |
| `OPPORTUNITY_BY_HORIZON` | 24h **2×/1×** · 7d **4×/1×** | Qué cuenta como movimiento operable | ídem | 2026-07-27 | Un múltiplo fijo se vuelve trivial al crecer la ventana: a 7 d, 2×/1× saturaba al 67-69 % |
| `TRIGGER_BASE_RATE` | curva en `d = dist% / (ATR%·√velas)` | `P(el gatillo se cumpla)` que ve el usuario | 90 d × 3 monedas · 4h · ATR de **19** velas | 2026-08-01 | **M4 (04-08): el eje de 180 velas mueve la curva ≤1,1 pt** → B1 no obliga a re-medirla. Pero en un setup CONCRETO `d` se desplaza ±10 % en las colas ≈ ±4 pt |
| `TARGET_REACHABILITY` | curva en el mismo `d` | `P(el objetivo se alcance en la vigencia)` | 3 monedas · 4h · vigencias 6/12/24/42 · ATR de **180** | 2026-08-01 | En los setups reales sale al **5-18 %**: lo normal es que el plan caduque abierto |
| `TARGET_UNREACHABLE_PCT` | **5 %** | Cuándo el objetivo declarado es inerte | ídem | 2026-08-01 | Robusto: **cualquier corte entre 3 % y 10 % da la misma partición** de las geometrías reales |
| `price_band_atr_mult` | **0,50×** | Celda del cuadro OI × precio | 90 d × 3 monedas | 2026-07-29 | **0,35× es alternativa real y los datos NO la separan de 0,50×** (`auditPriceBand`). Se mantiene porque cambiarla cuesta un punto cero, no porque sea mejor |
| `oi_dead_band_pct` | **±1,0 %** | Qué cuenta como expansión/contracción real del OI | 90 d, n=534/moneda | 2026-07-27 | La mediana del cambio 24h es ~0: sin banda, el corte era moneda al aire |
| `cascade_skew_max` · `cascade_magnitude_mult` | **−0,5** · **2×** | Cascada de liquidaciones (única vía negativa en una caída) | 90 d × 3 monedas, mediana de 30 d COMPLETA | 2026-07-29 | **M5 (04-08): los cortes NO se mueven con la ventana corregida.** ⚠️ pero su FRECUENCIA es muy inestable — ver §3 |
| `cascade_min_points` | **620** | Por debajo, la cascada se abstiene | ídem | 2026-07-29 | Con la mediana a medio formar la señal se diluía casi a la mitad (+14,5 → +31,3 de lift) |
| `dynamicNearLevelPct` | 1,5×ATR%, suelo 0,5 %, techo **por TF** 2/4/10/25 % | Cercanía a nivel clave (veto y contradicción) | T5 | 2026-07-26 | El suelo muerde el **47,9 % del decil más tranquilo en 1h** y el **0,0 % en 4h** → pendiente **B2** |
| `SR_LOOKBACK` · `SR_MIN_TOUCHES` | 100 · 1 | Construcción de niveles S/R | T4 | 2026-07-26 | Con pivotes fractales un toque ya es un rechazo real; exigir 2 dejaba el 1W sin niveles |
| `MIN_TOUCHES` (veto) | **3** | Qué es "nivel fuerte" | T4 | 2026-07-26 | Selecciona el **22,1 %** de los niveles en 4h (antes de T4, el 89 %) |
| `SR_TOLERANCE_PCT` | 0,005 (**absoluto**) | Agrupamiento de pivotes en niveles | U2, 180 d × 3 monedas × 3 TFs | 2026-08-03 | **MEDIDO Y DEFECTUOSO:** ×1,55-1,80 de diferencia entre monedas en unidades de ATR; y entre TFs **1h 42,9-55,2 % · 4h 18,0-29,5 % · 1D 2,9-5,5 %**. Pendiente **F2** con `k ≈ 0,35` |
| `cvd_strength` | terciles de su serie + suelo 0,25 % | Fuerza del CVD (pata del veto) | T3 | 2026-07-26 | Los cortes fijos 2 %/8 % dejaban `strong` vacío por encima de 1h |
| `ADX_TRENDING_THRESHOLD` | terciles (**25 sólo de fallback**) | Si ADX pondera en `computeTrend` | T2 | 2026-07-26 | El 25 caía en el percentil ~50: moneda al aire |
| `high_volatility` | p90 del ATR% **Y** ≥1,5× la mediana | Régimen | T1 | 2026-07-26 | Con la condición sola, un mercado plano salía "volátil" |
| `volatility_state` | terciles de `width_pct` | Squeeze/normal/expansión | anclas sin solape | 2026-08-01 | Reparto real **35,9 / 31,3 / 32,8 ±3,4** — el "24-42 %" era ruido del estimador (§3) |
| banda de `classifyOutcome` | 0,25×ATR% | Qué es un movimiento nulo | — | 2026-07-27 | Antes 0,3 % fijo para toda moneda y TF |
| `MIN_DIRECTIONAL_SAMPLE` | 20 | Gate del win-rate | — | — | **No** aplica a `expectancy_r`: a n=20 el IC de una media en R sigue siendo ±0,57R |
| línea base de `expectancy_r` | **+0,004R** [−0,036, +0,044] | Contra qué se lee la expectativa | 7 formas reales × anclajes de 4h | 2026-08-01 | **M10 (04-08): válida sólo con el stop a ≥1,5×ATR de la entrada** — por debajo no es determinable (§4) |
| frecuencia del veto | **8,2 %** (29-07) · **6,6 %** (03-08) | — | 90 d, ventana RODANTE | — | Las dos son correctas: son ventanas distintas del mismo estimador. **Citar siempre con fecha** |

---

## 2. Cambios MEDIDOS y DESCARTADOS — no reproponer sin dato nuevo

> Esta es la sección con más valor por línea. Cada entrada costó una medición completa.

| Propuesta | Veredicto | Por qué |
|---|---|---|
| **Dictamen direccional (`bias` continuo)** | ❌ **NO-GO** (fase 0, 03-08) | Queda **por debajo del azar en 3 de 3 monedas** y no supera a la deriva — perdiendo **in-sample**. El techo del oráculo (39,5-55,0 % contra un azar del 16-27 %) dice que la señal existe; lo que no existe es una feature que la capture |
| **Predecir la dirección de un movimiento limpio** | ❌ **NO-GO** (M9, 03-08) | 7 features pre-registradas: 6 replicaban en el periodo principal y **el contra-periodo las tumbó** (`st_4h` y `smc_bos` cambian de signo). Caso de estudio del pre-registro |
| **`OPPORTUNITY_BASE_RATE` como tabla por régimen (45,6 % en el cuartil tranquilo)** | ❌ **RETRACTADA el mismo día** (01-08) | El efecto no sobrevive a dos correcciones: clave RELATIVA (los cuartiles de ATR% absoluto eran casi una clasificación por MONEDA) y anclajes DISJUNTOS. Los cinco IC se solapan. **El 34,8 % está bien** |
| **Aflojar la banda del eje OI×precio a 0,75× o 1,00×** | ❌ | Aquellas filas tenían n=3-7 y se presentaron junto a otras de n=42. Con `MIN_N=15` la conclusión se cae |
| **Regla de régimen por DVOL** | ❌ | Dos de cuatro buckets muertos (0,3 %), efecto dentro del ruido, y **redundante** con el ATR% del propio activo (doble conteo con un proxy indirecto y con retardo) |
| **`conditional_low_rr` (avisar si R:R < 1)** | ❌ **RETIRADO** (01-08) | La expectativa es **plana en todo el rango de R:R**: el acierto baja exactamente lo que sube el premio. Lo único que cambia ya viaja en `breakeven_win_rate_pct` |
| **"Un R:R bajo rinde peor" (el +0,204R del barrido A)** | ❌ | Era **selección por el llenado**: la entrada estaba 0,75×ATR en contra y sólo se llena tras un movimiento adverso, capturando reversión. Con la entrada EN el precio el gradiente se aplana a −0,004R |
| **Aflojar `veto_short` con rechazo confirmado (C3)** | ❌ **no tocar** | La dirección prohibida gana más que el complemento en las 3 monedas, **pero los IC solapan en las tres** (n_ef 8/7/2). Y cada moneda dispara UNA sola dirección del veto en 90 d |
| **Abrir la puerta de venta a la caída ordenada (C7)** | ❌ | +2,1 pt con IC cruzando la base, sin replicar. El control simétrico alcista (+12,4 condicionado) sugiere que **la vía es reforzar la COMPRA, no abrir la venta** |
| **`risk_score` con rúbrica medida (M3)** | ❌ **innecesaria** | Se decidió RETIRARLO del panel. Medir una magnitud que se va a borrar es trabajo inútil por definición |
| **Quitar el redondeo del ATR** | ❌ | Efecto en la banda ≤0,008 pp y **0,139 % de celdas cambian**; quitarlo movería todos los umbrales normalizados a cambio de nada |
| **La curva de línea base de la expectativa (M10 tal como se planteó)** | ❌ **no existe** (04-08) | La vigencia **no importa**: −0,622/−0,625/−0,615/−0,626 con V=6/12/24/42. Y el rincón negativo no es del mercado (§4) |

---

## 3. Cifras que se publicaron y luego resultaron ser ruido o artefacto

> Todas eran **plausibles**. Ninguna dio un error. Esta lista existe porque el patrón se repite.

| Cifra publicada | Qué era en realidad | Cómo se destapó |
|---|---|---|
| `volatility_state` "24-42 % por bucket" | **Ruido del estimador.** La ventana rodaba vela a vela, así que dos ventanas comparten `win−1` cierres: el n efectivo era ~13× menor. Reparto real 35,9/31,3/32,8 | Anclas SIN SOLAPE + nulo Monte Carlo |
| Expectativa **−0,221R** "concluyentemente negativa" | **Denominador.** Contaba sólo `tp1`+`stop`, subconjunto enriquecido en stops por la GEOMETRÍA. 1.172 caducados frente a 1.064 resueltos → se tiraba el 52 % siempre por el mismo lado. Real: **+0,004R** | Contar qué se estaba excluyendo |
| Asimetría del score de volumen en BTC (11,8/34,2 vs 20,1/29,2) | **Ruido de estimación leído como cambio.** Con anclas sin solape: +17,3 ±7,3 / −34,6 ±9,1, y ambos pares caen dentro | Reflexión al 100 % (el código no puede sesgar) + anclas disjuntas |
| `offered_pct 0,0` con **lift −36** a 7 d | **Cero observaciones maduras presentadas como abstención brillante.** Ninguna de las 7 filas llegaba a 66 h de las 168 del horizonte | Gate de vencimiento (`horizonMatured`) |
| Base de oportunidad 11-15 % en `auditDvolRegime` | **Bug de signo**: `if (dnAdv) return null` descartaba el ancla cuando el precio SUBÍA, que es favorable a la tesis alcista. Subestimaba por un factor 3 | La discrepancia con el 34,8 % de otro script — que estaba delante y no se cuestionó |
| 100 % de recorte en los topes del ATR, en los 4 TFs | **Artefacto**: comparaba contra la salida ya redondeada en vez de contra los límites | Un 100 % exacto repetido en cuatro filas es firma de artefacto |
| Azar del **8,5 %** en la fase 0 | El brazo de azar alternaba por paridad del índice y **se aliasaba con el espaciado de la cadena disjunta** → dirección constante. Real: 24,1 % | Mezcla exacta como control |
| "6 de 7 features replican; el mercado revierte" (M9) | **Coherente, replicado en 3 monedas… y falso** | Contra-periodo pre-registrado |
| "El `conditional_setup` es internamente incoherente" (M7) | **Se midió la rama equivocada.** Describe *break-and-retest*, que era una tercera rama sin medir | Releer un caso real |
| Curva de `TRIGGER_BASE_RATE` **−3,3 pt** con el ATR de 180 (M4) | **Confundido de periodo**: con 180 el primer anclaje llega 161 velas más tarde. De los −3,3, sólo **−0,9** eran el ATR | Igualar el conjunto de anclajes (`ANCHOR_START`) |
| 7 diferencias de payload en `order_book` tras el refactor (B5) | **Suelo de ruido de la fuente**: el servicio no cachea. El control nulo dio **12** en el mismo bloque | Comparar la versión vieja **contra sí misma** |
| Diff de payload "limpio" en CVD y VWAP (B5) | **Pase por vacío**: sin `initDb()` la hidratación falla en silencio y ambas versiones daban `null` | Hacer que el arnés declare su COBERTURA · **arreglado en origen**, ver §4-bis |
| Cascada de longs al **9,9 %** (SOL, 30-07) | **No reproduce**: el mismo script da **4,1 %** el 04-08. Por meses: 5,9 / 3,2 / 23,5 % | Re-ejecutar el script original como control |
| El rezago del ATR explica la banda inflada | **Apunta al revés**: por NIVEL manda la reversión a la media y en calma el ATR se queda **CORTO un 18 %** | Separar pendiente de nivel |
| "Barreras estrechas ⇒ la asimetría 2:1 muerde" (M8) | **Reclasificado**: el mecanismo dominante es el convenio de empate del evaluador a 1h (§4) | Contrafactual de `auditBarrierTies` por celda |

---

## 4. M10 · lo que sustituye a la curva que no existe

La línea base de `expectancy_r` **no depende de la vigencia** y **no es una curva**. Es plana en
≈0 salvo en un rincón, y ese rincón **no es del mercado**:

| Geometría | Empates entrada↔stop en la MISMA vela de 1h | E[R] observado → convenio opuesto |
|---|---|---|
| entrada 1,0×ATR · stop 0,5×ATR | **66,2 %** | −0,622 → **+0,034** |
| entrada 0,5×ATR · stop 0,5×ATR | 49,2 % | −0,446 → +0,018 |
| entrada 0,25×ATR · stop 0,5×ATR | 22,1 % | −0,160 → +0,022 |
| **stop ≥ 1,5×ATR (cualquier entrada)** | **<3 %** | banda <0,03R → **determinado** |

El orden intra-vela no es observable a resolución de 1h, así que **ninguno de los dos convenios
es el correcto** y lo honesto es la banda que ambos acotan. Donde mide 0,66R, esa geometría
sencillamente **no tiene línea base legible**.

**Consecuencia operativa:** no hace falta una curva, hace falta una **guarda**. Si un setup
declara el stop a menos de ~1,5×ATR de la entrada, su expectativa no se enseña. Mismo patrón
que `TARGET_UNREACHABLE_PCT`: no un número que pintar, sino una condición para callarse. Los
`conditional_setup` reales llevan el stop a ~1,7×ATR, o sea **dentro de la meseta**.

---

## 4-bis. El único cambio de código que salió de todo esto

Las mediciones de L4 no tocan producción, pero B5 destapó un defecto que sí merecía arreglo, y
**no era un bug activo**: era una degradación silenciosa que produce un valor plausible.

`loadSeries` (`historyService.js`) hidrata CVD y VWAP desde `history_series`. `getDb()` **lanza**
si nadie ha llamado a `initDb()`, y el `catch` convertía eso en `[]` con nivel `debug` —
invisible en producción. Resultado: **«no he podido mirar» y «la serie está vacía» eran el mismo
valor**. En producción no muerde (`app.js` inicializa antes que nada), pero cualquier script,
test o futuro reproductor histórico se lo comía sin enterarse. De hecho se lo comió el diff de
B5, que pasó por vacío sobre medio payload.

**Arreglo:** los dos casos siguen degradando a `[]` —fallar ahí no debe tumbar la app— pero el
de BBDD no disponible avisa en **`warn`** y con un mensaje que dice exactamente eso. Guarda en
`tests/historyHydrationWarning.test.js`, **verificada reintroduciendo el defecto** (falla) y
quitándolo (pasa).

**Lo que NO se hizo, y por qué:** normalizar la hidratación para que las siete series se carguen
igual. La asimetría es correcta — las otras cinco vienen de APIs que sirven su propio histórico
y se refrescan enteras en cada poll, así que hidratarlas sería trabajo pisado segundos después.
Y unificarlo **añadiría** riesgo: mezclar dos procedencias en una misma serie es justo lo que
`backfillHistorySeries` aborta por diseño (CVD `heuristic` vs `taker_real`) y lo que ya costó
caro con las liquidaciones guardadas como USD siendo monedas.

> **La lección transferible:** un `catch` que devuelve un valor por defecto está eligiendo, sin
> decirlo, que «no lo sé» se lea como un dato. Cuando ese valor por defecto es plausible —`[]`,
> `0`, `null`— nadie lo nota nunca.

---

## 5. Los controles que cazaron cada número falso

Ordenados por veces que han servido. Si sólo se recuerda una sección de este documento, ésta.

1. **Anclajes DISJUNTOS.** Ventanas solapadas inflan el n efectivo y estrechan el IC. Ha cazado
   el 24-42 %, la asimetría de volumen y el IC de `auditPathWinRate`.
2. **El punto y el IC, de la MISMA muestra.** Un punto fuera de su propio intervalo es la firma.
   Apareció en M8 y **dos veces más en M10**, ya sabiéndolo.
3. **Contra-periodo pre-registrado.** Lo único que detectó M9.
4. **Control positivo con respuesta conocida.** `ENTRY_K=0` debe dar 0 exacto; `wins(Comprar)+wins(Vender)`
   debe igualar `offered`; la reflexión debe dar el 100 %.
5. **Control NULO / suelo de ruido.** Comparar algo contra sí mismo antes de creerse una diferencia.
6. **Declarar la COBERTURA.** Un diff que compara dos `null` "coincide" sin ejecutar nada.
   Y en el origen: que un fallo de lectura no devuelva el mismo valor que un dato vacío (§4-bis).
7. **Re-ejecutar el script original.** Distingue "cambió el método" de "cambió el periodo".
8. **Igualar el conjunto de anclajes** al comparar dos variantes.
9. **Preguntar con qué se INDEXA** antes de construir una tabla por régimen.
10. **Mirar la MEDIANA de lo que se bucketiza** antes de escribir el corte.

---

## 6. Lo que sigue sin explicación

- **El `lift` −55 del shadow trade.** La explicación que se le dio (curva de disparo mal
  calibrada en el régimen actual) quedó **desmentida**: la curva calibra donde vive producción.
- **La banda muerta del OI predice caídas mejor que `OI↑`** en el grupo bajista (SOL +17,0,
  BTC +15,7, n≈30). Sin lectura mecánica. Si no fuera ruido, invalidaría la premisa del cuadro.
- **Por qué la cascada no reproduce su 9,9 %** con sólo 4 días de rodaje de ventana. Los días
  anteriores al 2026-05-06 ya no los sirve ni la API ni el archivo.
- **`D1` · calibración de la convicción**: nadie ha comprobado si un 0,3 se comporta distinto
  de un 0,7. Falta muestra, no método.
