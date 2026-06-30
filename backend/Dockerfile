# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:18-bookworm-slim AS deps

WORKDIR /app

# better-sqlite3 necesita compilar nativo — instalar build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:18-bookworm-slim AS runtime

WORKDIR /app

# Crear directorio de datos para SQLite
RUN mkdir -p /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
