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
