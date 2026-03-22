#!/usr/bin/env node
/**
 * SWITCH MODEL — qwen2.5:7b → qwen2.5:3b
 *
 * Run from backend root:
 *   node src/scripts/switch-model.js
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
console.log('  SWITCHING LLM: qwen2.5:7b → qwen2.5:3b');
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

async function warmup() {
  console.log('[ollama] warming up models...');
  try {
    await ollamaFetch('/api/embeddings', { model: EMBED_MODEL, prompt: 'warmup' }, 90000);
    console.log('[ollama] embed model ready (' + EMBED_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] embed warmup failed:', err.message);
    console.warn('[ollama] Run: ollama pull nomic-embed-text');
  }
  try {
    await ollamaFetch('/api/generate', {
      model:   LLM_MODEL,
      prompt:  'warmup',
      stream:  false,
      options: { temperature: 0.1, num_predict: 1 },
    }, 90000);
    console.log('[ollama] LLM model ready (' + LLM_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] LLM warmup failed:', err.message);
    console.warn('[ollama] Run: ollama pull ' + LLM_MODEL);
  }
}

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
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

  const data = await ollamaFetch('/api/generate', {
    model:   LLM_MODEL,
    system:  systemPrompt,
    prompt:  userPrompt,
    stream:  false,
    options: { temperature: 0.1 },
  }, 90000);

  if (!data.response || typeof data.response !== 'string') throw new Error('chat: Ollama returned no response string');
  return data.response.trim();
}

module.exports = { ping, embed, chat, warmup, GROUNDING_SYSTEM_PROMPT };
`);

console.log('\n══════════════════════════════════════════');
console.log('  DONE. Steps to take now:\n');
console.log('  1. Pull the model (2.0 GB):');
console.log('     ollama pull qwen2.5:3b\n');
console.log('  2. Restart your server:');
console.log('     npm run dev\n');
console.log('  3. Wait for both ready lines:');
console.log('     [ollama] embed model ready (nomic-embed-text)');
console.log('     [ollama] LLM model ready (qwen2.5:3b)\n');
console.log('  4. Run validation:');
console.log('     node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');