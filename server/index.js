import './env.js';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_LABEL, ROOT, closeDb, initDb } from './db.js';
import { attachUser, authRouter, requireUser } from './auth.js';
import { initRealtime } from './realtime.js';
import { callsRouter } from './routes/calls.js';
import { conversationsRouter } from './routes/conversations.js';
import { filesRouter, messagesRouter, scheduleReminders, stopReminders } from './routes/messages.js';
import { requestsRouter } from './routes/requests.js';
import { workRouter } from './routes/work.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Render (and most PaaS) terminate HTTPS at a proxy in front of the app.
  app.set('trust proxy', process.env.RENDER || process.env.TRUST_PROXY ? 1 : 'loopback');

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    next();
  });

  // The Android app runs from its own origin (http://localhost) and authenticates with a
  // bearer token, not cookies — so cross-origin API access is safe to allow.
  app.use('/api', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const api = express.Router();
  api.use(filesRouter); // capability URLs, no auth header needed
  api.use(express.json({ limit: '1mb' }));
  api.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  api.use(attachUser);
  api.use(authRouter);
  api.use(requireUser, conversationsRouter, messagesRouter, workRouter, requestsRouter, callsRouter);
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(dist, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('Kizuna API is running. Use `npm run dev` for the UI, or `npm run build` to serve it from here.'));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side' : err.message });
  });
  return app;
}

/** Connect to the database, then build the HTTP + WebSocket server. */
export async function createServer() {
  await initDb();
  const server = http.createServer(createApp());
  initRealtime(server);

  // Delivers reminders that came due while the server was asleep, then waits for the next one.
  await scheduleReminders().catch((e) => console.error('reminders:', e.message));
  server.on('close', stopReminders);
  return server;
}

const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vbox|tun|tap|utun|wg|zt|lo)/i;
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
    .sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4000;
  const host = process.env.HOST || '0.0.0.0';
  const server = await createServer();
  server.listen(port, host, () => {
    console.log(`\n  ∞ Kizuna is running`);
    console.log(`    local:    http://localhost:${port}`);
    if (!process.env.RENDER) for (const ip of lanAddresses()) console.log(`    network:  http://${ip}:${port}   ← use this address in the Android app`);
    console.log(`    database: ${DB_LABEL}\n`);
  });
  const shutdown = () => {
    server.close(() => closeDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
