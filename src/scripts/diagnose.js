#!/usr/bin/env node
/**
 * DIAGNOSTIC — Run this to verify server state
 * node src/scripts/diagnose.js
 */

const path = require('path');
const fs   = require('fs');
const SRC  = path.resolve(__dirname, '..');
const BASE = 'http://localhost:3000';

console.log('\n══════════════════════════════════════════');
console.log('  RAG BACKEND DIAGNOSTIC');
console.log('══════════════════════════════════════════\n');

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
  console.log(`  ${exists ? '✅' : '❌'}  src/${f}  ${exists ? '(' + fs.statSync(full).size + ' bytes)' : 'MISSING'}`);
}

// ── Content check ─────────────────────────────────────────────────────────────
console.log('\n── CONTENT CHECK ───────────────────────────');
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
  console.log(`  ${found ? '✅' : '❌'}  ${label}`);
}

// ── Dependency check ──────────────────────────────────────────────────────────
console.log('\n── DEPENDENCY CHECK ────────────────────────');
for (const dep of ['better-sqlite3','express','mathjs','pino','dotenv']) {
  try { require(dep); console.log(`  ✅  ${dep}`); }
  catch { console.log(`  ❌  ${dep} MISSING — npm install ${dep}`); }
}

// ── Live checks ───────────────────────────────────────────────────────────────
console.log('\n── LIVE SERVER CHECK ───────────────────────');

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
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally { clearTimeout(timer); }
}

async function run() {
  // Health
  try {
    const r = await fetch(`${BASE}/health`);
    const b = await r.json();
    console.log(`  ${b.status === 'ok' ? '✅' : '⚠️ '}  /health → ${JSON.stringify(b)}`);
    if (b.ollama !== 'connected') {
      console.log('  ⚠️  Ollama not connected — start Ollama and run: ollama serve');
      return;
    }
  } catch (e) {
    console.log(`  ❌  /health unreachable — is server running? Start with: npm run dev`);
    return;
  }

  // Document upload — allow up to 2 minutes for embed cold start
  console.log('  ⏳  POST /documents (may take up to 60s on first run — Ollama cold start)...');
  try {
    const content = 'RAG stands for Retrieval Augmented Generation. '.repeat(10);
    const { status, body } = await post(`${BASE}/documents`, { title: 'Diagnostic Doc', content }, 120000);
    const ok = status === 201 && body.chunks_indexed > 0;
    console.log(`  ${ok ? '✅' : '❌'}  POST /documents → status=${status} chunks_indexed=${body.chunks_indexed}`);
    if (body.error) console.log(`       ERROR: ${body.error} — ${body.message}`);
    if (!ok && status === 201 && body.chunks_indexed === 0) {
      console.log('  ⚠️  chunks_indexed=0 means embed() is failing silently. Check server console for errors.');
    }
  } catch (e) {
    console.log(`  ❌  POST /documents failed: ${e.message}`);
  }

  // Ask
  console.log('  ⏳  POST /ask (may take up to 3 minutes for LLM first response)...');
  try {
    const { status, body } = await post(`${BASE}/ask`, { question: 'What is RAG?' }, 200000);
    const ok = status === 200 && body.answer;
    console.log(`  ${ok ? '✅' : '❌'}  POST /ask → status=${status} retrieval_count=${body.retrieval_count} answer="${String(body.answer).slice(0,60)}"`);
    if (body.error) console.log(`       ERROR: ${body.error} — ${body.message}`);
  } catch (e) {
    console.log(`  ❌  POST /ask failed: ${e.message}`);
  }
}

run().then(() => {
  console.log('\n══════════════════════════════════════════\n');
});
