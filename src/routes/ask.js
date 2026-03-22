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
  if (/[\d]+\s*[+\-*\/^%]\s*[\d]/.test(question)) {
    const match = question.match(/([\d][\d\s.+\-*\/^%()]+[\d])/);
    if (match) return { tool: 'calculator', input: match[1].trim() };
  }
  if (/\b(today|current date|what.*date|date.*today)\b/i.test(q)) {
    return { tool: 'date', input: 'today' };
  }
  return null;
}

function executeTool({ tool, input }) {
  if (tool === 'calculator') {
    const { result, error } = calculator.run(input);
    return { answer: error ? `Calculator error: ${error}` : `The result of ${input} is ${result}.`, tool_used: 'calculator' };
  }
  if (tool === 'date') {
    const { result, error } = dateTool.run(input);
    return { answer: error ? `Date tool error: ${error}` : `Today's date is ${result}.`, tool_used: 'date' };
  }
  return null;
}

function resolveSession(sessionId) {
  if (sessionId) {
    const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId);
    if (!existing) {
      const err = new Error('SESSION_NOT_FOUND');
      err.status = 404; err.code = 'SESSION_NOT_FOUND';
      err.detail = `No session found with id: ${sessionId}`;
      throw err;
    }
    return sessionId;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (session_id, created_at) VALUES (?, ?)').run(id, new Date().toISOString());
  return id;
}

function getSessionHistory(sessionId, limit = 2) {
  return db.prepare(`
    SELECT question, answer FROM session_turns
    WHERE session_id = ? ORDER BY turn_number DESC LIMIT ?
  `).all(sessionId, limit).reverse();
}

function saveTurn({ session_id, question, answer, sources, tool_used }) {
  const maxTurn = db.prepare('SELECT MAX(turn_number) AS m FROM session_turns WHERE session_id = ?').get(session_id);
  const turn_number = (maxTurn?.m ?? 0) + 1;
  db.prepare(`
    INSERT INTO session_turns (turn_id, session_id, turn_number, question, answer, sources, tool_used, timestamp)
    VALUES (@turn_id, @session_id, @turn_number, @question, @answer, @sources, @tool_used, @timestamp)
  `).run({
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
    console.log(`[ask] retrieved ${retrieved.length} chunks for: "${question.slice(0,50)}"`);

    if (retrieved.length === 0) {
      saveTurn({ session_id, question, answer: FALLBACK_ANSWER, sources: [], tool_used: null });
      return res.status(200).json({
        answer: FALLBACK_ANSWER, sources: [], session_id, retrieval_count: 0, tool_used: null,
      });
    }

    // Build compact context
    const llmChunks   = retrieved.slice(0, MAX_LLM_CHUNKS).map(r => r.content.slice(0, MAX_CHUNK_CHARS));
    const contextText = llmChunks.map((c, i) => `[Doc ${i+1}]: ${c}`).join('\n');
    const history     = getSessionHistory(session_id);
    const historyBlock = history.length > 0
      ? history.map(t => `Q: ${t.question}\nA: ${t.answer}`).join('\n') + '\n\n'
      : '';

    const prompt = `${historyBlock}${contextText}\n\nQuestion: ${question.trim()}`;

    console.log(`[ask] prompt length: ${prompt.length} chars → LLM`);

    const llmAnswer = await chat(prompt);
    console.log(`[ask] answer: "${llmAnswer.slice(0,80)}"`);

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
