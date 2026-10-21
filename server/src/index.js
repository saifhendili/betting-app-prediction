import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { env } from './config/env.js';
import { connectDB } from './db/connect.js';
import { log } from './utils/logger.js';
import { gamesRouter } from './routes/games.js';
import { predictionsRouter } from './routes/predictions.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { loadSettings, describeSettings } from './services/settingsService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');
const app = express();

// Behind a hosting provider's proxy (Render, Railway, Fly, nginx) the client IP
// arrives in X-Forwarded-For; without this the rate limiter would see one IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(compression());
app.use(express.json({ limit: '256kb' }));
if (env.nodeEnv !== 'test') app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'tiny'));

/**
 * No CORS middleware, by design.
 *
 * The API and the UI are served from the same origin: in production this process
 * serves client/dist itself, and in development Vite proxies /api through to
 * here. Either way the browser never makes a cross-origin request, so there is
 * nothing to negotiate — and no `Access-Control-Allow-Origin` to get wrong.
 * A consequence worth knowing: this API is not callable from a browser page on
 * another domain. That is deliberate.
 */

// Predictions are the expensive path (upstream quota + an AI call), so they get
// a tighter budget than the cheap, cached listing endpoints.
app.use('/api/predictions', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));

app.use('/api/health', healthRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/games', gamesRouter);
app.use('/api/predictions', predictionsRouter);

app.use('/api', (req, res) => res.status(404).json({ error: `No route ${req.method} ${req.originalUrl}` }));

// ── static UI ───────────────────────────────────────────────────────────────
const hasBuild = fs.existsSync(path.join(clientDist, 'index.html'));

if (hasBuild) {
  // Vite emits content-hashed asset filenames, so they can be cached hard.
  app.use(
    '/assets',
    express.static(path.join(clientDist, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: true,
    })
  );
  app.use(express.static(clientDist, { index: false, maxAge: '1h', fallthrough: true }));

  // SPA fallback: anything that is not /api/* returns index.html, never cached
  // so a new deploy is picked up immediately.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get(/^\/(?!api\/).*/, (_req, res) =>
    res
      .status(503)
      .type('text/plain')
      .send('UI not built. Run `npm run build` at the repo root, then restart.\nThe API itself is available under /api.')
  );
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) log.error(err.message);
  res.status(status).json({
    error: err.message || 'Internal error',
    ...(env.nodeEnv === 'development' && status >= 500 ? { stack: err.stack?.split('\n').slice(0, 4) } : {}),
  });
});

async function start() {
  await connectDB();
  // Keys saved in the settings panel take precedence over .env.
  await loadSettings();

  // 0.0.0.0 so the process is reachable inside a container / from the host
  const server = app.listen(env.port, '0.0.0.0', () => {
    const s = describeSettings();
    log.ok(`listening on http://localhost:${env.port}  (API + UI, single origin)`);
    log.info(
      `sports keys: ${s.sports.count} (${s.sports.source}) · gemini keys: ${s.gemini.count} (${s.gemini.source}) · model: ${s.gemini.model}`
    );
    if (!hasBuild) log.warn('client/dist not found — serving the API only. Run `npm run build` at the repo root.');
    if (!s.sports.count) log.warn('No sports API key yet — add one in Settings (gear icon) or in server/.env.');
    if (!s.gemini.count) log.warn('No Gemini key yet — add one in Settings for AI reasoning.');
    if (env.nodeEnv === 'production' && !env.adminToken) {
      log.warn('ADMIN_TOKEN is not set — anyone who can reach this URL can change your API keys.');
    }
  });

  // Hosting platforms stop containers with SIGTERM; finish in-flight requests.
  const shutdown = (signal) => () => {
    log.info(`${signal} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

start().catch((err) => {
  log.error(`Failed to start: ${err.message}`);
  process.exit(1);
});

export { app };
