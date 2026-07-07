#!/usr/bin/env node
/**
 * auditStats.mjs — informe read-only para la remediación de la auditoría red-team.
 *
 * Uso (desde backend/):  node scripts/auditStats.mjs
 *
 * No arranca la app ni corre migraciones: abre la BBDD en solo-lectura y agrega la
 * evidencia que sustenta las decisiones de calibración del plan de remediación:
 *   - Distribución de `action` (% Esperar/Preparar/Comprar/Vender)      → H1, C5
 *   - Frecuencia de disparo de cada contradiction_code y del veto        → H1, H4
 *   - Nº de análisis direccionales con outcome 24h cerrado (muestra real)→ C5
 *   - % de setups not_triggered / invalid                                → H6
 *   - Co-ocurrencia ETF accumulating × funding negativo extremo vs outcome→ B3
 *
 * Es puramente descriptivo: no cambia datos ni el comportamiento del sistema.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';

const dbPath = process.env.DB_PATH || './data/cryptex.db';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

if (!existsSync(dbPath)) {
  console.log(`\n  ${c.yellow}No existe la BBDD todavía${c.reset} en: ${c.dim}${dbPath}${c.reset}`);
  console.log(`  Arranca el backend al menos una vez para crearla.\n`);
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const tableExists = (name) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const columns = (table) => {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)); }
  catch { return new Set(); }
};
const all = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };
const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch { return null; } };
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '—');

if (!tableExists('analyses')) {
  console.log(`\n  ${c.yellow}Sin tabla 'analyses' — nada que auditar todavía.${c.reset}\n`);
  process.exit(0);
}

const cols = columns('analyses');
const total = one(`SELECT COUNT(*) n FROM analyses`)?.n ?? 0;

console.log(`\n  ${c.bold}Auditoría — evidencia sobre ${total} análisis${c.reset}  ${c.dim}${dbPath}${c.reset}`);

// ── H1/C5 · Distribución de acciones ─────────────────────────────────────────
console.log(`\n  ${c.bold}Distribución de acción${c.reset}  ${c.dim}(H1 sesgo a Esperar · C5 tamaño de muestra)${c.reset}`);
if (total > 0) {
  const rows = all(`SELECT action, COUNT(*) n FROM analyses GROUP BY action ORDER BY n DESC`);
  for (const r of rows) {
    console.log(`    ${c.cyan}${String(r.action ?? 'null').padEnd(10)}${c.reset} ${String(r.n).padStart(5)}   ${c.dim}${pct(r.n, total)}${c.reset}`);
  }
  const directional = one(`SELECT COUNT(*) n FROM analyses WHERE action IN ('Comprar','Vender')`)?.n ?? 0;
  console.log(`    ${c.dim}────────────────────────────────${c.reset}`);
  console.log(`    direccionales (Comprar/Vender): ${directional === 0 ? c.red : c.green}${directional}${c.reset} ${c.dim}(${pct(directional, total)})${c.reset}`);
} else {
  console.log(`    ${c.dim}(vacío)${c.reset}`);
}

// ── H1/H4 · Frecuencia de contradicciones y vetos ────────────────────────────
console.log(`\n  ${c.bold}Contradicciones deterministas${c.reset}  ${c.dim}(H1 recalibración · H4 solapamiento con veto)${c.reset}`);
if (cols.has('contradiction_codes')) {
  const rows = all(`SELECT contradiction_codes FROM analyses WHERE contradiction_codes IS NOT NULL`);
  const freq = new Map();
  let withCodes = 0;
  for (const r of rows) {
    let codes;
    try { codes = JSON.parse(r.contradiction_codes); } catch { codes = null; }
    if (!Array.isArray(codes)) continue;
    withCodes++;
    for (const item of codes) {
      const code = typeof item === 'string' ? item : item?.code;
      if (code) freq.set(code, (freq.get(code) ?? 0) + 1);
    }
  }
  if (freq.size === 0) {
    console.log(`    ${c.dim}(sin contradiction_codes poblados — filas previas al sprint de gating)${c.reset}`);
  } else {
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [code, n] of sorted) {
      console.log(`    ${c.cyan}${code.padEnd(26)}${c.reset} ${String(n).padStart(5)}   ${c.dim}${pct(n, withCodes)} de ${withCodes} con códigos${c.reset}`);
    }
  }
  if (cols.has('contradiction_count')) {
    const dist = all(`SELECT contradiction_count cc, COUNT(*) n FROM analyses WHERE contradiction_count IS NOT NULL GROUP BY cc ORDER BY cc`);
    if (dist.length) {
      console.log(`    ${c.dim}conteo por análisis:${c.reset} ${dist.map((d) => `${d.cc}→${d.n}`).join('  ')}`);
      const ge3 = one(`SELECT COUNT(*) n FROM analyses WHERE contradiction_count >= 3`)?.n ?? 0;
      const withCc = one(`SELECT COUNT(*) n FROM analyses WHERE contradiction_count IS NOT NULL`)?.n ?? 0;
      console.log(`    ${c.dim}con >=3 (fuerza Esperar):${c.reset} ${ge3} ${c.dim}(${pct(ge3, withCc)})${c.reset}`);
    }
  }
} else {
  console.log(`    ${c.dim}(columna contradiction_codes no existe)${c.reset}`);
}
if (cols.has('gating_active')) {
  const vetoed = one(`SELECT COUNT(*) n FROM analyses WHERE gating_active = 1`)?.n ?? 0;
  console.log(`    ${c.dim}veto/gating activo:${c.reset} ${vetoed} ${c.dim}(${pct(vetoed, total)})${c.reset}`);
}

// ── C5 · Muestra real del backtesting ────────────────────────────────────────
console.log(`\n  ${c.bold}Backtesting — muestra real${c.reset}  ${c.dim}(C5 validez estadística)${c.reset}`);
if (tableExists('analysis_outcome')) {
  const closed = one(`
    SELECT COUNT(*) n FROM analysis_outcome o JOIN analyses a ON a.id = o.analysis_id
    WHERE a.action IN ('Comprar','Vender') AND o.outcome_24h IS NOT NULL`)?.n ?? 0;
  const wins = one(`
    SELECT COUNT(*) n FROM analysis_outcome o JOIN analyses a ON a.id = o.analysis_id
    WHERE a.action IN ('Comprar','Vender') AND o.outcome_24h = 'win'`)?.n ?? 0;
  console.log(`    direccionales con outcome_24h cerrado: ${closed === 0 ? c.red : c.green}${closed}${c.reset}`);
  console.log(`    de ellos 'win': ${wins}  ${c.dim}${pct(wins, closed)}${c.reset}`);
  if (closed < 20) console.log(`    ${c.red}⚠ muestra < 20 → win-rate no es concluyente (Wilson CI muy ancho)${c.reset}`);
} else {
  console.log(`    ${c.dim}(sin tabla analysis_outcome)${c.reset}`);
}

// ── H6 · Setups no disparados / inválidos ────────────────────────────────────
console.log(`\n  ${c.bold}Setups${c.reset}  ${c.dim}(H6 fill-rate / setups alucinados)${c.reset}`);
if (tableExists('analysis_outcome')) {
  const dist = all(`SELECT setup_outcome so, COUNT(*) n FROM analysis_outcome WHERE setup_outcome IS NOT NULL GROUP BY so ORDER BY n DESC`);
  const totalSetups = dist.reduce((s, d) => s + d.n, 0);
  if (totalSetups === 0) {
    console.log(`    ${c.dim}(sin setups resueltos todavía)${c.reset}`);
  } else {
    for (const d of dist) {
      const flag = (d.so === 'not_triggered' || d.so === 'invalid') ? c.yellow : c.reset;
      console.log(`    ${flag}${String(d.so).padEnd(14)}${c.reset} ${String(d.n).padStart(5)}   ${c.dim}${pct(d.n, totalSetups)}${c.reset}`);
    }
  }
} else {
  console.log(`    ${c.dim}(sin tabla analysis_outcome)${c.reset}`);
}

// ── B3 · Co-ocurrencia ETF accumulating × funding negativo extremo ────────────
console.log(`\n  ${c.bold}Interacción ETF × Funding${c.reset}  ${c.dim}(B3 validar/retirar el +0.5)${c.reset}`);
const hasEtf = cols.has('etf_trend_7d') || cols.has('etf_flows_trend_7d');
const fundNegCol = cols.has('funding_severity_negative') ? 'funding_severity_negative' : null;
const etfCol = cols.has('etf_trend_7d') ? 'etf_trend_7d' : (cols.has('etf_flows_trend_7d') ? 'etf_flows_trend_7d' : null);
if (etfCol && fundNegCol && tableExists('analysis_outcome')) {
  const co = one(`
    SELECT COUNT(*) n,
           SUM(CASE WHEN o.outcome_24h='win'  THEN 1 ELSE 0 END) win,
           SUM(CASE WHEN o.outcome_24h='loss' THEN 1 ELSE 0 END) loss
    FROM analyses a LEFT JOIN analysis_outcome o ON o.analysis_id = a.id
    WHERE a.${etfCol} = 'accumulating'
      AND a.${fundNegCol} IN ('high_short_overload','extreme_short_overload')`);
  console.log(`    co-ocurrencias: ${co?.n ?? 0}  ${c.dim}win=${co?.win ?? 0} loss=${co?.loss ?? 0}${c.reset}`);
  if ((co?.n ?? 0) < 10) console.log(`    ${c.dim}(muestra insuficiente para validar el término — considerar retirarlo)${c.reset}`);
} else {
  console.log(`    ${c.dim}(columnas etf/funding no disponibles para el cruce)${c.reset}`);
}

console.log('');
db.close();
