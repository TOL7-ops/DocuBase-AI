require('dotenv').config();

const express    = require('express');
const crypto     = require('crypto');
const logger     = require('./logger');
const { warmup } = require('./ollama');

const healthRouter    = require('./routes/health');
const documentsRouter = require('./routes/documents');
const askRouter       = require('./routes/ask');
const sessionsRouter  = require('./routes/sessions');

const PORT = process.env.PORT || 3000;

// Allowed frontend origins — add your deployed URL here when you go to prod
const ALLOWED_ORIGINS = [
  'http://localhost:5173',  // Vite default
  'http://localhost:3001',  // CRA default
  'http://localhost:3000',  // same-origin (health checks etc)
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3001',
];

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
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

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ── Request ID + logger ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  req.log = logger.child({ request_id: req.requestId });
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    req.log.info({ endpoint: `${req.method} ${req.path}`, status: res.statusCode, latency_ms: Date.now() - start });
  });
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',    healthRouter);
app.use('/documents', documentsRouter);
app.use('/ask',       askRouter);
app.use('/sessions',  sessionsRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error({ err, request_id: req.requestId }, 'Unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message || 'Unexpected server error', request_id: req.requestId });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT }, `RAG backend listening on http://localhost:${PORT}`);
  console.log(`[server] listening on http://localhost:${PORT}`);
  warmup().catch(err => console.warn('[warmup] error:', err.message));
});

module.exports = app;
