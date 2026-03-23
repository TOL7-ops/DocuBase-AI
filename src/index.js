/**
 * INDEX.JS — Express app entry point
 *
 * Mounts all routes, attaches request logging middleware,
 * and starts the server.
 */

require('dotenv').config();

const express   = require('express');
const crypto    = require('crypto');
const logger    = require('./logger');

const healthRouter    = require('./routes/health');
const documentsRouter = require('./routes/documents');
const askRouter       = require('./routes/ask');
const sessionsRouter  = require('./routes/sessions');

const PORT = process.env.PORT || 3000;
const app  = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
// Add your Vercel frontend URL to FRONTEND_URL env var on Render

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3001',
  process.env.FRONTEND_URL,           // set this on Render: https://your-app.vercel.app
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// Attach request ID and logger to every request
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  req.log = logger.child({ request_id: req.requestId });
  next();
});

// Structured access log (Contract V2 Section 9)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    req.log.info({
      endpoint:   `${req.method} ${req.path}`,
      status:     res.statusCode,
      latency_ms: Date.now() - start,
    });
  });
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/health',    healthRouter);
app.use('/documents', documentsRouter);
app.use('/ask',       askRouter);
app.use('/sessions',  sessionsRouter);

// ── 404 fallback ──────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error:   'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  logger.error({ err, request_id: req.requestId }, 'Unhandled error');
  res.status(500).json({
    error:      'INTERNAL_ERROR',
    message:    err.message || 'Unexpected server error',
    request_id: req.requestId,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const { warmup } = require('./ollama');
app.listen(PORT, () => {
  logger.info({ port: PORT }, `RAG backend listening on http://localhost:${PORT}`);
  console.log(`[server] listening on port ${PORT}`);
  warmup().catch(err => console.warn('[warmup] error:', err.message));
});

module.exports = app;