#!/usr/bin/env node
/**
 * FIX EMBED TIMEOUT ON /ask
 *
 * Root cause: Ollama unloads nomic-embed-text from RAM after the document
 * upload completes to free memory. When /ask calls embed(), the model has
 * to reload from disk — which times out at 90s on slower machines.
 *
 * Fixes applied:
 *  1. keep_alive: -1 on all Ollama calls → models stay in memory indefinitely
 *  2. embed() timeout raised to 3 minutes (180s)
 *  3. Warmup pings embed AFTER LLM so both are hot at the end of warmup
 *  4. Add keep_alive to the embeddings API call (Ollama supports it there too)
 *
 * Run from backend root:
 *   node src/scripts/fix-embed-timeout.js
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

console.log('\n══════════════════════════════════════════');
console.log('  FIX: keep models in memory + raise embed timeout');
console.log('══════════════════════════════════════════\n');

write('ollama.js', `
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const LLM_MODEL   = 'qwen2.5:3b';

// keep_alive: -1 tells Ollama never to unload this model from RAM.
// Without this, Ollama evicts models between requests on low-memory machines.
const KEEP_ALIVE = -1;

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

// ── Generic fetch with abort timeout ─────────────────────────────────────────

async function ollamaFetch(urlPath, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(\`\${OLLAMA_BASE}\${urlPath}\`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(\`Ollama \${urlPath} returned \${res.status}: \${text}\`);
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(\`Ollama \${urlPath} timed out after \${timeoutMs}ms\`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── ping ──────────────────────────────────────────────────────────────────────

async function ping() {
  try {
    const res = await fetch(\`\${OLLAMA_BASE}/api/tags\`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

// ── embed ─────────────────────────────────────────────────────────────────────

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
  // 3 minute timeout + keep_alive so model is never evicted between requests
  const res  = await ollamaFetch('/api/embeddings', {
    model:      EMBED_MODEL,
    prompt:     text,
    keep_alive: KEEP_ALIVE,
  }, 180000);
  const data = await res.json();
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error('embed: Ollama returned no embedding array');
  }
  return data.embedding;
}

// ── chatStream ────────────────────────────────────────────────────────────────
// Streams NDJSON tokens from Ollama and assembles the full response string.
// Streaming keeps the HTTP connection alive so no timeout during generation.

async function chatStream(question, contextChunks, sessionHistory, includeTools, timeoutMs) {
  const systemPrompt = includeTools
    ? GROUNDING_SYSTEM_PROMPT + TOOL_ADDENDUM
    : GROUNDING_SYSTEM_PROMPT;

  const contextBlock = (contextChunks || []).length > 0
    ? contextChunks.map((c, i) => \`[\${i + 1}] \${c}\`).join('\\n\\n')
    : '';

  const historyBlock = (sessionHistory || []).length > 0
    ? sessionHistory.map(t => \`User: \${t.question}\\nAssistant: \${t.answer}\`).join('\\n\\n') + '\\n\\n'
    : '';

  const userPrompt = contextBlock
    ? \`\${historyBlock}Context:\\n\${contextBlock}\\n\\nQuestion: \${question}\`
    : \`\${historyBlock}Question: \${question}\`;

  const res = await ollamaFetch('/api/generate', {
    model:      LLM_MODEL,
    system:     systemPrompt,
    prompt:     userPrompt,
    stream:     true,
    keep_alive: KEEP_ALIVE,
    options:    { temperature: 0.1 },
  }, timeoutMs);

  // Read NDJSON stream line by line
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer   = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\\n');
    buffer = lines.pop(); // keep last incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.response) fullText += obj.response;
        if (obj.done) return fullText.trim();
      } catch { /* skip malformed lines */ }
    }
  }

  return fullText.trim();
}

// ── warmup ────────────────────────────────────────────────────────────────────
// Load LLM first (larger, slower), then embed — so both are hot when
// the server is ready to serve requests.

async function warmup() {
  console.log('[ollama] warming up models (this may take 1-2 min on first run)...');

  // 1. LLM first — largest model, needs to load from disk
  try {
    const text = await chatStream('Say "ready" and nothing else.', [], [], false, 300000);
    console.log('[ollama] LLM ready (' + LLM_MODEL + ') —', text.slice(0, 30));
  } catch (err) {
    console.warn('[ollama] LLM warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Make sure model is pulled: ollama pull ' + LLM_MODEL);
  }

  // 2. Embed second — pin it in memory after LLM is loaded
  try {
    const res = await ollamaFetch('/api/embeddings', {
      model:      EMBED_MODEL,
      prompt:     'warmup',
      keep_alive: KEEP_ALIVE,
    }, 180000);
    await res.json();
    console.log('[ollama] embed ready (' + EMBED_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] embed warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Make sure model is pulled: ollama pull ' + EMBED_MODEL);
  }

  console.log('[ollama] all models loaded — server ready to accept requests');
}

// ── chat (public) ─────────────────────────────────────────────────────────────

async function chat(question, contextChunks = [], sessionHistory = [], includeTools = false) {
  if (!question || typeof question !== 'string') throw new Error('chat: question must be a non-empty string');
  return chatStream(question, contextChunks, sessionHistory, includeTools, 300000);
}

module.exports = { ping, embed, chat, warmup, GROUNDING_SYSTEM_PROMPT };
`);

console.log('\n══════════════════════════════════════════');
console.log('  DONE. Steps:\n');
console.log('  1. Restart your server:');
console.log('     npm run dev\n');
console.log('  2. Wait until you see ALL THREE lines:');
console.log('     [ollama] LLM ready (qwen2.5:3b)');
console.log('     [ollama] embed ready (nomic-embed-text)');
console.log('     [ollama] all models loaded — server ready\n');
console.log('  3. Only then run validation:');
console.log('     node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');