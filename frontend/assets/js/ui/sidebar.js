/**
 * sidebar.js — Actualización del DOM de la sidebar y el header
 *
 * Funciones exportadas:
 *   updateHeader(state)         — precio, variación 24h, BTC dominance
 *   updateRegimeBadge(state)    — badge TRENDING / RANGING / HIGH_VOLATILITY
 *   updateIndicators(state)     — panel de indicadores técnicos
 *   updateSentiment(state)      — Fear & Greed, CryptoPanic, derivados
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

// ── Sentiment panel ────────────────────────────────────────────────

export function updateSentiment(state) {
  const { fearGreed, sentiment, derivatives } = state;

  // Fear & Greed
  if (fearGreed) {
    // Valor + flecha de tendencia diaria
    const trendArrow = fearGreed.trend === 'improving' ? ' ↑' : fearGreed.trend === 'worsening' ? ' ↓' : '';
    setText('fear-greed-value', `${fearGreed.value}${trendArrow}`);

    const fgEl = $('fear-greed-label');
    if (fgEl) {
      // Indicador de flechas basado en valor y tendencia
      const signalClass = fgSignalClass(fearGreed.value);
      let arrow = '→';
      if (fearGreed.trend === 'improving') {
        arrow = fearGreed.value > 50 ? '↑↑' : '↑';
      } else if (fearGreed.trend === 'worsening') {
        arrow = fearGreed.value < 50 ? '↓↓' : '↓';
      } else {
        arrow = fearGreed.value > 50 ? '↑' : fearGreed.value < 50 ? '↓' : '→';
      }
      fgEl.textContent = arrow;
      fgEl.className   = 'sent-signal ' + signalClass;
    }
  }

  // CryptoPanic
  if (sentiment) {
    if (sentiment.unavailable || sentiment.score == null) {
      setText('cryptopanic-score', '—');
      const bullEl = $('votes-bullish');
      const bearEl = $('votes-bearish');
      if (bullEl) bullEl.style.width = '50%';
      if (bearEl) bearEl.style.width = '50%';
    } else {
      const stale = sentiment.stale ? ' ⚠' : '';
      setText('cryptopanic-score', fmt(sentiment.score, 2) + stale);

      // Barra de votos
      const bull  = sentiment.bullish_votes ?? 0;
      const bear  = sentiment.bearish_votes ?? 0;
      const total = bull + bear;
      const pctB  = total > 0 ? ((bull / total) * 100).toFixed(1) : 50;
      const pctBe = total > 0 ? (100 - pctB).toFixed(1) : 50;

      const bullEl = $('votes-bullish');
      const bearEl = $('votes-bearish');
      if (bullEl) bullEl.style.width = `${pctB}%`;
      if (bearEl) bearEl.style.width = `${pctBe}%`;
    }
  }

  // Noticias CryptoPanic
  const newsList = $('news-list');
  if (newsList) {
    const news = sentiment?.latest_news ?? [];
    newsList.innerHTML = '';
    if (news.length > 0) {
      for (const item of news) {
        const article = document.createElement('div');
        article.className = `news-item ${item.sentiment ?? 'neutral'}`;

        const link = document.createElement('a');
        link.className   = 'news-title';
        link.textContent = item.title ?? '';
        link.href        = item.url   ?? '#';
        link.target      = '_blank';
        link.rel         = 'noopener noreferrer';

        const meta   = document.createElement('div');
        meta.className = 'news-meta';

        const src  = document.createElement('span');
        src.className   = 'news-source';
        src.textContent = item.source ?? '';

        const time = document.createElement('span');
        time.className   = 'news-time';
        time.textContent = timeAgo(item.published_at);

        meta.appendChild(src);
        meta.appendChild(time);
        article.appendChild(link);
        article.appendChild(meta);
        newsList.appendChild(article);
      }
      newsList.style.display = '';
    } else {
      newsList.style.display = 'none';
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
  }

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
  }

  // Long/Short
  const lsr = derivatives.long_short_ratio;
  if (lsr) {
    setText('long-short', `${fmt(lsr.long_pct, 1)}% L / ${fmt(lsr.short_pct, 1)}% S`);
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

export function showRecommendationLoading() {
  $('recommendation-empty')?.classList.add('hidden');
  $('recommendation-content')?.classList.add('hidden');
  $('recommendation-loading')?.classList.remove('hidden');
}

export function hideRecommendationLoading() {
  $('recommendation-loading')?.classList.add('hidden');
  $('recommendation-empty')?.classList.remove('hidden');
}

/**
 * Rellena el panel de recomendación IA con los datos recibidos.
 * @param {object} rec — objeto `recommendation` del backend
 */
export function updateRecommendation(rec) {
  $('recommendation-loading')?.classList.add('hidden');
  $('recommendation-empty')?.classList.add('hidden');

  const contentEl = $('recommendation-content');
  if (!contentEl) return;
  contentEl.classList.remove('hidden');

  // Acción
  const actionEl = $('rec-action');
  if (actionEl) {
    actionEl.textContent = rec.action ?? '—';
    actionEl.className   = `rec-action ${rec.action ?? ''}`;
  }

  // Confianza
  const confPct = rec.confidence != null ? `${Math.round(rec.confidence * 100)}%` : '—';
  setText('rec-confidence', confPct);

  // Racional
  setText('rec-rationale', rec.rationale ?? '—');

  // Niveles
  setText('rec-entry', fmtPrice(rec.entry_level));
  setText('rec-sl',    fmtPrice(rec.exit?.stop_loss));
  setText('rec-tp1',   fmtPrice(rec.exit?.take_profit_1?.price));
  setText('rec-tp2',   fmtPrice(rec.exit?.take_profit_2?.price));

  // Alertas
  const alertsEl = $('rec-alerts');
  if (alertsEl) {
    alertsEl.innerHTML = '';
    for (const alert of rec.alerts ?? []) {
      const div = document.createElement('div');
      div.className   = `rec-alert ${alert.type ?? 'info'}`;
      div.textContent = alert.message ?? '';
      alertsEl.appendChild(div);
    }
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
