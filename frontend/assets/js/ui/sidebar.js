/**
 * sidebar.js — Actualización del DOM de la sidebar y el header
 *
 * Funciones exportadas:
 *   updateHeader(state)         — precio, variación 24h, BTC dominance
 *   updateRegimeBadge(state)    — badge TRENDING / RANGING / HIGH_VOLATILITY
 *   updateIndicators(state)     — panel de indicadores técnicos
 *   updateSentiment(state)      — Fear & Greed, derivados
 *   updateRecommendation(rec)   — panel de análisis IA
 *   showRecommendationLoading() — spinner "Analizando..."
 *   hideRecommendationLoading() — vuelve al estado vacío
 */

import { renderRiskGeometryCard } from './riskGeometryCard.js';

// ── Helpers ────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

let _prevPrice = null;

/** Dispara una animación CSS en `el` añadiendo y quitando `cls`. */
function flashEl(el, cls) {
  if (!el) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // forzar reflow para re-disparar animación
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/** Formatea un timestamp ISO como tiempo relativo (ej: "5m", "2h"). */
function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'ahora';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? '—';
}

function setClass(el, ...classes) {
  if (!el) return;
  // `BUY|SELL|HOLD` eran tokens de la acción (retirada con el pivot a ayudante de riesgo,
  // §REORIENTACIÓN). `bullish|bearish|neutral|up|down|up_trend|down_trend` se quedan: los
  // reutilizan indicadores/sentimiento sin relación con ninguna decisión.
  el.className = el.className.replace(/\b(bullish|bearish|neutral|up|down|up_trend|down_trend)\b/g, '').trim();
  el.classList.add(...classes.filter(Boolean));
}

function setValueRow(id, value, cssClass = null) {
  const el = $(id);
  if (el) {
    el.textContent = value ?? '—';
    if (cssClass) setClass(el, cssClass);
  }
}

