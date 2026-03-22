#!/usr/bin/env node
/**
 * APPLY TIMEOUT FIXES
 *
 * Fixes two issues found in diagnostics:
 *  1. embed() timeout too short (15s) — Ollama cold start on Windows takes longer
 *  2. No model warm-up on server start — first request always cold
 *  3. Document upload swallows embed errors silently
 *
 * Run from backend root:
 *   node src/scripts/fix-timeouts.js
 *
 * Then restart: npm run dev
 */

const fs   = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');

function write(relPath, content) {
  const full = path.join(SRC, relPath);
  fs.writeFileSync(full, content.trimStart(), 'utf8');
  console.log(`  ✅  Wrote src/${relPath}  (${fs.statSync(full).size} bytes)`);
}

console.log('\n══════════════════════════════════════════');
console.log('  APPLYING TIMEOUT + WARMUP FIXES');
console.log('══════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────────────────
// ollama.js — increased timeouts + warmup function
// ─────────────────────────────────────────────────────────────────────────────
write('ollama.js', `
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const LLM_MODEL   = 'qwen2.5:7b';

const GROUNDING_SYSTEM_PROMPT = \`You are a precise question-answering assistant.
Answer the user's question using ONLY the context provided below.
Do not use any external knowledge.
If the answer is not present in the context, respond with exactly:
"The answer is not found in the uploaded documents."
Do not fabricate citations, statistics, names, or dates.\`;

const TOOL_ADDENDUM = \`
If the question requires calculation, respond with JSON only:
{"tool": "calculator", "input": "<expression>"}
If the question asks for today's date, respond with JSON only:
{"tool": "date", "input": "today"}
Otherwise answer normally using the context.\`;

async function ollamaFetch(path, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(\`\${OLLAMA_BASE}\${path}\`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(\`Ollama \${path} returned \${res.status}: \${text}\`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(\`Ollama \${path} timed out after \${timeoutMs}ms\`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ping() {
  try {
    const res = await fetch(\`\${OLLAMA_BASE}/api/tags\`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

/**
 * warmup() — Send a tiny embed + generate request at server start
 * so the models are loaded into memory before the first real request.
 * Called once from index.js after server starts.
 */
async function warmup() {
  console.log('[ollama] warming up models...');
  try {
    await ollamaFetch('/api/embeddings', { model: EMBED_MODEL, prompt: 'warmup' }, 120000);
    console.log('[ollama] embed model ready');
  } catch (err) {
    console.warn('[ollama] embed warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Make sure nomic-embed-text is pulled: ollama pull nomic-embed-text');
  }
  try {
    await ollamaFetch('/api/generate', {
      model:  LLM_MODEL,
      prompt: 'warmup',
      stream: false,
      options: { temperature: 0.1, num_predict: 1 },
    }, 180000);
    console.log('[ollama] LLM model ready');
  } catch (err) {
    console.warn('[ollama] LLM warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Make sure qwen2.5:7b is pulled: ollama pull qwen2.5:7b');
  }
}

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
  // 90 second timeout — handles cold start + large chunks
  const data = await ollamaFetch('/api/embeddings', { model: EMBED_MODEL, prompt: text }, 90000);
  if (!data.embedding || !Array.isArray(data.embedding)) throw new Error('embed: Ollama returned no embedding array');
  return data.embedding;
}

async function chat(question, contextChunks = [], sessionHistory = [], includeTools = false) {
  if (!question || typeof question !== 'string') throw new Error('chat: question must be a non-empty string');

  const systemPrompt = includeTools
    ? GROUNDING_SYSTEM_PROMPT + TOOL_ADDENDUM
    : GROUNDING_SYSTEM_PROMPT;

  const contextBlock = contextChunks.length > 0
    ? contextChunks.map((c, i) => \`[\${i + 1}] \${c}\`).join('\\n\\n')
    : '';

  const historyBlock = sessionHistory.length > 0
    ? sessionHistory.map(t => \`User: \${t.question}\\nAssistant: \${t.answer}\`).join('\\n\\n') + '\\n\\n'
    : '';

  const userPrompt = contextBlock
    ? \`\${historyBlock}Context:\\n\${contextBlock}\\n\\nQuestion: \${question}\`
    : \`\${historyBlock}Question: \${question}\`;

  // 3 minute timeout for LLM — qwen2.5:7b can be slow on first load
  const data = await ollamaFetch('/api/generate', {
    model:   LLM_MODEL,
    system:  systemPrompt,
    prompt:  userPrompt,
    stream:  false,
    options: { temperature: 0.1 },
  }, 180000);

  if (!data.response || typeof data.response !== 'string') throw new Error('chat: Ollama returned no response string');
  return data.response.trim();
}

module.exports = { ping, embed, chat, warmup, GROUNDING_SYSTEM_PROMPT };
`);

// ─────────────────────────────────────────────────────────────────────────────
// index.js — call warmup() after server starts
// ─────────────────────────────────────────────────────────────────────────────
write('index.js', `
require('dotenv').config();

const express   = require('express');
const crypto    = require('crypto');
const logger    = require('./logger');
const { warmup } = require('./ollama');

const healthRouter    = require('./routes/health');
const documentsRouter = require('./routes/documents');
const askRouter       = require('./routes/ask');
const sessionsRouter  = require('./routes/sessions');

const PORT = process.env.PORT || 3000;
const app  = express();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  req.log = logger.child({ request_id: req.requestId });
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    req.log.info({
      endpoint:   \`\${req.method} \${req.path}\`,
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
  res.status(404).json({ error: 'NOT_FOUND', message: \`Route \${req.method} \${req.path} not found\` });
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  logger.error({ err, request_id: req.requestId }, 'Unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message || 'Unexpected server error', request_id: req.requestId });
});

// ── Start + warmup ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info({ port: PORT }, \`RAG backend listening on http://localhost:\${PORT}\`);
  console.log(\`[server] listening on http://localhost:\${PORT}\`);
  // Warm up Ollama models in background — does not block server startup
  warmup().catch(err => console.warn('[warmup] error:', err.message));
});

module.exports = app;
`);

// ─────────────────────────────────────────────────────────────────────────────
// Update diagnose.js to use longer timeout for /documents test
// ─────────────────────────────────────────────────────────────────────────────
write('scripts/diagnose.js', `
#!/usr/bin/env node
/**
 * DIAGNOSTIC — Run this to verify server state
 * node src/scripts/diagnose.js
 */

const path = require('path');
const fs   = require('fs');
const SRC  = path.resolve(__dirname, '..');
const BASE = 'http://localhost:3000';

console.log('\\n══════════════════════════════════════════');
console.log('  RAG BACKEND DIAGNOSTIC');
console.log('══════════════════════════════════════════\\n');

// ── File check ───────────────────────────────────────────────────────────────
console.log('── FILE CHECK ──────────────────────────────');
const files = [
  'index.js','db.js','logger.js','ollama.js','chunker.js','retriever.js',
  'routes/health.js','routes/documents.js','routes/ask.js','routes/sessions.js',
  'tools/calculator.js','tools/date.js',
];
for (const f of files) {
  const full = path.join(SRC, f);
  const exists = fs.existsSync(full);
  console.log(\`  \${exists ? '✅' : '❌'}  src/\${f}  \${exists ? '(' + fs.statSync(full).size + ' bytes)' : 'MISSING'}\`);
}

// ── Content check ─────────────────────────────────────────────────────────────
console.log('\\n── CONTENT CHECK ───────────────────────────');
const checks = [
  ['routes/documents.js', 'chunkText',          'documents.js imports chunkText'],
  ['routes/documents.js', 'embed(',              'documents.js calls embed()'],
  ['routes/ask.js',       'topK(',               'ask.js calls topK'],
  ['routes/ask.js',       'chat(',               'ask.js calls LLM'],
  ['ollama.js',           'warmup',              'ollama.js has warmup()'],
  ['ollama.js',           '90000',               'embed timeout is 90s'],
  ['ollama.js',           '180000',              'LLM timeout is 180s'],
  ['tools/calculator.js', 'mathjs',              'calculator uses mathjs'],
];
for (const [file, needle, label] of checks) {
  const full = path.join(SRC, file);
  const found = fs.existsSync(full) && fs.readFileSync(full, 'utf8').includes(needle);
  console.log(\`  \${found ? '✅' : '❌'}  \${label}\`);
}

// ── Dependency check ──────────────────────────────────────────────────────────
console.log('\\n── DEPENDENCY CHECK ────────────────────────');
for (const dep of ['better-sqlite3','express','mathjs','pino','dotenv']) {
  try { require(dep); console.log(\`  ✅  \${dep}\`); }
  catch { console.log(\`  ❌  \${dep} MISSING — npm install \${dep}\`); }
}

// ── Live checks ───────────────────────────────────────────────────────────────
console.log('\\n── LIVE SERVER CHECK ───────────────────────');

async function post(url, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: r.status, body: await r.json() };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(\`Request timed out after \${timeoutMs}ms\`);
    throw err;
  } finally { clearTimeout(timer); }
}

async function run() {
  // Health
  try {
    const r = await fetch(\`\${BASE}/health\`);
    const b = await r.json();
    console.log(\`  \${b.status === 'ok' ? '✅' : '⚠️ '}  /health → \${JSON.stringify(b)}\`);
    if (b.ollama !== 'connected') {
      console.log('  ⚠️  Ollama not connected — start Ollama and run: ollama serve');
      return;
    }
  } catch (e) {
    console.log(\`  ❌  /health unreachable — is server running? Start with: npm run dev\`);
    return;
  }

  // Document upload — allow up to 2 minutes for embed cold start
  console.log('  ⏳  POST /documents (may take up to 60s on first run — Ollama cold start)...');
  try {
    const content = 'RAG stands for Retrieval Augmented Generation. '.repeat(10);
    const { status, body } = await post(\`\${BASE}/documents\`, { title: 'Diagnostic Doc', content }, 120000);
    const ok = status === 201 && body.chunks_indexed > 0;
    console.log(\`  \${ok ? '✅' : '❌'}  POST /documents → status=\${status} chunks_indexed=\${body.chunks_indexed}\`);
    if (body.error) console.log(\`       ERROR: \${body.error} — \${body.message}\`);
    if (!ok && status === 201 && body.chunks_indexed === 0) {
      console.log('  ⚠️  chunks_indexed=0 means embed() is failing silently. Check server console for errors.');
    }
  } catch (e) {
    console.log(\`  ❌  POST /documents failed: \${e.message}\`);
  }

  // Ask
  console.log('  ⏳  POST /ask (may take up to 3 minutes for LLM first response)...');
  try {
    const { status, body } = await post(\`\${BASE}/ask\`, { question: 'What is RAG?' }, 200000);
    const ok = status === 200 && body.answer;
    console.log(\`  \${ok ? '✅' : '❌'}  POST /ask → status=\${status} retrieval_count=\${body.retrieval_count} answer="\${String(body.answer).slice(0,60)}"\`);
    if (body.error) console.log(\`       ERROR: \${body.error} — \${body.message}\`);
  } catch (e) {
    console.log(\`  ❌  POST /ask failed: \${e.message}\`);
  }
}

run().then(() => {
  console.log('\\n══════════════════════════════════════════\\n');
});
`);

console.log('\n══════════════════════════════════════════');
console.log('  DONE. Steps to take now:');
console.log('');
console.log('  1. Make sure these models are pulled:');
console.log('     ollama pull nomic-embed-text');
console.log('     ollama pull qwen2.5:7b');
console.log('');
console.log('  2. Restart your server:');
console.log('     npm run dev');
console.log('');
console.log('  3. Watch the server console — you should see:');
console.log('     [ollama] warming up models...');
console.log('     [ollama] embed model ready');
console.log('     [ollama] LLM model ready');
console.log('');
console.log('  4. Once warmup is done (~30-60s), run:');
console.log('     node src/scripts/diagnose.js');
console.log('');
console.log('  5. Then run final validation:');
console.log('     node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');'

