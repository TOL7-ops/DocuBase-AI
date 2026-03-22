#!/usr/bin/env node
/**
 * FIX STREAMING — Replace ReadableStream reader with Buffer-based approach
 *
 * Problem: res.body.getReader() is unreliable in Node.js 18 built-in fetch
 * on Windows (MINGW64/Git Bash). It silently drops data or hangs.
 *
 * Fix: Use Node.js native http/https module directly for the streaming
 * generate call. This bypasses fetch entirely for LLM calls and gives us
 * reliable chunked data events on all platforms.
 *
 * embed() keeps using fetch (non-streaming, small response — works fine).
 *
 * Run from backend root:
 *   node src/scripts/fix-streaming.js
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
console.log('  FIX: Node.js http streaming for LLM calls');
console.log('══════════════════════════════════════════\n');

write('ollama.js', `
const http  = require('http');
const https = require('https');

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const LLM_MODEL   = 'qwen2.5:3b';
const KEEP_ALIVE  = -1;

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

// ── Parse base URL ────────────────────────────────────────────────────────────

function parseBase(base) {
  const u = new URL(base);
  return {
    protocol: u.protocol,       // 'http:' or 'https:'
    hostname: u.hostname,
    port:     u.port || (u.protocol === 'https:' ? 443 : 80),
  };
}

// ── Native HTTP POST — returns full response body as string ───────────────────

function httpPost(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port } = parseBase(OLLAMA_BASE);
    const payload = JSON.stringify(body);
    const lib = protocol === 'https:' ? https : http;

    const options = {
      hostname,
      port,
      path:    urlPath,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(\`Ollama \${urlPath} returned \${res.statusCode}: \${text}\`));
        } else {
          resolve(text);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(\`Ollama \${urlPath} timed out after \${timeoutMs}ms\`));
    });

    req.write(payload);
    req.end();
  });
}

// ── Native HTTP POST with streaming — assembles NDJSON tokens ────────────────

function httpPostStream(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port } = parseBase(OLLAMA_BASE);
    const payload = JSON.stringify(body);
    const lib = protocol === 'https:' ? https : http;

    const options = {
      hostname,
      port,
      path:    urlPath,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    let fullText = '';
    let buffer   = '';
    let settled  = false;

    function done(text) {
      if (settled) return;
      settled = true;
      resolve(text.trim());
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    const req = lib.request(options, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => fail(new Error(\`Ollama \${urlPath} returned \${res.statusCode}: \${Buffer.concat(chunks)}\`)));
        return;
      }

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\\n');
        buffer = lines.pop(); // keep last incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.response) fullText += obj.response;
            if (obj.done === true) {
              done(fullText);
              return;
            }
          } catch { /* skip malformed lines */ }
        }
      });

      res.on('end', () => done(fullText));
      res.on('error', fail);
    });

    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      fail(new Error(\`Ollama \${urlPath} timed out after \${timeoutMs}ms\`));
    });

    req.write(payload);
    req.end();
  });
}

// ── ping ──────────────────────────────────────────────────────────────────────

async function ping() {
  try {
    const text = await httpPost('/api/tags', {}, 5000).catch(() => null);
    return text !== null;
  } catch { return false; }
}

// Actually ping via GET not POST
function pingGet() {
  return new Promise((resolve) => {
    const { protocol, hostname, port } = parseBase(OLLAMA_BASE);
    const lib = protocol === 'https:' ? https : http;
    const req = lib.get({ hostname, port, path: '/api/tags' }, (res) => {
      resolve(res.statusCode < 400);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

async function ping2() {
  return pingGet();
}

// ── embed ─────────────────────────────────────────────────────────────────────

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
  const raw  = await httpPost('/api/embeddings', {
    model:      EMBED_MODEL,
    prompt:     text,
    keep_alive: KEEP_ALIVE,
  }, 180000);
  const data = JSON.parse(raw);
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error('embed: Ollama returned no embedding array. Got: ' + raw.slice(0, 200));
  }
  return data.embedding;
}

// ── chat ──────────────────────────────────────────────────────────────────────

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

  return httpPostStream('/api/generate', {
    model:      LLM_MODEL,
    system:     systemPrompt,
    prompt:     userPrompt,
    stream:     true,
    keep_alive: KEEP_ALIVE,
    options:    { temperature: 0.1 },
  }, 300000);
}

// ── warmup ────────────────────────────────────────────────────────────────────

async function warmup() {
  console.log('[ollama] warming up models...');

  // LLM first
  try {
    const text = await httpPostStream('/api/generate', {
      model:      LLM_MODEL,
      prompt:     'Say "ready".',
      stream:     true,
      keep_alive: KEEP_ALIVE,
      options:    { temperature: 0.1, num_predict: 5 },
    }, 300000);
    console.log('[ollama] LLM ready (' + LLM_MODEL + ') response: ' + text.slice(0, 40));
  } catch (err) {
    console.warn('[ollama] LLM warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Run: ollama pull ' + LLM_MODEL);
  }

  // Embed second — pin in memory
  try {
    const raw  = await httpPost('/api/embeddings', {
      model:      EMBED_MODEL,
      prompt:     'warmup',
      keep_alive: KEEP_ALIVE,
    }, 180000);
    JSON.parse(raw); // validate it parsed
    console.log('[ollama] embed ready (' + EMBED_MODEL + ')');
  } catch (err) {
    console.warn('[ollama] embed warmup failed (non-fatal):', err.message);
    console.warn('[ollama] Run: ollama pull ' + EMBED_MODEL);
  }

  console.log('[ollama] all models loaded — server ready');
}

module.exports = { ping: ping2, embed, chat, warmup, GROUNDING_SYSTEM_PROMPT };
`);

console.log('\n══════════════════════════════════════════');
console.log('  DONE. Steps:\n');
console.log('  1. Restart your server:');
console.log('     npm run dev\n');
console.log('  2. Wait for all three lines:');
console.log('     [ollama] LLM ready (qwen2.5:3b)');
console.log('     [ollama] embed ready (nomic-embed-text)');
console.log('     [ollama] all models loaded — server ready\n');
console.log('  3. Run validation:');
console.log('     node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');