function fmt(n, decimals = 2) {
  if (n == null) return '—';
  return parseFloat(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Formatea un NIVEL de precio (soporte/resistencia).
 *
 * Distinto de `fmtPrice` a propósito: los niveles son PROMEDIOS de clusters de pivotes, así
 * que arrastran decimales de cálculo. `fmtPrice` permite hasta 4 por debajo de $100, y eso
 * pintaba "$73.4633" para un soporte de SOL — cinco cifras significativas para un nivel que
 * es una media aproximada. Sugiere una precisión que el dato no tiene (2026-07-29).
 */
function fmtLevel(n) {
  if (n == null) return '—';
  // `minimumFractionDigits` fija los decimales: sin él, `toLocaleString` recorta los ceros
  // finales y en una COLUMNA de niveles salía "$72.8" junto a "$73.46", desalineado.
  if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

/** Pluraliza el conteo de toques: antes salía "1 touches". */
function fmtTouches(t) {
  const n = t || 0;
  return `${n} ${n === 1 ? 'touch' : 'touches'}`;
}

function fmtPrice(n) {
  if (n == null) return '—';
  if (n >= 10000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 100)   return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function signalClass(signal) {
  if (!signal) return 'neutral';
  const s = signal.toLowerCase();
  if (s.includes('bull') || s.includes('overbought') || s === 'up' || s === 'healthy') return 'bullish';
  if (s.includes('bear') || s.includes('oversold')  || s === 'down')                   return 'bearish';
  return 'neutral';
}

/**
 * Convierte una señal de texto a un indicador visual con flechas.
 * Devuelve un objeto { icon, class } para renderizar en el sidebar.
 *
 * Mapeo:
 * - 'healthy', 'neutral' → "→" (gris)
 * - 'up', 'bullish' → "↑" / "↑↑" / "↑↑↑" según intensidad
 * - 'down', 'bearish' → "↓" / "↓↓" / "↓↓↓" según intensidad
 * - 'overbought' → "↑↑" (bullish fuerte)
 * - 'oversold' → "↓↓" (bearish fuerte)
 * - cruces y cambios → ajuste de flechas
 */
function signalToArrow(signal) {
  if (!signal) return { icon: '→', class: 'neutral' };

  const s = signal.toLowerCase();

  // Neutro
  if (s === 'neutral' || s === 'healthy') return { icon: '→', class: 'neutral' };

  // Bullish
  if (s.includes('bullish') || s === 'up') return { icon: '↑', class: 'bullish' };
  if (s === 'overbought' || s === 'cross up') return { icon: '↑↑', class: 'bullish' };
  if (s.includes('strong bullish') || s.includes('extreme bullish')) return { icon: '↑↑↑', class: 'bullish' };

  // Bearish
  if (s.includes('bearish') || s === 'down') return { icon: '↓', class: 'bearish' };
  if (s === 'oversold' || s === 'cross down') return { icon: '↓↓', class: 'bearish' };
  if (s.includes('strong bearish') || s.includes('extreme bearish')) return { icon: '↓↓↓', class: 'bearish' };

  return { icon: '→', class: 'neutral' };
}

function setIndicatorRow(id, value, signal, signalText) {
  const row = $(id);
  if (!row) return;
  const [, valEl, sigEl] = row.children;
  if (valEl) valEl.textContent = value ?? '—';
  if (sigEl) {
    const arrow = signalToArrow(signal || signalText);
    sigEl.textContent = arrow.icon;
    setClass(sigEl, arrow.class);
  }
}

// ── Header ─────────────────────────────────────────────────────────

export function updateHeader(state) {
  const { priceCurrent, priceChange, btcDominance, coin } = state;

  // Precio + flash al cambiar
  const priceEl = $('price-display');
  if (priceEl) {
    priceEl.textContent = fmtPrice(priceCurrent);
    if (_prevPrice !== null && priceCurrent != null && priceCurrent !== _prevPrice) {
      flashEl(priceEl, priceCurrent > _prevPrice ? 'flash-up' : 'flash-down');
    }
    if (priceCurrent != null) _prevPrice = priceCurrent;
  }

  // Variación 24h
  const changeEl = $('price-change');
  if (changeEl) {
    if (priceChange != null) {
      const sign = priceChange >= 0 ? '+' : '';
      changeEl.textContent = `${sign}${fmt(priceChange)}%`;
      changeEl.className = 'price-change ' + (priceChange >= 0 ? 'up' : 'down');
    } else {
      changeEl.textContent = '—';
      changeEl.className = 'price-change';
    }
  }

  // BTC Dominance (solo si hay dato)
  const domEl = $('btc-dominance');
  if (domEl) {
    domEl.textContent = btcDominance != null
      ? `BTC.D ${fmt(btcDominance, 1)}%`
      : `BTC.D —`;
  }

  // Selector de moneda (sincroniza dropdown sin disparar events)
  const sel = $('coin-select');
  if (sel && sel.value !== coin) sel.value = coin;
}

// ── Regime badge ───────────────────────────────────────────────────

export function updateRegimeBadge(state) {
  const badge = $('regime-badge');
  if (!badge) return;

  const tech   = state.technical?.[state.tf];
  const regime = typeof tech?.regime === 'string'
    ? tech.regime.toUpperCase()
    : tech?.regime?.regime?.toUpperCase();

  if (!regime) {
    badge.classList.add('hidden');
    return;
  }

  badge.textContent = regime.replace('_', ' ');
  badge.className   = `regime-badge ${regime}`;
}

// ── Indicators panel ───────────────────────────────────────────────

export function updateIndicators(state) {
  const tech = state.technical?.[state.tf];

  // Label de TF activo
  const tfLabel = $('indicators-tf');
  if (tfLabel) tfLabel.textContent = state.tf;

  if (!tech) {
    ['ind-rsi','ind-macd','ind-stochrsi','ind-bb','ind-adx','ind-supertrend','ind-wavetrend','ind-voldelta']
      .forEach(id => setIndicatorRow(id, '—', null, '—'));
    return;
  }

  // RSI
  if (tech.rsi) {
    setIndicatorRow(
      'ind-rsi',
      fmt(tech.rsi.value, 1),
      tech.rsi.signal,
      tech.rsi.signal ?? '—',
    );
  }

  // MACD
  if (tech.macd) {
    const dir = tech.macd.histogram >= 0 ? 'bullish' : 'bearish';
    setIndicatorRow(
      'ind-macd',
      fmt(tech.macd.value, 4),
      dir,
      tech.macd.histogram_color ?? dir,
    );
  }

  // StochRSI
  if (tech.stoch_rsi) {
    const k   = tech.stoch_rsi.k ?? tech.stoch_rsi.stoch_k;
    const d   = tech.stoch_rsi.d ?? tech.stoch_rsi.stoch_d;
    const sig = k != null && k > 80 ? 'overbought' : k != null && k < 20 ? 'oversold' : 'neutral';
    setIndicatorRow(
      'ind-stochrsi',
      k != null ? `${fmt(k,1)} / ${fmt(d,1)}` : '—',
      sig,
      sig,
    );
  }

  // Bollinger Bands %B
  if (tech.bollinger_bands) {
    const bb  = tech.bollinger_bands;
    const pct = bb.percent_b ?? bb.position;
    const sig = pct != null && pct > 1 ? 'overbought' : pct != null && pct < 0 ? 'oversold' : 'neutral';
    setIndicatorRow(
      'ind-bb',
      pct != null ? fmt(pct, 2) : '—',
      sig,
      bb.status ?? sig,
    );
  }

  // ADX
  if (tech.adx) {
    const dir = tech.adx.trend_direction ?? 'neutral';
    setIndicatorRow(
      'ind-adx',
      fmt(tech.adx.adx, 1),
      dir,
      `${dir} (${fmt(tech.adx.adx, 0)})`,
    );
  }

  // SuperTrend
  if (tech.super_trend) {
    const st    = tech.super_trend;
    const dir   = st.trend === 'UP' ? 'bullish' : 'bearish';
    const level = st.trend === 'UP' ? st.support : st.resistance;
    setIndicatorRow(
      'ind-supertrend',
      fmtPrice(level),
      dir,
      st.trend ?? '—',
    );
  }

  // WaveTrend
  if (tech.wave_trend) {
    const wt          = tech.wave_trend;
    const backendSig  = wt.signal ?? 'neutral';

    let sig, sigText;
    if (backendSig === 'oversold_cross_up') {
      sig = 'bullish'; sigText = 'cross up';
    } else if (backendSig === 'overbought_cross_down') {
      sig = 'bearish'; sigText = 'cross down';
    } else if (backendSig === 'overbought') {
      sig = 'bullish'; sigText = 'overbought';
    } else if (backendSig === 'oversold') {
      sig = 'bearish'; sigText = 'oversold';
    } else {
      // Sin señal extrema: dirección por cruce WT1 vs WT2
      sig     = wt.wt1 > wt.wt2 ? 'bullish' : wt.wt1 < wt.wt2 ? 'bearish' : 'neutral';
      sigText = sig;
    }

    setIndicatorRow(
      'ind-wavetrend',
      wt.wt1 != null ? `${fmt(wt.wt1,1)} / ${fmt(wt.wt2,1)}` : '—',
      sig,
      sigText,
    );
  }

  // Volume Delta
  if (tech.volume_delta) {
    const vd  = tech.volume_delta;
    const sig = vd.buy_pressure_pct >= 50 ? 'bullish' : 'bearish';
    setIndicatorRow(
      'ind-voldelta',
      vd.buy_pressure_pct != null ? `${vd.buy_pressure_pct}% buy` : '—',
      sig,
      vd.last_candle_type ?? sig,
    );
  }
}

// ── Sentiment helpers ───────────────────────────────────────────────

/** Countdown to next funding time (Unix seconds). Returns "en Xh Ym" or "en Ym". */
function fmtNextFunding(ts) {
  const diffSec = ts - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return null;
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  return h > 0 ? `en ${h}h ${m}m` : `en ${m}m`;
}

/** Maps OI signal to arrow icon + CSS class. */
function oiSignalToArrow(signal) {
  switch (signal) {
    case 'increasing_fast': return { icon: '↑↑', class: 'bullish' };
    case 'increasing':      return { icon: '↑',  class: 'bullish' };
    case 'decreasing':      return { icon: '↓',  class: 'bearish' };
    case 'decreasing_fast': return { icon: '↓↓', class: 'bearish' };
    default:                return { icon: '→',  class: 'neutral'  };
  }
}

/** Maps L/S ratio signal to contrarian arrow icon + CSS class. */
function lsrSignalToArrow(signal) {
  switch (signal) {
    case 'longs_dominant_contrarian_bear':  return { icon: '↓', class: 'bearish' };
    case 'shorts_dominant_contrarian_bull': return { icon: '↑', class: 'bullish' };
    default:                                return { icon: '→', class: 'neutral'  };
  }
}

// ── Sentiment panel ────────────────────────────────────────────────

export function updateSentiment(state) {
  const { fearGreed, derivatives } = state;

  // Fear & Greed — el número por sí solo no dice nada: un 29 solo significa algo si se sabe
  // que es "Fear", y una flecha sola no dice CUÁNTO ni RESPECTO A QUÉ. Antes se pintaban dos
  // flechas con lógicas distintas (una en el valor, otra en la señal) y la clasificación no
  // aparecía en ninguna parte — solo en el tooltip. Reescrito el 2026-07-29:
  //   valor  → "29 · Fear"     (la banda, que es lo que interpreta el número)
  //   señal  → "-4 7d"         (delta NUMÉRICO con su referencia explícita)
  // El delta es `trend_7d_change`, que ya venía en el payload y no lo mostraba nadie. Se usa
  // el de 7 días y no el de 1 porque el índice se mueve poco a diario: la variación semanal
  // es la que informa. La referencia va escrita para que nunca haya que adivinarla.
  if (fearGreed) {
    const band = fearGreed.classification ?? null;
    setText('fear-greed-value', band ? `${fearGreed.value} · ${band}` : `${fearGreed.value}`);

    const fgEl = $('fear-greed-label');
    if (fgEl) {
      const d = fearGreed.trend_7d_change;
      if (Number.isFinite(d)) {
        fgEl.textContent = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} 7d`;
        // Sube el índice = menos miedo = sesgo alcista de sentimiento, y al revés.
        fgEl.className = 'sent-signal ' + (d > 0 ? 'bullish' : d < 0 ? 'bearish' : 'neutral');
      } else {
        fgEl.textContent = '—';
        fgEl.className = 'sent-signal ' + fgSignalClass(fearGreed.value);
      }
    }
  }

  // Derivados (Coinalyze) — se ocultan si no hay datos
  const derivBlock = $('derivatives-block');
  if (!derivatives) {
    if (derivBlock) derivBlock.style.display = 'none';
    return;
  }
  if (derivBlock) derivBlock.style.display = '';

  // Funding Rate
  const fr = derivatives.funding_rate;
  if (fr) {
    const sign      = fr.rate_pct >= 0 ? '+' : '';
    const trendArr  = fr.trend === 'rising' ? ' ↑' : fr.trend === 'falling' ? ' ↓' : '';
    const frEl = $('funding-rate');
    if (frEl) {
      frEl.textContent = `${sign}${fmt(fr.rate_pct, 4)}%${trendArr}`;
      frEl.className   = 'sent-value ' + (fr.rate_pct > 0.05 ? 'price-change up' : fr.rate_pct < -0.02 ? 'price-change down' : '');
    }
    const detailEl = $('funding-rate-detail');
    if (detailEl) {
      const parts = [];
      if (fr.annualized_pct != null) {
        const s = fr.annualized_pct >= 0 ? '+' : '';
        parts.push(`${s}${fmt(fr.annualized_pct, 1)}% anual`);
      }
      if (fr.predicted_rate_pct != null) {
        const s = fr.predicted_rate_pct >= 0 ? '+' : '';
        parts.push(`pred: ${s}${fmt(fr.predicted_rate_pct, 4)}%`);
      }
      if (fr.next_funding_time != null) {
        const remaining = fmtNextFunding(fr.next_funding_time);
        if (remaining) parts.push(remaining);
      }
      detailEl.textContent = parts.join(' · ');
    }

    // Funding Rate signal
    const frSignalEl = $('funding-rate-signal');
    if (frSignalEl && fr.signal) {
      const signalMap = {
        'longs_overloaded': { text: '↑ LONGS', cls: 'bearish' },
        'shorts_overloaded': { text: '↓ SHORTS', cls: 'bullish' },
        'balanced': { text: '→', cls: 'neutral' },
      };
      const s = signalMap[fr.signal] ?? { text: '—', cls: 'neutral' };
      frSignalEl.textContent = s.text;
      frSignalEl.className = `sent-signal ${s.cls}`;
    }
  }

  // Predicted Funding Rate
  const predPct = derivatives?.funding_rate?.predicted_rate_pct;
  setText('predicted-funding-rate',
    predPct != null ? `${predPct >= 0 ? '+' : ''}${predPct.toFixed(4)}%` : '—'
  );

  // Open Interest
  const oi = derivatives.open_interest;
  if (oi) {
    if (oi.value_usd != null && oi.value_usd > 0) {
      const val       = oi.value_usd;
      const absFormatted = val >= 1e9 ? `$${(val / 1e9).toFixed(2)}B`
        : val >= 1e6 ? `$${(val / 1e6).toFixed(1)}M`
        : `$${val.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      const changePart = oi.change_24h_pct != null
        ? ` (${oi.change_24h_pct >= 0 ? '+' : ''}${oi.change_24h_pct}%)`
        : '';
      setText('open-interest', `${absFormatted}${changePart}`);
    } else {
      setText('open-interest', '—');
    }
    const oiSignalEl = $('open-interest-signal');
    if (oiSignalEl) {
      const arrow = oiSignalToArrow(oi.signal);
      oiSignalEl.textContent = arrow.icon;
      setClass(oiSignalEl, 'sent-signal', arrow.class);
    }
  }

  // Long/Short
  const lsr = derivatives.long_short_ratio;
  if (lsr) {
    const lsEl = $('long-short');
    if (lsEl) {
      lsEl.textContent = `${fmt(lsr.long_pct, 1)}% L / ${fmt(lsr.short_pct, 1)}% S`;
      if (lsr.signal === 'longs_dominant_contrarian_bear') {
        lsEl.className = 'sent-value price-change down';
      } else if (lsr.signal === 'shorts_dominant_contrarian_bull') {
        lsEl.className = 'sent-value price-change up';
      } else {
        lsEl.className = 'sent-value';
      }
    }
    const lsrSignalEl = $('long-short-signal');
    if (lsrSignalEl) {
      const arrow = lsrSignalToArrow(lsr.signal);
      lsrSignalEl.textContent = arrow.icon;
      setClass(lsrSignalEl, 'sent-signal', arrow.class);
    }
  }

  // Liquidaciones 24h
  const liq = derivatives.liquidations;
  const liqEl = $('liquidations');
  if (liq && liqEl) {
    // fmtLiq recibe USD CRUDOS y elige la escala. Antes asumía que el valor ya venía en
    // millones (`$${v}M`) y además se le pasaban MONEDAS, no dólares: con 17.281 SOL pintaba
    // "$17281M" — diecisiete mil millones de dólares de liquidaciones en SOL. El bug de
    // unidades tapaba el del formateador (2026-07-29).
    const fmtLiq = (v) => {
      if (!Number.isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
      if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
      if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
      return `$${v.toFixed(0)}`;
    };
    liqEl.textContent = `${fmtLiq(liq.longs_usd)} L / ${fmtLiq(liq.shorts_usd)} S`;
    // El color sale de `skew`, el eje canónico: negativo = se liquidan longs (presión bajista).
    // Antes usaba `liq.signal`, retirado el 2026-07-29 por competir con el umbral de la
    // cascada del Derivatives Score — el color quedaba muerto sin que se notara.
    liqEl.className   = 'sent-value ' + (
      !Number.isFinite(liq.skew)  ? ''
        : liq.skew <= -0.3        ? 'price-change down'
        : liq.skew >=  0.3        ? 'price-change up'
        : ''
    );
  } else if (liqEl) {
    liqEl.textContent = '—';
    liqEl.className   = 'sent-value';
  }
}

function fgSignalClass(value) {
  if (value == null) return '';
  if (value <= 24) return 'bearish';        // [0, 24] — Extreme Fear
  if (value < 50)  return 'bearish';        // [25, 49] — Fear
  if (value < 75)  return 'bullish';        // [50, 74] — Greed
  return 'bullish';                         // [75, 100] — Extreme Greed
}

// ── Recommendation panel ───────────────────────────────────────────

// Los divs del panel se ocultan con `style="display:none"` INLINE en index.html.
// Togglear solo la clase `.hidden` no anula un estilo inline → hay que fijar
// `style.display` explícitamente (además de limpiar la clase al mostrar).
function showEl(id, display = '') {
  const el = $(id);
  if (el) { el.classList.remove('hidden'); el.style.display = display; }
}
function hideEl(id) {
  const el = $(id);
  if (el) el.style.display = 'none';
}

export function showRecommendationLoading() {
  hideEl('recommendation-empty');
  hideEl('recommendation-content');
  showEl('recommendation-loading');
}

export function hideRecommendationLoading() {
  hideEl('recommendation-loading');
  hideEl('recommendation-content');
  showEl('recommendation-empty');
}

// Etiqueta legible de cada sección de la narrativa (mismo orden que el OUTPUT FORMAT del
// prompt, ver anthropicService.js). Solo se pintan las que traen texto — una fila vacía
// (p. ej. una fila anterior al pivot, con otro vocabulario de narrative) no deja un hueco.
const NARRATIVE_SECTIONS = [
  ['structure_read', 'Estructura'],
  ['divergences_anomalies', 'Divergencias y anomalías'],
  ['key_levels_and_liquidity', 'Niveles y liquidez'],
  ['volatility_and_regime', 'Volatilidad y régimen'],
  ['cycle_and_macro_read', 'Ciclo y macro'],
  ['scenarios', 'Escenarios'],
];

function renderNarrative(n) {
  const el = $('rec-narrative');
  if (!el) return;
  el.innerHTML = '';
  if (!n) { el.style.display = 'none'; return; }

  let any = false;
  for (const [key, label] of NARRATIVE_SECTIONS) {
    const text = n[key];
    if (typeof text !== 'string' || !text.trim()) continue;
    any = true;
    const block = document.createElement('div');
    block.className = 'rec-narrative-block';
    const lbl = document.createElement('div');
    lbl.className = 'rec-narrative-label';
    lbl.textContent = label;
    const p = document.createElement('p');
    p.className = 'rec-narrative-text';
    p.textContent = text;
    block.appendChild(lbl);
    block.appendChild(p);
    el.appendChild(block);
  }
  el.style.display = any ? '' : 'none';
}

/**
 * Renderiza el panel de Análisis IA — pivot a ayudante de riesgo (§REORIENTACIÓN): el LLM
 * ya no decide ni puntúa nada, solo narra. El panel muestra la lectura en prosa y la
 * geometría de riesgo SIMÉTRICA (largo+corto), nunca una acción recomendada.
 *
 * @param {{ narrative?: object, executive_summary?: string }|object} rec
 * @param {string} [timestamp] — ISO del análisis; si falta se usa la hora actual.
 * @param {object|null} [geometry] — forma de `computeRiskGeometry` (ver riskGeometryCard.js).
 */
export function updateRecommendation(rec, timestamp = null, geometry = null) {
  hideEl('recommendation-loading');
  hideEl('recommendation-empty');

  const contentEl = $('recommendation-content');
  if (!contentEl) return;
  contentEl.classList.remove('hidden');
  contentEl.style.display = ''; // anula el `display:none` inline del HTML

  const n = rec?.narrative ?? null;
  // Filas anteriores al pivot guardaban el resumen dentro de `structured`; una fila nueva
  // lo trae en el nivel superior. Ambas se leen, ninguna se inventa.
  const summary = rec?.executive_summary ?? rec?.structured?.executive_summary ?? null;

  setText('rec-rationale', summary ?? '—');
  renderNarrative(n);

  // ── GEOMETRÍA DE RIESGO SIMÉTRICA ────────────────────────────────────────
  // Dueño único en riskGeometryCard.js — la usan también las tarjetas del historial.
  const planEl = $('rec-plan');
  if (planEl) {
    planEl.innerHTML = '';
    const card = renderRiskGeometryCard(geometry ?? rec?.risk_geometry ?? null);
    if (card) { planEl.appendChild(card); planEl.style.display = ''; }
    else planEl.style.display = 'none';
  }

  // Timestamp (el del análisis si se conoce; si no, la hora actual)
  const tsEl = $('rec-timestamp');
  if (tsEl) {
    const when = timestamp ? new Date(timestamp) : new Date();
    tsEl.textContent = `Análisis a las ${when.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  }
}

// ── Soportes & Resistencias ────────────────────────────────────────

export function updateSupportResistance(state) {
  const tech = state.technical?.[state.tf];
  const sr = tech?.support_resistance;

  if (!sr) {
    // Ocultar panel si no hay datos
    const panel = $('sr-panel');
    if (panel) panel.style.display = 'none';
    return;
  }

  const panel = $('sr-panel');
  if (panel) panel.style.display = '';

  // Soportes (máximo 3)
  const supports = sr.supports || [];
  for (let i = 0; i < 3; i++) {
    const id = `sr-support-${i + 1}`;
    const el = $(id);
    if (!el) continue;

    if (supports[i]) {
      const sup = supports[i];
      el.textContent = `${fmtLevel(sup.price)} (${fmtTouches(sup.touches)})`;
      const strength = sup.strength ?? 0.5;
      setClass(el, strength > 0.7 ? 'bullish' : strength > 0.4 ? 'neutral' : 'bearish');
    } else {
      el.textContent = '—';
      setClass(el);
    }
  }

  // Resistencias (máximo 3)
  const resistances = sr.resistances || [];
  for (let i = 0; i < 3; i++) {
    const id = `sr-resistance-${i + 1}`;
    const el = $(id);
    if (!el) continue;

    if (resistances[i]) {
      const res = resistances[i];
      el.textContent = `${fmtLevel(res.price)} (${fmtTouches(res.touches)})`;
      const strength = res.strength ?? 0.5;
      setClass(el, strength > 0.7 ? 'bearish' : strength > 0.4 ? 'neutral' : 'bullish');
    } else {
      el.textContent = '—';
      setClass(el);
    }
  }
}

// ── Último Análisis ────────────────────────────────────────────────

export function updateLastAnalysis(state) {
  const last = state.lastAnalysis;
  const el = $('last-analysis-action');
  const tsEl = $('last-analysis-timestamp');

  if (!last) {
    if (el) el.textContent = '—';
    if (tsEl) tsEl.textContent = '—';
    return;
  }

  // `action` se retiró con el pivot a ayudante de riesgo (§REORIENTACIÓN) — este panel
  // compacto muestra ahora el resumen de la lectura en vez de una acción que ya no existe.
  // Acepta las dos formas de `full` (fila vieja con `.structured.executive_summary`, fila
  // nueva con `.executive_summary` en el nivel superior).
  if (el) {
    const summary = last.full?.executive_summary ?? last.full?.structured?.executive_summary ?? null;
    const short = summary && summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
    el.textContent = short ?? '—';
    el.title = summary ?? '';
    setClass(el);
  }

  if (tsEl) {
    tsEl.textContent = last.timestamp ? timeAgo(last.timestamp) : '—';
  }
}

// ── Muros Binance ──────────────────────────────────────────────────

export function updateBinanceWalls(state) {
  const walls = state.binanceWalls;
  // La unidad del volumen es la MONEDA ANALIZADA. Estaba hardcodeada a 'BTC', así que un
  // muro de 2.289 SOL se mostraba como "2,289.17 BTC" — unos 148 millones de dólares en vez
  // de 167.000. Información simplemente falsa (detectado 2026-07-29).
  const unit = state.coin ?? '';
  const buyEl = $('binance-buy-wall');
  const sellEl = $('binance-sell-wall');

  if (!walls) {
    if (buyEl) buyEl.textContent = '—';
    if (sellEl) sellEl.textContent = '—';
    return;
  }

  if (walls.buyWall && buyEl) {
    buyEl.textContent = `${fmtPrice(walls.buyWall.price)} (${fmt(walls.buyWall.volume, 2)} ${unit})`;
    setClass(buyEl, 'bullish');
  }

  if (walls.sellWall && sellEl) {
    sellEl.textContent = `${fmtPrice(walls.sellWall.price)} (${fmt(walls.sellWall.volume, 2)} ${unit})`;
    setClass(sellEl, 'bearish');
  }
}

// ── Global Market Data ─────────────────────────────────────────────

function fmtLargeUsd(n) {
  if (n == null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

export function updateGlobalMarket(state) {
  const gm = state.global_market;
  if (!gm) return;

  // Market cap total
  const cap = gm.total_market_cap_usd;
  setText('global-market-cap', cap ? fmtLargeUsd(cap) : '—');

  const chg = gm.market_cap_change_24h_pct;
  if (chg != null) {
    const el = $('global-market-cap-change');
    if (el) {
      el.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
      setClass(el, chg >= 0 ? 'bullish' : 'bearish');
    }
  }

  // BTC Dominance
  const dom = gm.btc_dominance;
  setText('global-btc-dominance', dom != null ? `${dom.toFixed(1)}%` : '—');

  // Altcoin Index
  const alt = gm.altcoin_market_cap_usd;
  setText('global-altcoin-cap', alt ? fmtLargeUsd(alt) : '—');
}

// ── Coin Market Data ───────────────────────────────────────────────

export function updateCoinMarketData(state) {
  // Actualizar el coin name en el header del bloque
  setText('asset-block-coin', state.coin ?? '—');

  const cmd = state.coin_market_data;
  if (!cmd) return;

  setText('asset-market-cap', cmd.market_cap_usd ? fmtLargeUsd(cmd.market_cap_usd) : '—');
  setText('asset-volume-24h', cmd.volume_24h_usd ? fmtLargeUsd(cmd.volume_24h_usd) : '—');

  // ATH
  setText('asset-ath', cmd.ath_usd ? fmtPrice(cmd.ath_usd) : '—');
  if (cmd.ath_change_pct != null) {
    const el = $('asset-ath-change');
    if (el) {
      el.textContent = `${cmd.ath_change_pct.toFixed(1)}%`;
      setClass(el, cmd.ath_change_pct >= 0 ? 'bullish' : 'bearish');
    }
  }

  // ATL
  setText('asset-atl', cmd.atl_usd ? fmtPrice(cmd.atl_usd) : '—');
  if (cmd.atl_change_pct != null) {
    const el = $('asset-atl-change');
    if (el) {
      el.textContent = `+${cmd.atl_change_pct.toFixed(0)}%`;
      setClass(el, 'bullish');
    }
  }
}

// ── Order Book (Microestructura) ───────────────────────────────────

export function updateOrderBook(state) {
  const walls = state.binanceWalls;
  const ticker = state.binanceTicker;

  // Precio actual + cambio
  setText('micro-price-current', state.priceCurrent ? fmtPrice(state.priceCurrent) : '—');
  const chg = state.priceChange;
  if (chg != null) {
    const el = $('micro-price-change');
    if (el) {
      el.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
      setClass(el, chg >= 0 ? 'bullish' : 'bearish');
    }
  }

  // Spread
  if (walls?.spread != null) {
    setText('micro-spread', fmtPrice(walls.spread));
    const pctEl = $('micro-spread-pct');
    if (pctEl && walls.spread_pct != null) {
      pctEl.textContent = `${walls.spread_pct.toFixed(4)}%`;
      setClass(pctEl, 'sent-signal', 'neutral');
    }
  }

  // Volumen Binance 24h (en USD desde ticker)
  if (ticker?.volume_24h_quote != null) {
    setText('micro-volume-24h', fmtLargeUsd(ticker.volume_24h_quote));
  }

  // Order book top 5 asks + bids
  if (walls?.asks_top5 && walls?.bids_top5) {
    const midPrice = walls.spread != null
      ? (walls.bids_top5[0].price + walls.asks_top5[0].price) / 2
      : null;

    setText('ob-mid-price', midPrice ? fmtPrice(midPrice) : '—');

    // Render asks (ordenadas best ask al final = closest to mid)
    const asksContainer = $('ob-asks-container');
    if (asksContainer) {
      const asksToShow = [...walls.asks_top5].reverse();
      asksContainer.innerHTML = asksToShow.map(a => `
        <div class="ob-row ob-ask">
          <span class="ob-price">${fmtPrice(a.price)}</span>
          <span class="ob-vol">${fmt(a.volume, 4)}</span>
        </div>
      `).join('');
    }

    // Render bids
    const bidsContainer = $('ob-bids-container');
    if (bidsContainer) {
      bidsContainer.innerHTML = walls.bids_top5.map(b => `
        <div class="ob-row ob-bid">
          <span class="ob-price">${fmtPrice(b.price)}</span>
          <span class="ob-vol">${fmt(b.volume, 4)}</span>
        </div>
      `).join('');
    }
  }
}
