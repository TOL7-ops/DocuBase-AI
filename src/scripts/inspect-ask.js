#!/usr/bin/env node
/**
 * FIX LLM CONTEXT OVERLOAD
 *
 * Problem: chat() times out because the prompt is too large.
 *   - 5 chunks × ~2000 chars each = ~10,000 chars sent to qwen2.5:3b
 *   - On CPU-only inference this takes longer than 300 seconds
 *
 * Fixes:
 *   1. Pass only top 2 chunks to LLM (not 5) — retrieval still uses 5 for scoring
 *   2. Truncate each chunk to 400 chars — enough context, far less tokens
 *   3. Keep system prompt short — remove tool addendum from context calls
 *   4. ask.js: split tool questions from context questions — tools never need RAG context
 *
 * Run from backend root:
 *   node src/scripts/fix-context.js
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
console.log('  FIX: Reduce LLM context size');
console.log('══════════════════════════════════════════\n');

// ── routes/ask.js — smarter context passing ───────────────────────────────────
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

// Max chars per chunk sent to LLM — keeps prompt small for CPU inference
const MAX_CHUNK_CHARS = 400;
// Max chunks sent to LLM — retrieval still scores all 5, we just trim before LLM
const MAX_LLM_CHUNKS  = 2;

// ── Tool detection BEFORE embed/LLM ──────────────────────────────────────────
// Calculator and date don't need document retrieval at all.
// Detect them early via simple regex to skip the expensive LLM call entirely.

function detectDirectTool(question) {
  const q = question.toLowerCase();

  // Calculator: contains digits and math operators
  if (/[\\d]+\\s*[+\\-*\\/^%]\\s*[\\d]/.test(question)) {
    // Extract the expression
    const match = question.match(/([\\d][\\d\\s.+\\-*\\/^%()]+[\\d])/);
    if (match) return { tool: 'calculator', input: match[1].trim() };
  }

  // Date: asks for today/current date
  if (/\\b(today|current date|what.*date|date.*today)\\b/i.test(q)) {
    return { tool: 'date', input: 'today' };
  }

  return null;
}

function executeTool({ tool, input }) {
  if (tool === 'calculator') {
    const { result, error } = calculator.run(input);
    return {
      answer:    error ? \`Calculator error: \${error}\` : \`The result of \${input} is \${result}.\`,
      tool_used: 'calculator',
    };
  }
  if (tool === 'date') {
    const { result, error } = dateTool.run(input);
    return {
      answer:    error ? \`Date tool error: \${error}\` : \`Today's date is \${result}.\`,
      tool_used: 'date',
    };
  }
  return null;
}

// ── Session helpers ───────────────────────────────────────────────────────────

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

function getSessionHistory(sessionId, limit = 3) {
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
    turn_id:   crypto.randomUUID(),
    session_id,
    turn_number,
    question,
    answer,
    sources:   JSON.stringify(sources),
    tool_used: tool_used || null,
    timestamp: new Date().toISOString(),
  });
}

// ── POST /ask ─────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { question, session_id: rawSessionId } = req.body;

  // Validation
  if (!question || typeof question !== 'string')
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'question is required' });
  if (question.trim().length < 3)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'question must be at least 3 characters' });
  if (question.length > 2000)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'question must be max 2000 characters' });

  // Resolve session
  let session_id;
  try {
    session_id = resolveSession(rawSessionId);
  } catch (err) {
    if (err.code === 'SESSION_NOT_FOUND')
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: err.detail });
    throw err;
  }

  try {
    // ── Fast path: detect tool questions without touching LLM or retrieval ──
    const directTool = detectDirectTool(question.trim());
    if (directTool) {
      const toolResult = executeTool(directTool);
      if (toolResult) {
        console.log(\`[ask] direct tool: \${toolResult.tool_used}\`);
        saveTurn({ session_id, question, answer: toolResult.answer, sources: [], tool_used: toolResult.tool_used });
        return res.status(200).json({
          answer:          toolResult.answer,
          sources:         [],
          session_id,
          retrieval_count: 0,
          tool_used:       toolResult.tool_used,
        });
      }
    }

    // ── Retrieval ──
    const queryEmbedding = await embed(question.trim());
    const retrieved      = topK(queryEmbedding); // returns up to 5
    console.log(\`[ask] retrieved \${retrieved.length} chunks\`);

    // ── No context → fallback immediately, no LLM call ──
    if (retrieved.length === 0) {
      saveTurn({ session_id, question, answer: FALLBACK_ANSWER, sources: [], tool_used: null });
      return res.status(200).json({
        answer:          FALLBACK_ANSWER,
        sources:         [],
        session_id,
        retrieval_count: 0,
        tool_used:       null,
      });
    }

    // ── Build compact context — top 2 chunks, truncated to 400 chars each ──
    const llmChunks = retrieved
      .slice(0, MAX_LLM_CHUNKS)
      .map(r => r.content.slice(0, MAX_CHUNK_CHARS));

    const history = getSessionHistory(session_id);

    console.log(\`[ask] sending \${llmChunks.length} chunks to LLM (\${llmChunks.reduce((n,c) => n + c.length, 0)} chars)\`);

    // ── LLM call ──
    const llmAnswer = await chat(question.trim(), llmChunks, history, false);
    console.log(\`[ask] LLM answered: \${llmAnswer.slice(0, 80)}\`);

    const sources = retrieved.map(r => ({
      chunk_id:       r.chunk_id,
      document_id:    r.document_id,
      document_title: r.document_title,
      relevance_score: r.relevance_score,
    }));

    saveTurn({ session_id, question, answer: llmAnswer, sources, tool_used: null });

    return res.status(200).json({
      answer:          llmAnswer,
      sources,
      session_id,
      retrieval_count: retrieved.length,
      tool_used:       null,
    });

  } catch (err) {
    console.error('[ask] error:', err.message);
    res.status(500).json({
      error:      'INTERNAL_ERROR',
      message:    err.message || 'Ask failed',
      request_id: req.requestId,
    });
  }
});

module.exports = router;
`);

console.log('\n══════════════════════════════════════════');
console.log('  DONE. What changed:\n');
console.log('  - Calculator/date detected by regex BEFORE embed/LLM');
console.log('    → no Ollama call needed for tool questions at all');
console.log('  - LLM receives only top 2 chunks (was 5)');
console.log('  - Each chunk truncated to 400 chars (was ~2000)');
console.log('  - Total LLM context: ~800 chars (was ~10,000)');
console.log('  - Session history reduced to last 3 turns (was 5)\n');
console.log('  Steps:');
console.log('  1. npm run dev');
console.log('  2. Wait for: [ollama] all models loaded — server ready');
console.log('  3. node src/scripts/validate.js');
console.log('══════════════════════════════════════════\n');