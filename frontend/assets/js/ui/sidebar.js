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
  el.className = el.className.replace(/\b(bullish|bearish|neutral|up|down|up_trend|down_trend|BUY|SELL|HOLD)\b/g, '').trim();
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

  // Fear & Greed
  if (fearGreed) {
    const trendArrow = fearGreed.trend_1d === 'improving' ? ' ↑' : fearGreed.trend_1d === 'worsening' ? ' ↓' : '';
    setText('fear-greed-value', `${fearGreed.value}${trendArrow}`);

    const fgEl = $('fear-greed-label');
    if (fgEl) {
      const signalClass = fgSignalClass(fearGreed.value);
      let arrow = '→';
      if (fearGreed.trend_1d === 'improving') {
        arrow = fearGreed.value > 50 ? '↑↑' : '↑';
      } else if (fearGreed.trend_1d === 'worsening') {
        arrow = fearGreed.value < 50 ? '↓↓' : '↓';
      } else {
        arrow = fearGreed.value > 50 ? '↑' : fearGreed.value < 50 ? '↓' : '→';
      }
      fgEl.textContent = arrow;
      fgEl.className   = 'sent-signal ' + signalClass;
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
    const fmtLiq = v => v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${v.toFixed(0)}M`;
    liqEl.textContent = `${fmtLiq(liq.longs_usd)} L / ${fmtLiq(liq.shorts_usd)} S`;
    liqEl.className   = 'sent-value ' + (
      liq.signal === 'longs_dominant'  ? 'price-change down' :
      liq.signal === 'shorts_dominant' ? 'price-change up'   : ''
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

/**
 * Rellena el panel de recomendación IA con los datos recibidos.
 * @param {object} rec — objeto `recommendation` del backend
 */
// Formatea un score con signo explícito: +2 / 0 / -1 (o '?' si falta).
function fmtSigned(v) {
  if (v == null || Number.isNaN(v)) return '?';
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * Renderiza el panel de Análisis IA a partir del schema nuevo.
 * @param {{ structured: object, narrative?: object }|object} rec
 *   Acepta `{ structured, narrative }` o el propio `structured` directo.
 */
export function updateRecommendation(rec) {
  hideEl('recommendation-loading');
  hideEl('recommendation-empty');

  const contentEl = $('recommendation-content');
  if (!contentEl) return;
  contentEl.classList.remove('hidden');
  contentEl.style.display = ''; // anula el `display:none` inline del HTML

  const s = rec?.structured ?? rec ?? {};
  const n = rec?.narrative ?? null;

  // Acción
  const actionEl = $('rec-action');
  if (actionEl) {
    actionEl.textContent = s.action ?? '—';
    actionEl.className   = `rec-action ${s.action ?? ''}`;
  }

  // Confianza (ahora string: Alta / Media / Baja)
  setText('rec-confidence', s.confidence ?? '—');

  // Racional: resumen ejecutivo (fallback al detalle de la narrativa)
  setText('rec-rationale', s.executive_summary ?? n?.recommendation_detail ?? '—');

  // Niveles del setup táctico (solo si hay setup ejecutable)
  const setup = s.setup ?? null;
  const levelsEl = $('rec-levels');
  if (levelsEl) levelsEl.style.display = setup ? '' : 'none';
  setText('rec-entry', fmtPrice(setup?.entry_price));
  setText('rec-sl',    fmtPrice(setup?.stop_price));
  setText('rec-tp1',   fmtPrice(setup?.tp1_price));
  setText('rec-tp2',   fmtPrice(setup?.tp2_price));

  // Alertas / metadata (fail-safe, gating, scores, driver, riesgo, convicción)
  const alertsEl = $('rec-alerts');
  if (alertsEl) {
    alertsEl.innerHTML = '';
    const addAlert = (cls, msg) => {
      const div = document.createElement('div');
      div.className   = `rec-alert ${cls}`;
      div.textContent = msg;
      alertsEl.appendChild(div);
    };

    if (s.fail_safe_applied) {
      const orig = s.fail_safe_original_action ? ` (original: ${s.fail_safe_original_action})` : '';
      addAlert('warning', `⚠ Degradado a Esperar por fail-safe${orig}: ${(s.fail_safe_rules ?? []).join(', ')}`);
    }
    if (s.gating_active && s.gating_reason) {
      addAlert('watch', `Gating: ${s.gating_reason}`);
    }

    const sc = s.scores ?? {};
    const scoreStr = [['D', 'derivatives'], ['E', 'structure'], ['V', 'volume'], ['O', 'onchain']]
      .map(([lbl, key]) => `${lbl} ${fmtSigned(sc[key])}`).join(' · ');
    addAlert('info', `Scores: ${scoreStr} · Total ${fmtSigned(sc.total)}`);

    const bits = [];
    if (s.primary_driver != null) bits.push(`driver: ${s.primary_driver}`);
    if (s.risk_score != null)     bits.push(`riesgo ${s.risk_score}/10`);
    if (s.conviction != null)     bits.push(`convicción ${Math.round(s.conviction * 100)}%`);
    if (bits.length) addAlert('info', bits.join(' · '));
  }

  // Timestamp
  const tsEl = $('rec-timestamp');
  if (tsEl) {
    const now = new Date();
    tsEl.textContent = `Análisis a las ${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
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
      el.textContent = `${fmtPrice(sup.price)} (${sup.touches || 0} touches)`;
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
      el.textContent = `${fmtPrice(res.price)} (${res.touches || 0} touches)`;
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

  if (el) {
    el.textContent = last.action ?? '—';
    setClass(el, last.action ?? '');
  }

  if (tsEl) {
    tsEl.textContent = last.timestamp ? timeAgo(last.timestamp) : '—';
  }
}

// ── Muros Binance ──────────────────────────────────────────────────

export function updateBinanceWalls(state) {
  const walls = state.binanceWalls;
  const buyEl = $('binance-buy-wall');
  const sellEl = $('binance-sell-wall');

  if (!walls) {
    if (buyEl) buyEl.textContent = '—';
    if (sellEl) sellEl.textContent = '—';
    return;
  }

  if (walls.buyWall && buyEl) {
    buyEl.textContent = `${fmtPrice(walls.buyWall.price)} (${fmt(walls.buyWall.volume, 2)} BTC)`;
    setClass(buyEl, 'bullish');
  }

  if (walls.sellWall && sellEl) {
    sellEl.textContent = `${fmtPrice(walls.sellWall.price)} (${fmt(walls.sellWall.volume, 2)} BTC)`;
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
