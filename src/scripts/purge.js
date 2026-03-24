#!/usr/bin/env node
/**
 * LIVE ASK DIAGNOSTIC
 * Tests every step of the /ask pipeline against your real database.
 * node src/scripts/diag-ask.js
 */

require('dotenv').config();
const path = require('path');
const SRC  = path.resolve(__dirname, '..');

async function run() {
  const db            = require(path.join(SRC, 'db'));
  const { embed }     = require(path.join(SRC, 'ollama'));
  const { topK, cosineSimilarity } = require(path.join(SRC, 'retriever'));

  console.log('\n══════════════════════════════════════════════');
  console.log('  LIVE ASK DIAGNOSTIC');
  console.log('══════════════════════════════════════════════\n');

  // ── 1. What's in the DB ───────────────────────────────────────────────────
  console.log('── 1. DATABASE ─────────────────────────────');
  const docs   = db.prepare('SELECT document_id, title FROM documents').all();
  const chunks = db.prepare(`
    SELECT chunk_id, document_id, length(content) as clen,
           length(embedding) as elen, substr(content, 1, 80) as preview
    FROM chunks
  `).all();

  console.log(`  Documents: ${docs.length}`);
  docs.forEach(d => console.log(`    • [${d.document_id.slice(0,8)}] "${d.title}"`));
  console.log(`\n  Chunks: ${chunks.length}`);
  chunks.forEach(c => {
    const hasEmbed = c.elen > 10;
    console.log(`    chunk ${c.chunk_id.slice(0,8)} | content: ${c.clen} chars | embed: ${hasEmbed ? '✓' : '✗ MISSING'}`);
    console.log(`      preview: "${c.preview.replace(/\n/g,' ')}"`);
  });

  if (chunks.length === 0) {
    console.log('\n  ❌ No chunks in database — upload a document first');
    return;
  }

  const missingEmbeds = chunks.filter(c => c.elen <= 10);
  if (missingEmbeds.length > 0) {
    console.log(`\n  ⚠️  ${missingEmbeds.length} chunks have NO embeddings!`);
    console.log('  Fix: run node src/scripts/re-embed.js');
  }

  // ── 2. Embed a test query ─────────────────────────────────────────────────
  console.log('\n── 2. EMBEDDING TEST ───────────────────────');
  const testQuery = docs[0]?.title
    ? `Tell me about ${docs[0].title}`
    : 'summarize this document';

  console.log(`  Query: "${testQuery}"`);
  let queryVec;
  try {
    queryVec = await embed(testQuery);
    console.log(`  ✅ embed() OK — ${queryVec.length} dims`);
  } catch (err) {
    console.log(`  ❌ embed() FAILED: ${err.message}`);
    return;
  }

  // ── 3. Raw similarity scores ──────────────────────────────────────────────
  console.log('\n── 3. RAW COSINE SCORES ────────────────────');
  const allChunks = db.prepare(`
    SELECT c.chunk_id, c.content, c.embedding, d.title
    FROM chunks c JOIN documents d ON d.document_id = c.document_id
    WHERE length(c.embedding) > 10
  `).all();

  console.log(`  Scoring ${allChunks.length} chunks with embeddings...\n`);

  const scored = [];
  for (const row of allChunks) {
    let vec;
    try { vec = JSON.parse(row.embedding); } catch { continue; }
    if (!Array.isArray(vec) || vec.length === 0) continue;

    if (vec.length !== queryVec.length) {
      console.log(`  ⚠️  Dimension mismatch: chunk has ${vec.length} dims, query has ${queryVec.length} dims`);
      console.log('  This means embeddings were generated with a DIFFERENT model.');
      console.log('  Fix: run node src/scripts/re-embed.js');
      continue;
    }

    const score = cosineSimilarity(queryVec, vec);
    scored.push({ title: row.title, score, preview: row.content.slice(0, 60) });
  }

  if (scored.length === 0) {
    console.log('  ❌ No chunks could be scored — all have wrong dimensions');
    return;
  }

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => {
    const bar = '█'.repeat(Math.max(0, Math.round(s.score * 20)));
    console.log(`  ${i+1}. score=${s.score.toFixed(4)} ${bar}`);
    console.log(`     [${s.title}] "${s.preview}"`);
  });

  const maxScore = scored[0]?.score || 0;
  console.log(`\n  Max score: ${maxScore.toFixed(4)}`);
  console.log(`  Chunks above 0.35: ${scored.filter(s => s.score >= 0.35).length}`);
  console.log(`  Chunks above 0.20: ${scored.filter(s => s.score >= 0.20).length}`);

  if (maxScore < 0.35) {
    console.log('\n  ⚠️  NO chunks pass the 0.35 threshold!');
    if (maxScore > 0.20) {
      console.log('  Lowering MIN_SCORE to 0.20 in retriever.js...');
      const fs  = require('fs');
      const ret = fs.readFileSync(path.join(SRC, 'retriever.js'), 'utf8');
      fs.writeFileSync(path.join(SRC, 'retriever.js'), ret.replace(
        /const MIN_SCORE\s*=\s*[0-9.]+/,
        'const MIN_SCORE = 0.20'
      ));
      console.log('  ✅ MIN_SCORE set to 0.20 — restart server');
    } else {
      console.log('  ❌ Even 0.20 threshold fails — embedding model mismatch likely');
      console.log('  Fix: node src/scripts/re-embed.js');
    }
  }

  // ── 4. topK() test ────────────────────────────────────────────────────────
  console.log('\n── 4. topK() TEST ──────────────────────────');
  const results = topK(queryVec);
  console.log(`  Retrieved: ${results.length} chunks`);
  results.forEach(r => console.log(`    score=${r.relevance_score} "${r.document_title}" `));

  if (results.length === 0) {
    console.log('  ❌ topK returned 0 — threshold too high or dimension mismatch');
  }

  // ── 5. LLM test ───────────────────────────────────────────────────────────
  if (results.length > 0) {
    console.log('\n── 5. LLM TEST ─────────────────────────────');
    const { chat } = require(path.join(SRC, 'ollama'));
    const context  = results[0].content.slice(0, 300);
    const prompt   = `Context:\n${context}\n\nQuestion: ${testQuery}`;
    console.log(`  Prompt length: ${prompt.length} chars`);
    console.log('  Calling LLM...');
    try {
      const answer = await chat(prompt);
      console.log(`  ✅ LLM answered: "${answer.slice(0, 150)}"`);
    } catch (err) {
      console.log(`  ❌ LLM FAILED: ${err.message}`);
    }
  }

  console.log('\n══════════════════════════════════════════════\n');
}

run().catch(err => { console.error('Diagnostic failed:', err.message); });