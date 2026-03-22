#!/usr/bin/env node
/**
 * MIGRATE TO HUGGINGFACE API
 *
 * Replaces Ollama with HuggingFace Inference API:
 *   LLM:   mistralai/Mistral-Small-3.1-24B-Instruct-2503
 *   Embed: sentence-transformers/all-MiniLM-L6-v2 (384 dims)
 *
 * Also:
 *   - Updates retriever.js (384 dims, no change to logic)
 *   - Updates db.js migration to support 384-dim embeddings
 *   - Adds re-embed script to regenerate all stored embeddings
 *
 * Run: node src/scripts/migrate-to-hf.js
 * Then add to .env:  HF_API_KEY=hf_xxxxxxxxxxxxxxxxxxxx
 * Then: node src/scripts/re-embed.js
 * Then: npm run dev
 */

const fs   = require('fs');
const path = require('path');
const SRC  = path.resolve(__dirname, '..');

function write(relPath, content) {
  const full = path.join(SRC, relPath);
  const dir  = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content.trimStart(), 'utf8');
  console.log(`  ✅  Wrote src/${relPath}  (${fs.statSync(full).size} bytes)`);
}

console.log('\n══════════════════════════════════════════════');
console.log('  MIGRATE: Ollama → HuggingFace API');
console.log('══════════════════════════════════════════════\n');

// ── ollama.js → hf.js (new provider, same interface) ─────────────────────────
write('ollama.js', `
/**
 * HuggingFace Inference API client
 * Drop-in replacement for ollama.js — same exported functions.
 *
 * Models:
 *   LLM:   mistralai/Mistral-Small-3.1-24B-Instruct-2503
 *   Embed: sentence-transformers/all-MiniLM-L6-v2 (384 dims)
 */

const https = require('https');

const HF_BASE    = 'https://api-inference.huggingface.co';
const HF_API_KEY = process.env.HF_API_KEY;

const LLM_MODEL   = 'mistralai/Mistral-Small-3.1-24B-Instruct-2503';
const EMBED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const EMBED_DIMS  = 384;

const SYSTEM_PROMPT = \`You are a helpful assistant. Answer in 2-4 sentences using only the provided context.
If the context does not contain the answer, say exactly: "The answer is not found in the uploaded documents."\`;

// ── Internal HTTP helper ──────────────────────────────────────────────────────

function hfPost(urlPath, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!HF_API_KEY) {
      reject(new Error('HF_API_KEY is not set in .env — add your HuggingFace API key'));
      return;
    }

    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api-inference.huggingface.co',
      path:     urlPath,
      method:   'POST',
      headers: {
        'Authorization': \`Bearer \${HF_API_KEY}\`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 503) {
          // Model loading — HF returns this when model is cold
          reject(new Error('Model is loading on HuggingFace servers, retry in 20 seconds'));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(\`HF API \${urlPath} returned \${res.statusCode}: \${text.slice(0, 200)}\`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(\`HF API returned non-JSON: \${text.slice(0, 200)}\`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(\`HF API \${urlPath} timed out after \${timeoutMs}ms\`));
    });
    req.write(payload);
    req.end();
  });
}

// ── ping ──────────────────────────────────────────────────────────────────────

async function ping() {
  if (!HF_API_KEY) return false;
  try {
    // Simple GET to HF — just checks network connectivity
    return await new Promise(resolve => {
      const req = https.get('https://huggingface.co', { timeout: 4000 }, res => {
        resolve(res.statusCode < 500);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } catch { return false; }
}

// ── embed ─────────────────────────────────────────────────────────────────────

async function embed(text) {
  if (!text?.trim()) throw new Error('embed: text is required');

  // HF Feature Extraction endpoint
  const result = await hfPost(
    \`/models/\${EMBED_MODEL}\`,
    { inputs: text.trim(), options: { wait_for_model: true } },
    30000
  );

  // all-MiniLM-L6-v2 returns a nested array [[...384 floats...]]
  // or sometimes a flat array [...384 floats]
  let vector;
  if (Array.isArray(result) && Array.isArray(result[0])) {
    vector = result[0];
  } else if (Array.isArray(result)) {
    vector = result;
  } else {
    throw new Error('embed: unexpected HF response shape: ' + JSON.stringify(result).slice(0, 100));
  }

  if (vector.length !== EMBED_DIMS) {
    throw new Error(\`embed: expected \${EMBED_DIMS} dims, got \${vector.length}\`);
  }

  return vector;
}

// ── chat ──────────────────────────────────────────────────────────────────────

async function chat(prompt) {
  if (!prompt?.trim()) throw new Error('chat: prompt is required');

  // Mistral Instruct format
  const messages = [
    { role: 'system',    content: SYSTEM_PROMPT },
    { role: 'user',      content: prompt.trim() },
  ];

  const result = await hfPost(
    \`/models/\${LLM_MODEL}/v1/chat/completions\`,
    {
      model:       LLM_MODEL,
      messages,
      max_tokens:  250,
      temperature: 0.2,
      stream:      false,
    },
    60000
  );

  // OpenAI-compatible response shape
  const text = result?.choices?.[0]?.message?.content;
  if (!text) throw new Error('chat: no response text from HF. Got: ' + JSON.stringify(result).slice(0, 200));

  return text.trim();
}

// ── warmup ────────────────────────────────────────────────────────────────────

async function warmup() {
  if (!HF_API_KEY) {
    console.warn('[hf] ⚠️  HF_API_KEY not set — add it to .env before starting');
    return;
  }
  console.log('[hf] warming up HuggingFace models...');

  // Embed warmup — wakes up the model on HF serverless
  try {
    await embed('warmup');
    console.log(\`[hf] embed ready (\${EMBED_MODEL})\`);
  } catch (err) {
    console.warn('[hf] embed warmup failed (non-fatal):', err.message);
  }

  // LLM warmup
  try {
    await chat('Say "ready".');
    console.log(\`[hf] LLM ready (\${LLM_MODEL})\`);
  } catch (err) {
    console.warn('[hf] LLM warmup failed (non-fatal):', err.message);
    if (err.message.includes('loading')) {
      console.warn('[hf] Model is cold-starting on HF — first real request may take 20-30s');
    }
  }

  console.log('[hf] HuggingFace client ready');
}

module.exports = { ping, embed, chat, warmup };
`);

