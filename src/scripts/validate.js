#!/usr/bin/env node
/**
 * FINAL VALIDATION SCRIPT
 *
 * Runs all 10 checks from Contract V2 Section 11.
 * Run with: node scripts/validate.js
 *
 * Requires:
 *  - Server running on localhost:3000
 *  - Ollama running with nomic-embed-text and qwen2.5:7b pulled
 */

const BASE = 'http://localhost:3000';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.log(`  ❌  ${label}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function run() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  RAG BACKEND — FINAL VALIDATION');
  console.log('  Contract V2 — 10 checks');
  console.log('══════════════════════════════════════════════\n');

  let docId, sessionId;

  // ── Check 1: Health ───────────────────────────────────────────────────────
  console.log('Check 1: GET /health returns ok');
  try {
    const { body } = await get('/health');
    if (body.status === 'ok' && body.ollama === 'connected' && body.db === 'connected') {
      ok('Health check passed');
    } else {
      fail('Health check', `status=${body.status} ollama=${body.ollama} db=${body.db}`);
    }
  } catch (e) { fail('Health check', e.message); }

  // ── Check 2: Upload document ──────────────────────────────────────────────
  console.log('\nCheck 2: POST /documents returns 201 with chunks_indexed > 0');
  const sampleContent = `
    Artificial intelligence (AI) is intelligence demonstrated by machines.
    Machine learning is a subset of AI that enables systems to learn from data.
    Deep learning uses neural networks with many layers to model complex patterns.
    Retrieval-Augmented Generation (RAG) combines retrieval systems with language models.
    RAG systems retrieve relevant documents before generating answers, improving accuracy.
    Vector databases store embeddings for efficient semantic search.
    Cosine similarity measures the angle between two vectors in high-dimensional space.
    Embeddings are dense numerical representations of text produced by encoder models.
    The transformer architecture powers most modern large language models.
    Attention mechanisms allow models to weigh the importance of different input tokens.
  `.repeat(5); // repeat to produce multiple chunks

  try {
    const { status, body } = await post('/documents', {
      title:   'AI Fundamentals',
      content: sampleContent,
    });
    if (status === 201 && body.chunks_indexed > 0 && body.document_id) {
      ok(`Document uploaded — ${body.chunks_indexed} chunks indexed`);
      docId = body.document_id;
    } else {
      fail('Document upload', `status=${status} chunks=${body.chunks_indexed}`);
    }
  } catch (e) { fail('Document upload', e.message); }

  // ── Check 3: List documents ───────────────────────────────────────────────
  console.log('\nCheck 3: GET /documents lists uploaded documents');
  try {
    const { body } = await get('/documents');
    const found = Array.isArray(body) && body.some(d => d.document_id === docId);
    if (found) {
      ok('Document appears in list');
    } else {
      fail('Document list', `docId ${docId} not found in response`);
    }
  } catch (e) { fail('Document list', e.message); }

  // ── Check 4: Grounded answer ──────────────────────────────────────────────
  console.log('\nCheck 4: POST /ask returns grounded answer with sources');
  try {
    const { status, body } = await post('/ask', { question: 'What is RAG?' });
    if (
      status === 200 &&
      body.answer &&
      body.answer !== 'The answer is not found in the uploaded documents.' &&
      body.sources.length > 0 &&
      body.retrieval_count > 0 &&
      body.session_id
    ) {
      ok(`Grounded answer returned — retrieval_count=${body.retrieval_count}`);
      sessionId = body.session_id;
    } else {
      fail('Grounded answer', `answer="${body.answer?.slice(0,80)}" sources=${body.sources?.length}`);
    }
  } catch (e) { fail('Grounded answer', e.message); }

  // ── Check 5: Fallback answer ──────────────────────────────────────────────
  console.log('\nCheck 5: POST /ask returns fallback for off-topic question');
  try {
    const { status, body } = await post('/ask', {
      question: 'What is the capital of the moon and the price of moon cheese?',
    });
    if (
      status === 200 &&
      body.answer === 'The answer is not found in the uploaded documents.' &&
      body.retrieval_count === 0
    ) {
      ok('Fallback answer returned correctly');
    } else {
      fail('Fallback answer', `answer="${body.answer?.slice(0,80)}" count=${body.retrieval_count}`);
    }
  } catch (e) { fail('Fallback answer', e.message); }

  // ── Check 6: Session history ──────────────────────────────────────────────
  console.log('\nCheck 6: GET /sessions/:id returns ordered history');
  try {
    if (sessionId) {
      const { status, body } = await get(`/sessions/${sessionId}`);
      if (status === 200 && Array.isArray(body.history) && body.history.length > 0) {
        ok(`Session history has ${body.history.length} turn(s)`);
      } else {
        fail('Session history', `status=${status} turns=${body.history?.length}`);
      }
    } else {
      fail('Session history', 'No session_id from check 4');
    }
  } catch (e) { fail('Session history', e.message); }

  // ── Check 7: Calculator tool ──────────────────────────────────────────────
  console.log('\nCheck 7: Calculator tool — 142 * 365 = 51830');
  try {
    const { status, body } = await post('/ask', { question: 'What is 142 * 365?' });
    if (status === 200 && body.answer.includes('51830') && body.tool_used === 'calculator') {
      ok('Calculator tool returned correct result');
    } else {
      fail('Calculator tool', `answer="${body.answer?.slice(0,80)}" tool_used=${body.tool_used}`);
    }
  } catch (e) { fail('Calculator tool', e.message); }

  // ── Check 8: Date tool ────────────────────────────────────────────────────
  console.log("\nCheck 8: Date tool — returns ISO-8601 date");
  try {
    const { status, body } = await post('/ask', { question: "What is today's date?" });
    const isoPattern = /\d{4}-\d{2}-\d{2}/;
    if (status === 200 && isoPattern.test(body.answer) && body.tool_used === 'date') {
      ok(`Date tool returned: ${body.answer.match(isoPattern)[0]}`);
    } else {
      fail('Date tool', `answer="${body.answer?.slice(0,80)}" tool_used=${body.tool_used}`);
    }
  } catch (e) { fail('Date tool', e.message); }

  // ── Check 9: Error shapes ─────────────────────────────────────────────────
  console.log('\nCheck 9: Invalid request returns correct error shape');
  try {
    const { status, body } = await post('/ask', { question: 'x' }); // too short
    if (status === 400 && body.error === 'VALIDATION_ERROR' && body.message) {
      ok('400 error shape is correct');
    } else {
      fail('Error shape', `status=${status} error=${body.error}`);
    }
  } catch (e) { fail('Error shape', e.message); }

  // ── Check 10: Session 404 ─────────────────────────────────────────────────
  console.log('\nCheck 10: Unknown session_id returns 404 SESSION_NOT_FOUND');
  try {
    const { status, body } = await post('/ask', {
      question:   'What is RAG?',
      session_id: 'non-existent-session-id-12345',
    });
    if (status === 404 && body.error === 'SESSION_NOT_FOUND') {
      ok('SESSION_NOT_FOUND returned correctly');
    } else {
      fail('Session 404', `status=${status} error=${body.error}`);
    }
  } catch (e) { fail('Session 404', e.message); }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Validation script error:', err);
  process.exit(1);
});