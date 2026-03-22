#!/usr/bin/env node
/**
 * DEEP DIAGNOSTIC
 * Tests each layer independently to find exactly where answers break down.
 *
 * node src/scripts/deep-diag.js
 */

require('dotenv').config();
const path = require('path');
const SRC  = path.resolve(__dirname, '..');

console.log('\n══════════════════════════════════════════════');
console.log('  DEEP DIAGNOSTIC — LLM · Retrieval · Pipeline');
console.log('══════════════════════════════════════════════\n');

async function run() {
  const db         = require(path.join(SRC, 'db'));
  const { embed }  = require(path.join(SRC, 'ollama'));
  const { topK, cosineSimilarity } = require(path.join(SRC, 'retriever'));

  // ── 1. What's in the database? ─────────────────────────────────────────────
  console.log('── 1. DATABASE STATE ───────────────────────');
  const docs   = db.prepare('SELECT document_id, title FROM documents').all();
  const chunks = db.prepare('SELECT chunk_id, document_id, length(content) as clen, length(embedding) as elen FROM chunks').all();
  console.log(`  Documents: ${docs.length}`);
  docs.forEach(d => console.log(`    • ${d.title} (${d.document_id.slice(0,8)})`));
  console.log(`  Chunks:    ${chunks.length}`);
  const withEmbeddings = chunks.filter(c => c.elen > 10);
  const noEmbeddings   = chunks.filter(c => c.elen <= 10);
  console.log(`  With embeddings: ${withEmbeddings.length}`);
  console.log(`  Without embeddings: ${noEmbeddings.length}`);
  if (noEmbeddings.length > 0) {
    console.log('  ⚠️  Some chunks have no embeddings — documents uploaded before Phase 4 was applied');
    console.log('     Fix: Re-upload those documents');
  }

  // Show first chunk content for each doc
  console.log('\n  Chunk previews:');
  const previews = db.prepare(`
    SELECT c.chunk_id, d.title, c.content, length(c.embedding) as elen
    FROM chunks c JOIN documents d ON d.document_id = c.document_id
    ORDER BY c.chunk_index ASC LIMIT 5
  `).all();
  previews.forEach(p => {
    console.log(`    [${p.title.slice(0,30)}] embedding=${p.elen > 10 ? '✓' : '✗'} content="${p.content.slice(0,80)}..."`);
  });

  // ── 2. Test embedding generation ──────────────────────────────────────────
  console.log('\n── 2. EMBEDDING TEST ───────────────────────');
  let queryVec;
  try {
    queryVec = await embed('what is the content of this document');
    console.log(`  ✅  embed() works — vector length: ${queryVec.length}`);
    console.log(`  Sample values: [${queryVec.slice(0,4).map(v => v.toFixed(4)).join(', ')}...]`);
  } catch (err) {
    console.log(`  ❌  embed() failed: ${err.message}`);
    return;
  }

  // ── 3. Raw cosine scores against ALL chunks ────────────────────────────────
  console.log('\n── 3. RAW SIMILARITY SCORES ────────────────');
  console.log('  Query: "what is the content of this document"\n');

  const allChunks = db.prepare(`
    SELECT c.chunk_id, d.title, c.content, c.embedding
    FROM chunks c JOIN documents d ON d.document_id = c.document_id
    WHERE c.embedding IS NOT NULL AND length(c.embedding) > 10
  `).all();

  if (allChunks.length === 0) {
    console.log('  ❌  No chunks with embeddings found!');
    console.log('  Fix: Re-upload your documents (they were uploaded before embeddings were working)');
    return;
  }

  const scored = allChunks.map(row => {
    let vec;
    try { vec = JSON.parse(row.embedding); } catch { return null; }
    if (!Array.isArray(vec) || vec.length === 0) return null;
    const score = cosineSimilarity(queryVec, vec);
    return { title: row.title, score, content: row.content.slice(0, 60) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  console.log(`  Total scored chunks: ${scored.length}`);
  console.log('  Top 5 scores:');
  scored.slice(0, 5).forEach((s, i) => {
    const bar = '█'.repeat(Math.round(s.score * 20));
    console.log(`    ${i+1}. score=${s.score.toFixed(4)} ${bar}`);
    console.log(`       [${s.title.slice(0,30)}] "${s.content}..."`);
  });

  const threshold050 = scored.filter(s => s.score >= 0.50).length;
  const threshold035 = scored.filter(s => s.score >= 0.35).length;
  const threshold020 = scored.filter(s => s.score >= 0.20).length;
  console.log(`\n  Chunks passing threshold 0.50: ${threshold050}`);
  console.log(`  Chunks passing threshold 0.35: ${threshold035}`);
  console.log(`  Chunks passing threshold 0.20: ${threshold020}`);

  if (threshold035 === 0) {
    console.log('\n  ⚠️  No chunks pass even 0.35 threshold!');
    console.log('  This means either:');
    console.log('    a) Documents were re-uploaded but embeddings were not regenerated');
    console.log('    b) The embedding model changed between upload and query');
    console.log('    c) The documents are too short/generic to match broad queries');
  }

  // ── 4. Test topK directly ──────────────────────────────────────────────────
  console.log('\n── 4. topK() FUNCTION TEST ─────────────────');
  const queries = [
    'what is the content of this document',
    'dream meeting celebrity',
    'summarize',
    'tell me about this file',
  ];

  for (const q of queries) {
    const qvec   = await embed(q);
    const result = topK(qvec);
    console.log(`  Query: "${q}"`);
    console.log(`  → retrieved: ${result.length} chunks${result.length > 0 ? `, top score: ${result[0].relevance_score}` : ' (NONE — below threshold)'}`);
  }

  // ── 5. Direct LLM test with actual content ─────────────────────────────────
  console.log('\n── 5. DIRECT LLM TEST ──────────────────────');
  const { chat } = require(path.join(SRC, 'ollama'));

  if (allChunks.length > 0) {
    const testChunk = allChunks[0].content.slice(0, 400);
    const testTitle = allChunks[0].title;
    console.log(`  Using chunk from: "${testTitle}"`);
    console.log(`  Chunk preview: "${testChunk.slice(0,80)}..."`);
    console.log('  Asking LLM: "Summarize this content in one sentence"');
    console.log('  Waiting...');

    try {
      // Build the same prompt format that ask.js uses
      const prompt = `Here is the content from the user's uploaded documents:

[Excerpt 1]
${testChunk}

User request: Summarize this content in one sentence

Instructions: Use the document excerpts above to respond. You may summarize, generate questions, explain, or answer directly — but base everything on the provided excerpts. If the excerpts contain no relevant information, say: "The answer is not found in the uploaded documents."`;

      const answer = await chat(prompt);
      console.log(`\n  LLM ANSWER: "${answer}"`);

      if (answer.includes('not found')) {
        console.log('\n  ⚠️  LLM returned fallback even with content!');
        console.log('  This means the chat() function in ollama.js still has the old strict system prompt.');
        console.log('  Run: node src/scripts/fix-retrieval.js   then restart server');
      } else {
        console.log('\n  ✅  LLM correctly uses the provided context!');
      }
    } catch (err) {
      console.log(`  ❌  LLM error: ${err.message}`);
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  SUMMARY — look for ❌ and ⚠️  above');
  console.log('══════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('Diagnostic failed:', err.message);
  console.error(err.stack);
});