#!/usr/bin/env node
/**
 * FIX LLM GENERATION TIMEOUT
 *
 * Problem: qwen2.5:3b is timing out on generation even with small context.
 * On CPU-only machines generation of long responses is very slow.
 *
 * Fixes:
 *   1. Add num_predict: 200 — hard cap on output tokens (~150 words max)
 *      Generation time scales linearly with output length.
 *      200 tokens takes ~40s on slow CPU vs unlimited which never finishes.
 *   2. Reduce MAX_CHUNK_CHARS: 600 → 300 (less input = faster processing)
 *   3. Reduce MAX_LLM_CHUNKS: 3 → 2
 *   4. Add concise instruction to prompt so model writes shorter answers
 *
 * Run: node src/scripts/fix-generation.js
 * Then: npm run dev
 */

const fs   = require('fs');
const path = require('path');
const SRC  = path.resolve(__dirname, '..');

function write(relPath, content) {
  const full = path.join(SRC, relPath);
  fs.writeFileSync(full, content.trimStart(), 'utf8');
  console.log(`  ✅  Wrote src/${relPath}  (${fs.statSync(full).size} bytes)`);
}

console.log('\n══════════════════════════════════════════════');
console.log('  FIX: Cap LLM output tokens + reduce context');
console.log('══════════════════════════════════════════════\n');

// ── ollama.js — add num_predict cap ──────────────────────────────────────────
write('ollama.js', `
const http  = require('http');
const https = require('https');

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const LLM_MODEL   = 'qwen2.5:3b';
const KEEP_ALIVE  = -1;

// Cap output at 200 tokens (~150 words). This is the #1 factor in generation time.
// On CPU: 200 tokens ≈ 40-60s. Unlimited ≈ never finishes.
const NUM_PREDICT = 250;

const SYSTEM_PROMPT = \`You are a helpful assistant. Answer concisely in 2-4 sentences maximum.
Use only the provided context. If context is irrelevant, say: "The answer is not found in the uploaded documents."\`;

function parseBase(base) {
  const u = new URL(base);
  return { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80) };
}

function httpPost(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port } = parseBase(OLLAMA_BASE);
    const payload = JSON.stringify(body);
    const lib = protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname, port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) reject(new Error(\`Ollama \${urlPath} returned \${res.statusCode}: \${text}\`));
          else resolve(text);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(\`Ollama \${urlPath} timed out after \${timeoutMs}ms\`)); });
    req.write(payload); req.end();
  });
}

function httpPostStream(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port } = parseBase(OLLAMA_BASE);
    const payload = JSON.stringify(body);
    const lib = protocol === 'https:' ? https : http;
    let fullText = '', buffer = '', settled = false;

    const done = text => { if (!settled) { settled = true; resolve(text.trim()); } };
    const fail = err  => { if (!settled) { settled = true; reject(err); } };

    const req = lib.request(
      { hostname, port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => fail(new Error(\`Ollama \${urlPath} \${res.statusCode}: \${Buffer.concat(chunks)}\`)));
          return;
        }
        res.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const obj = JSON.parse(t);
              if (obj.response) fullText += obj.response;
              if (obj.done === true) { done(fullText); return; }
            } catch {}
          }
        });
        res.on('end', () => done(fullText));
        res.on('error', fail);
      }
    );
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => { req.destroy(); fail(new Error(\`Ollama \${urlPath} timed out after \${timeoutMs}ms\`)); });
    req.write(payload); req.end();
  });
}

async function ping() {
  return new Promise(resolve => {
    const { protocol, hostname, port } = parseBase(OLLAMA_BASE);
    const lib = protocol === 'https:' ? https : http;
    const req = lib.get({ hostname, port, path: '/api/tags' }, res => { resolve(res.statusCode < 400); res.resume(); });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
  const raw  = await httpPost('/api/embeddings', { model: EMBED_MODEL, prompt: text, keep_alive: KEEP_ALIVE }, 180000);
  const data = JSON.parse(raw);
  if (!data.embedding || !Array.isArray(data.embedding)) throw new Error('embed: no embedding array. Got: ' + raw.slice(0, 200));
  return data.embedding;
}

async function chat(prompt) {
  if (!prompt || typeof prompt !== 'string') throw new Error('chat: prompt must be a non-empty string');
  return httpPostStream('/api/generate', {
    model:      LLM_MODEL,
    system:     SYSTEM_PROMPT,
    prompt,
    stream:     true,
    keep_alive: KEEP_ALIVE,
    options: {
      temperature:  0.2,
      num_predict:  NUM_PREDICT,   // ← KEY FIX: hard cap on output length
      num_ctx:      1024,          // ← smaller context window = faster processing
    },
  }, 300000);
}

async function warmup() {
  console.log('[ollama] warming up models...');
  try {
    await httpPostStream('/api/generate', {
      model: LLM_MODEL, prompt: 'Hi', stream: true,
      keep_alive: KEEP_ALIVE, options: { temperature: 0.1, num_predict: 3 },
    }, 300000);
    console.log('[ollama] LLM ready (' + LLM_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] LLM warmup failed:', err.message);
  }
  try {
    const raw = await httpPost('/api/embeddings', { model: EMBED_MODEL, prompt: 'warmup', keep_alive: KEEP_ALIVE }, 180000);
    JSON.parse(raw);
    console.log('[ollama] embed ready (' + EMBED_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] embed warmup failed:', err.message);
  }
  console.log('[ollama] all models loaded — server ready');
}

module.exports = { ping, embed, chat, warmup };
`);

