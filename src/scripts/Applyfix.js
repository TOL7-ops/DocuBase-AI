#!/usr/bin/env node
/**
 * APPLY FIXES — Rewrites all source files to the correct Phase 3–8 versions.
 *
 * Run from your backend root:
 *   node src/scripts/apply-fixes.js
 *
 * This is safe to run on a live project — it only writes to src/.
 * Restart your server after running this.
 */

const fs   = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');

function write(relPath, content) {
  const full = path.join(SRC, relPath);
  const dir  = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content.trimStart(), 'utf8');
  console.log(`  ✅  Wrote src/${relPath}  (${fs.statSync(full).size} bytes)`);
}

console.log('\n══════════════════════════════════════════');
console.log('  APPLYING FIXES — Phases 3–8');
console.log('══════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────────────────
// chunker.js
// ─────────────────────────────────────────────────────────────────────────────
write('chunker.js', `
const crypto = require('crypto');

const CHUNK_CHARS   = 2048;
const OVERLAP_CHARS =  256;
const MIN_CHARS     =  200;
const STEP          = CHUNK_CHARS - OVERLAP_CHARS; // 1792

const SENTENCE_END_RE = /[.!?\\n]{1,3}\\s+/g;

function cleanText(text) {
  return text
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .replace(/[ \\t]+/g, ' ')
    .trim();
}

function findBreakPoint(text, searchStart, searchEnd) {
  const window = text.slice(searchStart, searchEnd);

  const paraIdx = window.lastIndexOf('\\n\\n');
  if (paraIdx !== -1 && paraIdx > 0) return searchStart + paraIdx + 2;

  let lastSentenceEnd = -1;
  let match;
  SENTENCE_END_RE.lastIndex = 0;
  while ((match = SENTENCE_END_RE.exec(window)) !== null) {
    lastSentenceEnd = match.index + match[0].length;
  }
  if (lastSentenceEnd > 0) return searchStart + lastSentenceEnd;

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) return searchStart + lastSpace + 1;

  return searchEnd;
}

function chunkText(rawText, documentId) {
  if (!rawText || typeof rawText !== 'string') throw new Error('chunkText: rawText must be a non-empty string');
  if (!documentId || typeof documentId !== 'string') throw new Error('chunkText: documentId must be a non-empty string');

  const text = cleanText(rawText);
  const chunks = [];
  let pos = 0;
  let chunkIndex = 0;

  if (text.length <= CHUNK_CHARS) {
    if (text.length >= MIN_CHARS) {
      chunks.push({ chunk_id: crypto.randomUUID(), document_id: documentId, chunk_index: 0, content: text, char_start: 0, char_end: text.length });
    }
    return chunks;
  }

  while (pos < text.length) {
    const rawEnd = Math.min(pos + CHUNK_CHARS, text.length);
    let end;

    if (rawEnd === text.length) {
      end = text.length;
    } else {
      const searchStart = pos + Math.floor(CHUNK_CHARS * 0.75);
      end = findBreakPoint(text, searchStart, rawEnd);
    }

    const content = text.slice(pos, end).trim();

    if (content.length >= MIN_CHARS) {
      chunks.push({ chunk_id: crypto.randomUUID(), document_id: documentId, chunk_index: chunkIndex, content, char_start: pos, char_end: end });
      chunkIndex++;
    }

    const prevPos = pos;
    pos = Math.max(end - OVERLAP_CHARS, pos + STEP);
    if (pos <= prevPos) pos = end;
  }

  return chunks;
}

module.exports = { chunkText, cleanText };
`);

// ─────────────────────────────────────────────────────────────────────────────
// ollama.js
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

async function ollamaFetch(path, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(\`\${OLLAMA_BASE}\${path}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
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
    const res = await fetch(\`\${OLLAMA_BASE}/api/tags\`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed: text must be a non-empty string');
  const data = await ollamaFetch('/api/embeddings', { model: EMBED_MODEL, prompt: text }, 15000);
  if (!data.embedding || !Array.isArray(data.embedding)) throw new Error('embed: Ollama returned no embedding array');
  return data.embedding;
}

async function chat(question, contextChunks = [], sessionHistory = [], includeTools = false) {
  if (!question || typeof question !== 'string') throw new Error('chat: question must be a non-empty string');

  const systemPrompt = includeTools ? GROUNDING_SYSTEM_PROMPT + TOOL_ADDENDUM : GROUNDING_SYSTEM_PROMPT;

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
    model: LLM_MODEL,
    system: systemPrompt,
    prompt: userPrompt,
    stream: false,
    options: { temperature: 0.1 },
  }, 120000);

  if (!data.response || typeof data.response !== 'string') throw new Error('chat: Ollama returned no response string');
  return data.response.trim();
}

module.exports = { ping, embed, chat, GROUNDING_SYSTEM_PROMPT };
`);

// ─────────────────────────────────────────────────────────────────────────────
// retriever.js
// ─────────────────────────────────────────────────────────────────────────────
write('retriever.js', `
const db = require('./db');

const TOP_K     = 5;
const MIN_SCORE = 0.30;

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
    WHERE c.embedding IS NOT NULL AND c.embedding != ''
  \`).all();

  if (rows.length === 0) return [];

  const scored = [];
  for (const row of rows) {
    let chunkEmbedding;
    try { chunkEmbedding = JSON.parse(row.embedding); } catch { continue; }
    if (!Array.isArray(chunkEmbedding) || chunkEmbedding.length === 0) continue;

    const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
    if (score >= threshold) {
      scored.push({
        chunk_id:       row.chunk_id,
        document_id:    row.document_id,
        document_title: row.document_title,
        content:        row.content,
        relevance_score: Math.round(score * 10000) / 10000,
      });
    }
  }

  return scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, k);
}

module.exports = { cosineSimilarity, topK };
`);

// ─────────────────────────────────────────────────────────────────────────────
// routes/documents.js
// ─────────────────────────────────────────────────────────────────────────────
write('routes/documents.js', `
const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { chunkText } = require('../chunker');
const { embed }     = require('../ollama');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const docs = db.prepare(\`
      SELECT d.document_id, d.title, d.created_at, COUNT(c.chunk_id) AS chunk_count
      FROM documents d
      LEFT JOIN chunks c ON d.document_id = c.document_id
      GROUP BY d.document_id
      ORDER BY d.created_at DESC
    \`).all();

    res.status(200).json(docs.map(d => ({
      document_id: d.document_id,
      title:       d.title,
      chunk_count: Number(d.chunk_count),
      created_at:  d.created_at,
    })));
  } catch (err) {
    console.error('GET /documents error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve documents', request_id: req.requestId });
  }
});

router.post('/', async (req, res) => {
  const { title, content } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title is required and must be a non-empty string', field: 'title' });
  if (title.length > 255)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title must be max 255 characters', field: 'title' });
  if (!content || typeof content !== 'string')
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'content is required', field: 'content' });
  if (content.length < 10)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'content must be at least 10 characters', field: 'content' });
  if (content.length > 500000)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'content must be max 500,000 characters', field: 'content' });

  const document_id = crypto.randomUUID();
  const created_at  = new Date().toISOString();

  try {
    // 1. Chunk
    const chunks = chunkText(content, document_id);
    console.log(\`[documents] chunked into \${chunks.length} chunks\`);

    // 2. Embed each chunk sequentially
    const chunksWithEmbeddings = [];
    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
      chunksWithEmbeddings.push({ ...chunk, embedding: JSON.stringify(embedding) });
    }
    console.log(\`[documents] embedded \${chunksWithEmbeddings.length} chunks\`);

    // 3. Persist in transaction
    db.transaction(() => {
      db.prepare('INSERT INTO documents (document_id, title, created_at) VALUES (@document_id, @title, @created_at)')
        .run({ document_id, title: title.trim(), created_at });

      const insertChunk = db.prepare(\`
        INSERT INTO chunks (chunk_id, document_id, chunk_index, content, char_start, char_end, embedding)
        VALUES (@chunk_id, @document_id, @chunk_index, @content, @char_start, @char_end, @embedding)
      \`);
      for (const c of chunksWithEmbeddings) insertChunk.run(c);
    })();

    res.status(201).json({ document_id, title: title.trim(), chunks_indexed: chunksWithEmbeddings.length, created_at });

  } catch (err) {
    console.error('[documents] POST error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message || 'Failed to store document', request_id: req.requestId });
  }
});

module.exports = router;
`);

// ─────────────────────────────────────────────────────────────────────────────
// routes/ask.js
// ─────────────────────────────────────────────────────────────────────────────
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

function getSessionHistory(sessionId, limit = 5) {
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

function parseTool(llmResponse) {
  const trimmed = llmResponse.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.tool && parsed.input !== undefined) return { tool: parsed.tool, input: String(parsed.input) };
  } catch {}
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
    if (err.code === 'SESSION_NOT_FOUND') return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: err.detail });
    throw err;
  }

  try {
    const queryEmbedding = await embed(question.trim());
    const retrieved      = topK(queryEmbedding);
    console.log(\`[ask] retrieved \${retrieved.length} chunks\`);

    if (retrieved.length === 0) {
      saveTurn({ session_id, question, answer: FALLBACK_ANSWER, sources: [], tool_used: null });
      return res.status(200).json({ answer: FALLBACK_ANSWER, sources: [], session_id, retrieval_count: 0, tool_used: null });
    }

    const history       = getSessionHistory(session_id);
    const contextChunks = retrieved.map(r => r.content);
    const llmRaw        = await chat(question.trim(), contextChunks, history, true);
    console.log(\`[ask] LLM response: \${llmRaw.slice(0, 80)}...\`);

    let finalAnswer, tool_used = null;
    const toolSuggestion = parseTool(llmRaw);
    if (toolSuggestion) {
      const toolResult = executeTool(toolSuggestion);
      if (toolResult) { finalAnswer = toolResult.answer; tool_used = toolResult.tool_used; }
      else { finalAnswer = llmRaw; }
    } else {
      finalAnswer = llmRaw;
    }

    const sources = retrieved.map(r => ({
      chunk_id: r.chunk_id, document_id: r.document_id,
      document_title: r.document_title, relevance_score: r.relevance_score,
    }));

    saveTurn({ session_id, question, answer: finalAnswer, sources, tool_used });

    return res.status(200).json({ answer: finalAnswer, sources, session_id, retrieval_count: retrieved.length, tool_used });

  } catch (err) {
    console.error('[ask] error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message || 'Ask failed', request_id: req.requestId });
  }
});

module.exports = router;
`);

// ─────────────────────────────────────────────────────────────────────────────
// tools/calculator.js
// ─────────────────────────────────────────────────────────────────────────────
write('tools/calculator.js', `
const math = require('mathjs');

function run(input) {
  if (!input || typeof input !== 'string') return { result: null, error: 'Input must be a non-empty string' };
  const sanitised = input.trim();
  if (sanitised.length > 500) return { result: null, error: 'Expression too long (max 500 chars)' };

  try {
    const raw = math.evaluate(sanitised);
    let result;
    if (typeof raw === 'number') {
      if (!isFinite(raw)) return { result: null, error: 'Result is not finite (e.g. division by zero)' };
      result = Number.isInteger(raw) ? String(raw) : String(parseFloat(raw.toPrecision(12)));
    } else if (typeof raw === 'bigint') {
      result = String(raw);
    } else {
      result = math.format(raw, { precision: 12 });
    }
    return { result, error: null };
  } catch (err) {
    return { result: null, error: err.message || String(err) };
  }
}

module.exports = { run };
`);

// ─────────────────────────────────────────────────────────────────────────────
// tools/date.js
// ─────────────────────────────────────────────────────────────────────────────
write('tools/date.js', `
function run(input) {
  if (!input || typeof input !== 'string') return { result: null, error: 'Input must be a non-empty string' };
  const cmd = input.trim().toLowerCase();
  const now = new Date();
  switch (cmd) {
    case 'today': {
      const yyyy = now.getFullYear();
      const mm   = String(now.getMonth() + 1).padStart(2, '0');
      const dd   = String(now.getDate()).padStart(2, '0');
      return { result: \`\${yyyy}-\${mm}-\${dd}\`, error: null };
    }
    case 'now':       return { result: now.toISOString(), error: null };
    case 'timestamp': return { result: String(now.getTime()), error: null };
    default:          return { result: null, error: \`Unsupported input: "\${input}". Use "today", "now", or "timestamp"\` };
  }
}
module.exports = { run };
`);

console.log('\n══════════════════════════════════════════');
console.log('  ALL FILES WRITTEN.');
console.log('  Next steps:');
console.log('  1. npm install mathjs   (if not already installed)');
console.log('  2. Restart your server: Ctrl+C then npm run dev');
console.log('  3. node src/scripts/diagnose.js');
console.log('  4. node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');