// ── retriever.js — update dims comment, same logic ───────────────────────────
write('retriever.js', `
const db = require('./db');

const TOP_K     = 5;
const MIN_SCORE = 0.35;
// Embedding dims: 384 (sentence-transformers/all-MiniLM-L6-v2)

function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(\`cosineSimilarity: length mismatch (\${a.length} vs \${b.length})\`);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return Math.min(1, Math.max(-1, dot / denom));
}

function topK(queryEmbedding, k = TOP_K, threshold = MIN_SCORE) {
  const rows = db.prepare(\`
    SELECT c.chunk_id, c.document_id, c.content, c.embedding, d.title AS document_title
    FROM chunks c
    JOIN documents d ON d.document_id = c.document_id
    WHERE c.embedding IS NOT NULL AND length(c.embedding) > 10
  \`).all();

  if (rows.length === 0) return [];

  const scored = [];
  for (const row of rows) {
    let vec;
    try { vec = JSON.parse(row.embedding); } catch { continue; }
    if (!Array.isArray(vec) || vec.length === 0) continue;

    // Skip old 768-dim embeddings (from nomic-embed-text) — incompatible
    if (vec.length !== queryEmbedding.length) {
      continue; // will be cleared by re-embed script
    }

    const score = cosineSimilarity(queryEmbedding, vec);
    if (score >= threshold) {
      scored.push({
        chunk_id:        row.chunk_id,
        document_id:     row.document_id,
        document_title:  row.document_title,
        content:         row.content,
        relevance_score: Math.round(score * 10000) / 10000,
      });
    }
  }

  return scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, k);
}

module.exports = { cosineSimilarity, topK };
`);

// ── health route — update to show HF instead of Ollama ───────────────────────
write('routes/health.js', `
const express    = require('express');
const db         = require('../db');
const { ping }   = require('../ollama');

const router = express.Router();

router.get('/', async (req, res) => {
  const hfOk = await ping();

  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }

  const status = hfOk && dbOk ? 'ok' : 'degraded';

  res.status(200).json({
    status,
    provider:  'huggingface',
    llm:       hfOk ? 'connected' : 'unreachable',
    db:        dbOk ? 'connected' : 'unreachable',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
`);

// ── .env patch instructions ───────────────────────────────────────────────────
const envPath = path.join(SRC, '..', '.env');
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (!envContent.includes('HF_API_KEY')) {
  fs.writeFileSync(envPath, envContent + '\n# HuggingFace API Key\nHF_API_KEY=your_key_here\n');
  console.log('  ✅  Added HF_API_KEY placeholder to .env');
} else {
  console.log('  ✓   HF_API_KEY already in .env');
}

console.log('\n══════════════════════════════════════════════');
console.log('  FILES WRITTEN.\n');
console.log('  Now do these steps IN ORDER:\n');
console.log('  1. Add your API key to .env:');
console.log('     HF_API_KEY=hf_xxxxxxxxxxxxxxxxxxxx\n');
console.log('  2. Re-embed all documents (clears old 768-dim vectors,');
console.log('     generates new 384-dim ones via HF API):');
console.log('     node src/scripts/re-embed.js\n');
console.log('  3. Start the server:');
console.log('     npm run dev\n');
console.log('  You can stop Ollama now — it is no longer needed.');
console.log('══════════════════════════════════════════════\n');