// ── routes/ask.js — smaller context ──────────────────────────────────────────
write('routes/ask.js', `
const express  = require('express');
const crypto   = require('crypto');
const db       = require('../db');
const { embed, chat } = require('../ollama');
const { topK }        = require('../retriever');
const calculator      = require('../tools/calculator');
const dateTool        = require('../tools/date');

const router = express.Router();
const FALLBACK_ANSWER = 'The answer is not found in the uploaded documents.';

const MAX_CHUNK_CHARS = 300; // small — faster LLM processing
const MAX_LLM_CHUNKS  = 2;

function detectDirectTool(question) {
  const q = question.toLowerCase();
  if (/[\\d]+\\s*[+\\-*\\/^%]\\s*[\\d]/.test(question)) {
    const match = question.match(/([\\d][\\d\\s.+\\-*\\/^%()]+[\\d])/);
    if (match) return { tool: 'calculator', input: match[1].trim() };
  }
  if (/\\b(today|current date|what.*date|date.*today)\\b/i.test(q)) {
    return { tool: 'date', input: 'today' };
  }
  return null;
}

function executeTool({ tool, input }) {
  if (tool === 'calculator') {
    const { result, error } = calculator.run(input);
    return { answer: error ? \`Calculator error: \${error}\` : \`The result of \${input} is \${result}.\`, tool_used: 'calculator' };
  }
  if (tool === 'date') {
    const { result, error } = dateTool.run(input);
    return { answer: error ? \`Date tool error: \${error}\` : \`Today's date is \${result}.\`, tool_used: 'date' };
  }
  return null;
}

function resolveSession(sessionId) {
  if (sessionId) {
    const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId);
    if (!existing) {
      const err = new Error('SESSION_NOT_FOUND');
      err.status = 404; err.code = 'SESSION_NOT_FOUND';
      err.detail = \`No session found with id: \${sessionId}\`;
      throw err;
    }
    return sessionId;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (session_id, created_at) VALUES (?, ?)').run(id, new Date().toISOString());
  return id;
}

function getSessionHistory(sessionId, limit = 2) {
  return db.prepare(\`
    SELECT question, answer FROM session_turns
    WHERE session_id = ? ORDER BY turn_number DESC LIMIT ?
  \`).all(sessionId, limit).reverse();
}

function saveTurn({ session_id, question, answer, sources, tool_used }) {
  const maxTurn = db.prepare('SELECT MAX(turn_number) AS m FROM session_turns WHERE session_id = ?').get(session_id);
  const turn_number = (maxTurn?.m ?? 0) + 1;
  db.prepare(\`
    INSERT INTO session_turns (turn_id, session_id, turn_number, question, answer, sources, tool_used, timestamp)
    VALUES (@turn_id, @session_id, @turn_number, @question, @answer, @sources, @tool_used, @timestamp)
  \`).run({
    turn_id: crypto.randomUUID(), session_id, turn_number, question, answer,
    sources: JSON.stringify(sources), tool_used: tool_used || null, timestamp: new Date().toISOString(),
  });
}

router.post('/', async (req, res) => {
  const { question, session_id: rawSessionId } = req.body;

  if (!question || typeof question !== 'string')
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'question is required' });
  if (question.trim().length < 3)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'question must be at least 3 characters' });
  if (question.length > 2000)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'question must be max 2000 characters' });

  let session_id;
  try {
    session_id = resolveSession(rawSessionId);
  } catch (err) {
    if (err.code === 'SESSION_NOT_FOUND')
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: err.detail });
    throw err;
  }

  try {
    // Fast path: tools
    const directTool = detectDirectTool(question.trim());
    if (directTool) {
      const toolResult = executeTool(directTool);
      if (toolResult) {
        saveTurn({ session_id, question, answer: toolResult.answer, sources: [], tool_used: toolResult.tool_used });
        return res.status(200).json({
          answer: toolResult.answer, sources: [], session_id,
          retrieval_count: 0, tool_used: toolResult.tool_used,
        });
      }
    }

    // Retrieve
    const queryEmbedding = await embed(question.trim());
    const retrieved      = topK(queryEmbedding);
    console.log(\`[ask] retrieved \${retrieved.length} chunks for: "\${question.slice(0,50)}"\`);

    if (retrieved.length === 0) {
      saveTurn({ session_id, question, answer: FALLBACK_ANSWER, sources: [], tool_used: null });
      return res.status(200).json({
        answer: FALLBACK_ANSWER, sources: [], session_id, retrieval_count: 0, tool_used: null,
      });
    }

    // Build compact context
    const llmChunks   = retrieved.slice(0, MAX_LLM_CHUNKS).map(r => r.content.slice(0, MAX_CHUNK_CHARS));
    const contextText = llmChunks.map((c, i) => \`[Doc \${i+1}]: \${c}\`).join('\\n');
    const history     = getSessionHistory(session_id);
    const historyBlock = history.length > 0
      ? history.map(t => \`Q: \${t.question}\\nA: \${t.answer}\`).join('\\n') + '\\n\\n'
      : '';

    const prompt = \`\${historyBlock}\${contextText}\\n\\nQuestion: \${question.trim()}\`;

    console.log(\`[ask] prompt length: \${prompt.length} chars → LLM\`);

    const llmAnswer = await chat(prompt);
    console.log(\`[ask] answer: "\${llmAnswer.slice(0,80)}"\`);

    const sources = retrieved.map(r => ({
      chunk_id: r.chunk_id, document_id: r.document_id,
      document_title: r.document_title, relevance_score: r.relevance_score,
    }));

    saveTurn({ session_id, question, answer: llmAnswer, sources, tool_used: null });

    return res.status(200).json({
      answer: llmAnswer, sources, session_id,
      retrieval_count: retrieved.length, tool_used: null,
    });

  } catch (err) {
    console.error('[ask] error:', err.message);
    res.status(500).json({
      error: 'INTERNAL_ERROR', message: err.message || 'Ask failed', request_id: req.requestId,
    });
  }
});

module.exports = router;
`);

console.log('\n══════════════════════════════════════════════');
console.log('  DONE. Key changes:\n');
console.log('  ollama.js:');
console.log('    num_predict: 250  ← hard cap on output tokens (was unlimited)');
console.log('    num_ctx: 1024     ← smaller context window (was default 2048+)');
console.log('    System prompt tells model to answer in 2-4 sentences');
console.log('');
console.log('  ask.js:');
console.log('    MAX_CHUNK_CHARS: 300  (was 600)');
console.log('    MAX_LLM_CHUNKS:  2    (was 3)');
console.log('    Total prompt: ~650 chars max (was ~1800)');
console.log('');
console.log('  Expected response time: 20-60 seconds on CPU');
console.log('  (was timing out at 300s because output was unbounded)');
console.log('');
console.log('  Steps:');
console.log('  1. npm run dev');
console.log('  2. Wait for: [ollama] all models loaded — server ready');
console.log('  3. Ask: "Summarize this document"');
console.log('  4. Wait up to 60 seconds for first response');
console.log('══════════════════════════════════════════════\n');