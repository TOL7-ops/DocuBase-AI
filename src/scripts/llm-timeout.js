#!/usr/bin/env node
/**
 * FIX LLM TIMEOUT — switches chat() to streaming mode
 *
 * Streaming means Ollama sends tokens as they're generated instead of
 * buffering the entire response. This prevents timeout on slow machines
 * because the connection stays active the whole time.
 *
 * Also raises LLM timeout to 5 minutes.
 *
 * Run from backend root:
 *   node src/scripts/fix-llm-timeout.js
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
console.log('  FIX: LLM streaming + 5 min timeout');
console.log('══════════════════════════════════════════\n');

write('ollama.js', `
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const LLM_MODEL   = 'qwen2.5:3b';

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

// ── Generic POST with abort timeout ──────────────────────────────────────────

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

// ── warmup ────────────────────────────────────────────────────────────────────

async function warmup() {
  console.log('[ollama] warming up models...');

  // Embed warmup
  try {
    const res = await ollamaFetch('/api/embeddings', { model: EMBED_MODEL, prompt: 'warmup' }, 90000);
    await res.json();
    console.log('[ollama] embed model ready (' + EMBED_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] embed warmup failed:', err.message);
    console.warn('[ollama] Run: ollama pull nomic-embed-text');
  }

  // LLM warmup — use streaming so it doesn't buffer
  try {
    const fullText = await chatStream('warmup', [], [], false, 120000);
    console.log('[ollama] LLM model ready (' + LLM_MODEL + ') — response: ' + fullText.slice(0, 40));
  } catch (err) {
    console.warn('[ollama] LLM warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Run: ollama pull ' + LLM_MODEL);
  }
}

// ── embed ─────────────────────────────────────────────────────────────────────

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
  const res  = await ollamaFetch('/api/embeddings', { model: EMBED_MODEL, prompt: text }, 90000);
  const data = await res.json();
  if (!data.embedding || !Array.isArray(data.embedding)) throw new Error('embed: Ollama returned no embedding array');
  return data.embedding;
}

// ── chatStream — streaming chat, returns full assembled string ────────────────
//
// Ollama streaming sends newline-delimited JSON objects:
//   {"model":"...","response":"token","done":false}
//   {"model":"...","response":"","done":true}
//
// We read the stream line by line and concatenate response tokens.
// This keeps the HTTP connection alive during generation, preventing
// timeout errors that occur when buffering large responses.

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
    model:   LLM_MODEL,
    system:  systemPrompt,
    prompt:  userPrompt,
    stream:  true,                       // ← streaming enabled
    options: { temperature: 0.1 },
  }, timeoutMs);

  // Read the NDJSON stream
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let fullText  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.response) fullText += obj.response;
        if (obj.done) break;
      } catch {
        // skip malformed lines
      }
    }
  }

  return fullText.trim();
}

// ── Public chat() ─────────────────────────────────────────────────────────────

async function chat(question, contextChunks = [], sessionHistory = [], includeTools = false) {
  if (!question || typeof question !== 'string') throw new Error('chat: question must be a non-empty string');
  // 5 minute timeout — generous for slow hardware; streaming keeps connection alive
  return chatStream(question, contextChunks, sessionHistory, includeTools, 300000);
}

module.exports = { ping, embed, chat, warmup, GROUNDING_SYSTEM_PROMPT };
`);

console.log('\n══════════════════════════════════════════');
console.log('  DONE. Steps:\n');
console.log('  1. Restart your server:');
console.log('     npm run dev\n');
console.log('  2. Wait for both ready lines:');
console.log('     [ollama] embed model ready (nomic-embed-text)');
console.log('     [ollama] LLM model ready (qwen2.5:3b)\n');
console.log('  3. Run validation:');
console.log('     node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');