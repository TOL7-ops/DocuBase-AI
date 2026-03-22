const db = require('./db');

const TOP_K     = 5;
const MIN_SCORE = 0.35;
// Embedding dims: 384 (sentence-transformers/all-MiniLM-L6-v2)

function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
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
  const rows = db.prepare(`
    SELECT c.chunk_id, c.document_id, c.content, c.embedding, d.title AS document_title
    FROM chunks c
    JOIN documents d ON d.document_id = c.document_id
    WHERE c.embedding IS NOT NULL AND length(c.embedding) > 10
  `).all();

  if (rows.length === 0) return [];

  const scored = [];
  for (const row of rows) {
    let vec;
    try { vec = JSON.parse(row.embedding); } catch { continue; }
    if (!Array.isArray(vec) || vec.length === 0) continue;

    // Skip old 768-dim embeddings (from nomic-embed-text) — incompatible
    if (vec.length !== queryEmbedding.length) {
      continue; // will be cleared by re-embed script
    }

    const score = cosineSimilarity(queryEmbedding, vec);
    if (score >= threshold) {
      scored.push({
        chunk_id:        row.chunk_id,
        document_id:     row.document_id,
        document_title:  row.document_title,
        content:         row.content,
        relevance_score: Math.round(score * 10000) / 10000,
      });
    }
  }

  return scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, k);
}

module.exports = { cosineSimilarity, topK };
