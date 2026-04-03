# CSS Conventions — CRYPTEX Dashboard

Documento de convenciones y sistema de diseño para mantener el CSS escalable y mantenible.

## 🎨 Sistema de Variables CSS

El archivo `assets/css/styles.css` usa un sistema completo de variables CSS (Custom Properties) organizadas por categoría. **Nunca hardcodees valores** — siempre usa variables.

### Colores

```css
/* Base */
--bg-app          /* #0d0f14 - fondo principal */
--bg-surface      /* #141720 - header y sidebar */
--bg-card         /* #1a1e2a - tarjetas */
--bg-hover        /* #222736 - hover states */

/* Texto */
--text-primary    /* #e8eaf0 - texto principal */
--text-secondary  /* #8b90a0 - texto secundario */
--text-muted      /* #555c70 - texto muteado */

/* Acento (azul) */
--accent          /* #3b82f6 - azul principal */
--accent-dim      /* #1e3a5f - azul oscuro (fondo) */
--accent-hover    /* #2563eb - azul hover */

/* Señales */
--bullish         /* #22c55e - verde */
--bearish         /* #ef4444 - rojo */
--neutral         /* #f59e0b - naranja */
--bullish-dim     /* #14532d - verde oscuro (fondo) */
--bearish-dim     /* #7f1d1d - rojo oscuro (fondo) */
--neutral-dim     /* #78350f - naranja oscuro (fondo) */

/* Alertas */
--alert-danger-bg      /* rgba(239, 68, 68, 0.1) */
--alert-danger-text    /* #fca5a5 */
--alert-warning-bg     /* rgba(245, 158, 11, 0.1) */
--alert-warning-text   /* #fcd34d */
--alert-info-bg        /* rgba(59, 130, 246, 0.1) */
--alert-info-text      /* #93c5fd */
```

### Tipografía (escala modular 8px)

```css
--fs-xs     /* 8px  - etiquetas muy pequeñas */
--fs-sm     /* 9px  - fechas, meta information */
--fs-base   /* 10px - etiquetas de indicadores (default) */
--fs-md     /* 11px - valores de indicadores */
--fs-lg     /* 12px - botones, timestamps */
--fs-xl     /* 13px - texto base (body) */
--fs-2xl    /* 16px - logo */
--fs-3xl    /* 18px - títulos grandes */
```

**Cómo usarlos:**
```css
.my-label { font-size: var(--fs-base); }    /* 10px */
.my-value { font-size: var(--fs-md); }      /* 11px */
.my-title { font-size: var(--fs-2xl); }     /* 16px */
```

### Espaciado (escala 4px base)

```css
--sp-xs    /* 2px  - gaps muy pequeños */
--sp-sm    /* 4px  - gaps entre elementos */
--sp-md    /* 6px  - padding interno pequeño */
--sp-lg    /* 8px  - padding y gaps estándar */
--sp-xl    /* 10px - padding grande */
--sp-2xl   /* 12px - padding muy grande */
```

**Cómo usarlos:**
```css
.my-section { padding: var(--sp-lg); }        /* 8px */
.my-grid { gap: var(--sp-md); }               /* 6px */
.my-row { padding: var(--sp-md) var(--sp-lg); }  /* 6px 8px */
```

### Border Radius

```css
--radius-sm     /* 3px  - botones pequeños, alerts */
--radius-md     /* 4px  - inputs, badges */
--radius-lg     /* 6px  - tarjetas, paneles */
--radius-full   /* 50% - círculos */
```

### Transiciones

```css
--transition-fast   /* 0.15s - hover, color changes */
--transition-base   /* 0.2s  - fade, opacity */
--transition-slow   /* 0.4s  - width, smooth animations */
--transition-anim   /* 0.7s  - spinner, flash animations */
```

## 📏 Patrones comunes

### Componente de fila (indicador/sentimiento)

```css
.my-row {
  display: grid;
  grid-template-columns: 70px 1fr auto;  /* etiqueta | valor | icono */
  align-items: center;
  gap: var(--sp-lg);
  padding: var(--sp-md) 0;
  border-bottom: 1px solid var(--border-subtle);
}
```

### Etiqueta con icono de tooltip

```css
.my-label {
  color: var(--text-muted);
  font-size: var(--fs-base);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-sm);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.my-label::after {
  content: '';
  width: var(--sp-sm);
  height: var(--sp-sm);
  border-radius: var(--radius-full);
  border: 1px solid var(--text-muted);
  opacity: 0.45;
  transition: opacity var(--transition-fast), 
              border-color var(--transition-fast),
              background var(--transition-fast);
}

.my-label:hover {
  color: var(--text-secondary);
}

.my-label:hover::after {
  border-color: var(--accent);
  background: var(--accent);
  opacity: 1;
}
```

### Tarjeta (sidebar-section)

```css
.my-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--sp-xl);
  margin-bottom: var(--sp-lg);
}

.my-card:last-child {
  margin-bottom: 0;
}
```

## ⚠️ Reglas de oro

1. **Nunca hardcodees colores.**
   - ❌ `background: #1a1e2a;`
   - ✅ `background: var(--bg-card);`

2. **Nunca hardcodees tamaños de fuente.**
   - ❌ `font-size: 11px;`
   - ✅ `font-size: var(--fs-md);`

3. **Nunca hardcodees espaciado (padding/margin/gap).**
   - ❌ `padding: 8px; margin: 6px;`
   - ✅ `padding: var(--sp-lg); margin: var(--sp-md);`

4. **Nunca hardcodees border-radius.**
   - ❌ `border-radius: 4px;`
   - ✅ `border-radius: var(--radius-md);`

5. **Nunca hardcodees transiciones.**
   - ❌ `transition: all 0.15s;`
   - ✅ `transition: all var(--transition-fast);`

6. **Consolida estilos duplicados.**
   - Si dos selectores comparten reglas, agrúpalos con coma.
   - Ej: `.my-label, .my-label[title] { ... }`

7. **Organiza comentarios por sección.**
   - Usa `/* ── Sección ─────────────────────────────────────────────── */`
   - Agrupa componentes relacionados.

## 📊 Cambios recientes (refactoring 2026-04)

Se refactorizó completamente el archivo de estilos para eliminar valores hardcodeados:

- **~450 líneas** de CSS optimizadas
- **60+ valores hardcodeados** reemplazados por variables
- **Estilos duplicados** consolidados (`.ind-name` y `.sent-label`)
- **Sistema modular** de tipografía, espaciado y colores implementado

### Beneficios

✅ **Mantenibilidad**: Cambiar un color u otro valor ahora afecta todo el sistema
✅ **Escalabilidad**: Nuevos componentes heredan automáticamente el sistema de diseño  
✅ **Consistencia**: No hay ambigüedad en tamaños, colores o espaciado
✅ **Performance**: Las variables CSS son nativas del navegador (sin compilación)

## 🔄 Cómo cambiar el tema

Para cambiar colores, tamaños o espaciado globalmente, solo edita las variables en `:root`:

```css
:root {
  --bullish: #00ff00;  /* Cambiar el verde globalmente */
  --fs-base: 11px;     /* Cambiar todas las etiquetas */
  --sp-lg: 10px;       /* Cambiar el espaciado estándar */
}
```

Todo el dashboard se actualizará automáticamente.
