/**
 * ROUTE: /documents
 *
 * Phase 3+: POST /documents now chunks content and (Phase 4+) generates embeddings.
 * GET /documents returns all documents with chunk_count.
 *
 * Contract V2 Section 4.
 */

const express  = require('express');
const crypto   = require('crypto');
const db       = require('../db');
const { chunkText } = require('../chunker');
const { embed }     = require('../ollama');

// pdf-parse for server-side PDF text extraction
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch { pdfParse = null; }

function isBase64Pdf(str) {
  return typeof str === 'string' && (
    str.startsWith('data:application/pdf;base64,') ||
    str.startsWith('data:application/octet-stream;base64,')
  );
}

async function extractPdfFromBase64(base64str) {
  if (!pdfParse) throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
  const base64 = base64str.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  const result = await pdfParse(buffer);
  const text   = (result.text || '').trim();
  if (!text) throw new Error('PDF has no extractable text — may be a scanned image');
  return text;
}

const router = express.Router();

// ─── GET /documents ───────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const docs = db.prepare(`
      SELECT
        d.document_id,
        d.title,
        d.created_at,
        COUNT(c.chunk_id) AS chunk_count
      FROM documents d
      LEFT JOIN chunks c ON d.document_id = c.document_id
      GROUP BY d.document_id
      ORDER BY d.created_at DESC
    `).all();

    res.status(200).json(docs.map(d => ({
      document_id: d.document_id,
      title:       d.title,
      chunk_count: Number(d.chunk_count),
      created_at:  d.created_at,
    })));
  } catch (err) {
    req.log.error({ err }, 'GET /documents failed');
    res.status(500).json({
      error:      'INTERNAL_ERROR',
      message:    'Failed to retrieve documents',
      request_id: req.requestId,
    });
  }
});

// ─── POST /documents ──────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { title, content } = req.body;

  // ── Validation ──
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({
      error:   'VALIDATION_ERROR',
      message: 'title is required and must be a non-empty string',
      field:   'title',
    });
  }
  if (title.length > 255) {
    return res.status(400).json({
      error:   'VALIDATION_ERROR',
      message: 'title must be max 255 characters',
      field:   'title',
    });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({
      error:   'VALIDATION_ERROR',
      message: 'content is required',
      field:   'content',
    });
  }
  if (!content || content.trim().length < 5) {
    return res.status(400).json({
      error:   'VALIDATION_ERROR',
      message: 'content must be at least 10 characters',
      field:   'content',
    });
  }
  if (content.length > 500000) {
    return res.status(400).json({
      error:   'VALIDATION_ERROR',
      message: 'content must be max 500,000 characters',
      field:   'content',
    });
  }

  const document_id = crypto.randomUUID();
  const created_at  = new Date().toISOString();

  try {
    // ── 1. Chunk the content ──
    const chunks = chunkText(content, document_id);

    // ── 2. Generate embeddings for each chunk ──
    //    embed() calls Ollama; run sequentially to avoid overwhelming it
    const chunksWithEmbeddings = [];
    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
      chunksWithEmbeddings.push({ ...chunk, embedding: JSON.stringify(embedding) });
    }

    // ── 3. Persist everything in a single transaction ──
    const insertAll = db.transaction(() => {
      db.prepare(`
        INSERT INTO documents (document_id, title, created_at)
        VALUES (@document_id, @title, @created_at)
      `).run({ document_id, title: title.trim(), created_at });

      const insertChunk = db.prepare(`
        INSERT INTO chunks
          (chunk_id, document_id, chunk_index, content, char_start, char_end, embedding)
        VALUES
          (@chunk_id, @document_id, @chunk_index, @content, @char_start, @char_end, @embedding)
      `);

      for (const c of chunksWithEmbeddings) {
        insertChunk.run(c);
      }
    });

    insertAll();

    // ── 4. Respond ──
    res.status(201).json({
      document_id,
      title:          title.trim(),
      chunks_indexed: chunksWithEmbeddings.length,
      created_at,
    });

  } catch (err) {
    req.log.error({ err }, 'POST /documents failed');
    res.status(500).json({
      error:      'INTERNAL_ERROR',
      message:    err.message || 'Failed to store document',
      request_id: req.requestId,
    });
  }
});

module.exports = router;