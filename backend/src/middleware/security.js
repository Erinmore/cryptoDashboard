import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import env from '../config/env.js';

export function applySecurityMiddleware(app) {
  // CSP desactivada: en producción el mismo Express sirve el frontend construido
  // (dist/), que usa atributos `style=` inline y un módulo ES same-origin. La CSP
  // por defecto de helmet bloquearía esos inline. App single-user en LAN de
  // confianza sin contenido externo ⇒ el resto de cabeceras de helmet se mantienen.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());

  const allowedOrigins = env.isDev
    ? ['http://localhost:5173', 'http://localhost:3000']
    : [];

  app.use(cors({
    origin: (origin, cb) => {
      // Permite requests sin origin (ej: mismo servidor, curl)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  }));

  app.use(express.json({ limit: '100kb' }));
}
