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
  //
  // frameguard desactivado: la Pi embebe CRYPTEX en un iframe desde el kiosko de
  // piAssistant (http://localhost:8000), que es un origen distinto (CRYPTEX corre
  // en http://192.168.1.250:8080). Por defecto helmet emite X-Frame-Options:
  // SAMEORIGIN, que bloquearía ese iframe cross-origin. X-Frame-Options solo admite
  // DENY/SAMEORIGIN (no un origen concreto) y la alternativa CSP frame-ancestors no
  // sirve aquí porque la CSP está apagada ⇒ se desactiva el frameguard entero.
  // Aceptable en app single-user en LAN de confianza. Reconsiderar si se expone a WAN.
  app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
  app.use(compression());

  const allowedOrigins = env.isDev
    ? ['http://localhost:5173', 'http://localhost:3000']
    : [];

  app.use(cors({
    origin: (origin, cb) => {
      // Permite requests sin origin (ej: mismo servidor, curl)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      // Origen no permitido: NO lanzar (un throw aquí se traduce en HTTP 500 y
      // rompía la carga de los assets del build de Vite, que llevan `crossorigin`
      // y por tanto se piden en modo CORS con cabecera Origin same-origin
      // http://192.168.1.250:8080). Devolver cb(null, false) responde 200 sin
      // cabeceras CORS: las peticiones same-origin no las necesitan y una
      // cross-origin real sigue bloqueada por el navegador al faltar
      // Access-Control-Allow-Origin ⇒ no abre ningún agujero.
      cb(null, false);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  }));

  app.use(express.json({ limit: '100kb' }));
}
