import env from '../config/env.js';
import { AppError } from '../utils/errors.js';

export const PROMPT_VERSION = 'v1_full_context';

/**
 * Construye el prompt de texto estructurado que se envía a Claude.
 * @param {object} ctx - Contexto de mercado completo
 * @returns {string}
 */
function buildPrompt(ctx) {
  const tf = ctx.primary_tf;
  const tech = ctx.technical?.[tf];
  const price = ctx.price_current;

  const lines = [];

  // Régimen
  if (tech?.regime) {
    const r = tech.regime;
    lines.push(`RÉGIMEN DE MERCADO: ${r.regime} (ADX=${tech.adx?.adx?.toFixed(1) ?? 'N/A'})`);
    lines.push('');
  }

  // Técnicos principal TF
  lines.push(`TÉCNICOS (${tf.toUpperCase()}):`);

  if (tech?.rsi) {
    const div = tech.rsi.divergence ? `divergencia: ${tech.rsi.divergence}` : 'divergencia: ninguna';
    lines.push(`  RSI=${tech.rsi.value.toFixed(1)} (${tech.rsi.signal}), ${div}`);
  }
  if (tech?.stoch_rsi) {
    lines.push(`  StochRSI %K=${tech.stoch_rsi.k?.toFixed(1)} / %D=${tech.stoch_rsi.d?.toFixed(1)}`);
  }
  if (tech?.macd) {
    lines.push(`  MACD=${tech.macd.value.toFixed(6)}, histograma ${tech.macd.histogram_color} (${tech.macd.status})`);
  }
  if (tech?.wave_trend) {
    lines.push(`  WaveTrend WT1=${tech.wave_trend.wt1?.toFixed(1)} / WT2=${tech.wave_trend.wt2?.toFixed(1)}`);
  }
  if (tech?.adx) {
    lines.push(`  ADX=${tech.adx.adx?.toFixed(1)}, +DI=${tech.adx.plus_di?.toFixed(1)} / -DI=${tech.adx.minus_di?.toFixed(1)} (${tech.adx.trend_direction ?? 'N/A'})`);
  }
  if (tech?.bollinger_bands) {
    const bb = tech.bollinger_bands;
    lines.push(`  BB %B=${bb.percent_b?.toFixed(2)}, BB Width=${bb.width?.toFixed(2)}% (${bb.status ?? 'N/A'})`);
  }
  if (tech?.super_trend) {
    const st = tech.super_trend;
    lines.push(`  SuperTrend=${st.trend} (nivel dinámico: $${st.value?.toFixed(2) ?? 'N/A'})`);
  }
  if (tech?.volume_delta) {
    const vd = tech.volume_delta;
    lines.push(`  Volume Delta: ${vd.buy_pressure_pct}% buy pressure (${vd.last_candle_type})`);
  }
  if (tech?.cvd) {
    lines.push(`  CVD: ${tech.cvd.trend ?? 'N/A'}`);
  }
  if (tech?.obv) {
    lines.push(`  OBV: ${tech.obv.trend ?? 'N/A'}`);
  }
  lines.push('');

  // Fibonacci y S/R
  if (tech?.fibonacci?.length) {
    const key = tech.fibonacci.filter(f => [0.382, 0.618].includes(f.level));
    if (key.length) {
      lines.push(`FIBONACCI: ${key.map(f => `${(f.level * 100).toFixed(1)}% en $${f.price?.toFixed(2)}`).join(', ')}`);
    }
  }
  if (tech?.support_resistance) {
    const sr = tech.support_resistance;
    const s1 = sr.supports?.[0];
    const r1 = sr.resistances?.[0];
    if (s1 || r1) {
      const parts = [];
      if (s1) parts.push(`S1=$${s1.price?.toFixed(2)} (fuerza ${s1.strength})`);
      if (r1) parts.push(`R1=$${r1.price?.toFixed(2)} (fuerza ${r1.strength})`);
      lines.push(`SOPORTE/RESISTENCIA: ${parts.join(', ')}`);
    }
  }
  lines.push('');

  // Multi-timeframe breve
  const otherTfs = Object.keys(ctx.technical ?? {}).filter(t => t !== tf);
  if (otherTfs.length) {
    lines.push('MULTI-TIMEFRAME:');
    for (const t of otherTfs) {
      const tt = ctx.technical[t];
      if (tt?.rsi && tt?.trend) {
        lines.push(`  ${t}: trend=${tt.trend}, RSI=${tt.rsi.value.toFixed(1)}`);
      }
    }
    lines.push('');
  }

  // Sentimiento
  lines.push('SENTIMIENTO:');
  if (ctx.fear_greed) {
    lines.push(`  Fear & Greed: ${ctx.fear_greed.value} (${ctx.fear_greed.classification})`);
  }
  if (ctx.sentiment) {
    const s = ctx.sentiment;
    lines.push(`  CryptoPanic: score=${s.score?.toFixed(2)}, ${s.bullish_votes} votos bullish vs ${s.bearish_votes} bearish`);
  }
  if (ctx.derivatives) {
    const d = ctx.derivatives;
    if (d.funding_rate != null) lines.push(`  Funding Rate: ${(d.funding_rate * 100).toFixed(4)}%`);
    if (d.open_interest != null) lines.push(`  Open Interest 24h: ${d.open_interest_change_pct != null ? `${d.open_interest_change_pct > 0 ? '+' : ''}${d.open_interest_change_pct.toFixed(1)}%` : d.open_interest}`);
    if (d.long_short_ratio != null) lines.push(`  Long/Short Ratio: ${(d.long_short_ratio * 100).toFixed(0)}% longs`);
  }
  if (ctx.btc_dominance != null) {
    lines.push(`  BTC Dominance: ${ctx.btc_dominance.toFixed(1)}%`);
  }
  lines.push('');

  // Precio y último análisis
  if (price != null) {
    const change = ctx.price_change_24h_pct != null ? ` (${ctx.price_change_24h_pct > 0 ? '+' : ''}${ctx.price_change_24h_pct.toFixed(2)}% 24h)` : '';
    lines.push(`PRECIO ACTUAL: $${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}${change}`);
  }
  if (ctx.last_analysis) {
    const la = ctx.last_analysis;
    lines.push(`ÚLTIMO ANÁLISIS: recomendación ${la.recommendation_action} con ${((la.recommendation_confidence ?? 0) * 100).toFixed(0)}% confianza`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Envía el contexto de mercado a Anthropic Claude y retorna una recomendación estructurada.
 *
 * @param {object} context - Contexto completo con technical, sentiment, derivatives, etc.
 * @returns {Promise<{ recommendation: object, ai_metadata: object }>}
 * @throws {AppError} 503 si ANTHROPIC_API_KEY no está configurada
 */
export async function analyzeMarket(context) {
  if (!env.anthropicApiKey) {
    throw new AppError(
      'Anthropic API key not configured — set ANTHROPIC_API_KEY in .env',
      503,
      'SERVICE_UNAVAILABLE',
    );
  }

  // ── TODO: implementar cuando esté disponible ANTHROPIC_API_KEY ──────────────
  //
  // Ejemplo de implementación (descomentar cuando haya key):
  //
  // import Anthropic from '@anthropic-ai/sdk';
  // const client = new Anthropic({ apiKey: env.anthropicApiKey });
  //
  // const prompt = buildPrompt(context);
  // const systemPrompt = `Eres un analista técnico experto en criptomonedas...`;
  //
  // const response = await client.messages.create({
  //   model: 'claude-sonnet-4-20250514',
  //   max_tokens: 1024,
  //   system: systemPrompt,
  //   messages: [{ role: 'user', content: prompt }],
  // });
  //
  // const raw = response.content[0].text;
  // const recommendation = JSON.parse(raw);  // Claude devuelve JSON estructurado
  //
  // return {
  //   recommendation,
  //   ai_metadata: {
  //     model: response.model,
  //     prompt_version: PROMPT_VERSION,
  //     input_tokens: response.usage.input_tokens,
  //     output_tokens: response.usage.output_tokens,
  //   },
  // };

  throw new AppError(
    'Anthropic service pending implementation — add ANTHROPIC_API_KEY to activate',
    501,
    'NOT_IMPLEMENTED',
  );
}

// Exportar buildPrompt para poder testearlo sin clave
export { buildPrompt };
