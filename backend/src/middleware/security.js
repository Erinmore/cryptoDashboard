import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import env from '../config/env.js';

export function applySecurityMiddleware(app) {
  app.use(helmet());
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
