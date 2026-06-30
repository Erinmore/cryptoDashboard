# ── Build stage: Vite ─────────────────────────────────────────────────────────
FROM node:18-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime stage: serve ficheros estáticos ───────────────────────────────────
FROM node:18-bookworm-slim AS runtime

WORKDIR /app

RUN npm install -g serve@14

COPY --from=build /app/dist ./dist

EXPOSE 3001

CMD ["serve", "-s", "dist", "-l", "3001"]
