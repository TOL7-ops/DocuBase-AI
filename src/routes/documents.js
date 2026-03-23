const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { chunkText } = require('../chunker');
const { embed }     = require('../ollama');

const router = express.Router();

// ── PDF extraction ────────────────────────────────────────────────────────────

let pdfParse;
try { pdfParse = require('pdf-parse'); } catch { pdfParse = null; }

function isBase64Pdf(str) {
  return typeof str === 'string' && (
    str.startsWith('data:application/pdf;base64,') ||
    str.startsWith('data:application/octet-stream;base64,') ||
    str.startsWith('data:;base64,')
  );
}

async function extractPdfText(base64str) {
  if (!pdfParse) throw new Error('pdf-parse not installed — run: npm install pdf-parse');
  const base64 = base64str.replace(/^data:[^;]*;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  const result = await pdfParse(buffer);
  const text   = (result.text || '').trim();
  if (!text) throw new Error('PDF has no extractable text — may be a scanned image');
  return text;
}

// ── GET /documents ────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const docs = db.prepare(`
      SELECT d.document_id, d.title, d.created_at, COUNT(c.chunk_id) AS chunk_count
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
    console.error('GET /documents error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve documents' });
  }
});

// ── POST /documents ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { title, content } = req.body;

  // Validate title
  if (!title || typeof title !== 'string' || title.trim().length === 0)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title is required', field: 'title' });
  if (title.length > 255)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title must be max 255 chars', field: 'title' });

  // Validate content
  if (!content || typeof content !== 'string')
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'content is required', field: 'content' });

  // Extract PDF text if base64
  let processedContent = content;
  if (isBase64Pdf(content)) {
    console.log(`[documents] Base64 PDF detected — extracting text server-side`);
    try {
      processedContent = await extractPdfText(content);
      console.log(`[documents] PDF extracted: ${processedContent.length} chars`);
    } catch (err) {
      console.error('[documents] PDF extraction failed:', err.message);
      return res.status(400).json({ error: 'PDF_EXTRACTION_FAILED', message: err.message, field: 'content' });
    }
  }

  // Validate processed content
  if (processedContent.trim().length < 10)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Document content is too short or empty', field: 'content' });

  // Truncate very large docs to 2MB
  if (processedContent.length > 2000000) {
    processedContent = processedContent.slice(0, 2000000);
    console.log('[documents] Content truncated to 2MB');
  }

  const document_id = crypto.randomUUID();
  const created_at  = new Date().toISOString();

  try {
    // Chunk
    const chunks = chunkText(processedContent, document_id);
    console.log(`[documents] "${title.trim()}" → ${chunks.length} chunks`);

    if (chunks.length === 0)
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Document too short to chunk', field: 'content' });

    // Embed
    const chunksWithEmbeddings = [];
    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
      chunksWithEmbeddings.push({ ...chunk, embedding: JSON.stringify(embedding) });
    }

    // Persist
    db.transaction(() => {
      db.prepare('INSERT INTO documents (document_id, title, created_at) VALUES (@document_id, @title, @created_at)')
        .run({ document_id, title: title.trim(), created_at });

      const ins = db.prepare(`
        INSERT INTO chunks (chunk_id, document_id, chunk_index, content, char_start, char_end, embedding)
        VALUES (@chunk_id, @document_id, @chunk_index, @content, @char_start, @char_end, @embedding)
      `);
      for (const c of chunksWithEmbeddings) ins.run(c);
    })();

    res.status(201).json({ document_id, title: title.trim(), chunks_indexed: chunksWithEmbeddings.length, created_at });

  } catch (err) {
    console.error('[documents] POST error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message || 'Failed to store document', request_id: req.requestId });
  }
});

module.exports = router;