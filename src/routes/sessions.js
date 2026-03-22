/**
 * ROUTE: GET /sessions/:id
 *
 * Returns full conversation history for a session.
 * Contract V2 Section 4.
 */

const express = require('express');
const db      = require('../db');

const router = express.Router();

router.get('/:id', (req, res) => {
  const { id } = req.params;

  const session = db.prepare(
    'SELECT session_id, created_at FROM sessions WHERE session_id = ?'
  ).get(id);

  if (!session) {
    return res.status(404).json({
      error:   'SESSION_NOT_FOUND',
      message: `No session found with id: ${id}`,
    });
  }

  const turns = db.prepare(`
    SELECT
      turn_number,
      question,
      answer,
      sources,
      tool_used,
      timestamp
    FROM session_turns
    WHERE session_id = ?
    ORDER BY turn_number ASC
  `).all(id);

  const history = turns.map(t => ({
    turn:      t.turn_number,
    question:  t.question,
    answer:    t.answer,
    sources:   JSON.parse(t.sources || '[]'),
    tool_used: t.tool_used || null,
    timestamp: t.timestamp,
  }));

  res.status(200).json({
    session_id:  session.session_id,
    created_at:  session.created_at,
    history,
  });
});

module.exports = router;