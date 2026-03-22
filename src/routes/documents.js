const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { chunkText }          = require('../chunker');
const { extractPdfText, isBase64Pdf } = require('../pdfExtract');
const { embed }     = require('../ollama');

const router = express.Router();

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
    // 1. Handle PDF base64 content sent from older frontend paths
    let processedContent = content;
    if (isBase64Pdf(content)) {
      try {
        console.log('[documents] Detected base64 PDF — extracting text server-side');
        processedContent = await extractPdfText(content);
        console.log(`[documents] PDF text extracted: ${processedContent.length} chars`);
      } catch (err) {
        return res.status(400).json({
          error:   'PDF_EXTRACTION_FAILED',
          message: err.message,
          field:   'content',
        });
      }
    }

    // 1. Chunk
    const chunks = chunkText(processedContent, document_id);
    console.log(`[documents] chunked into ${chunks.length} chunks`);

    // 2. Embed each chunk sequentially
    const chunksWithEmbeddings = [];
    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
      chunksWithEmbeddings.push({ ...chunk, embedding: JSON.stringify(embedding) });
    }
    console.log(`[documents] embedded ${chunksWithEmbeddings.length} chunks`);

    // 3. Persist in transaction
    db.transaction(() => {
      db.prepare('INSERT INTO documents (document_id, title, created_at) VALUES (@document_id, @title, @created_at)')
        .run({ document_id, title: title.trim(), created_at });

      const insertChunk = db.prepare(`
        INSERT INTO chunks (chunk_id, document_id, chunk_index, content, char_start, char_end, embedding)
        VALUES (@chunk_id, @document_id, @chunk_index, @content, @char_start, @char_end, @embedding)
      `);
      for (const c of chunksWithEmbeddings) insertChunk.run(c);
    })();

    res.status(201).json({ document_id, title: title.trim(), chunks_indexed: chunksWithEmbeddings.length, created_at });

  } catch (err) {
    console.error('[documents] POST error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message || 'Failed to store document', request_id: req.requestId });
  }
});

module.exports = router;
