#!/usr/bin/env node
/**
 * RE-EMBED ALL DOCUMENTS
 *
 * Clears all stored embeddings (old nomic-embed-text 768-dim vectors)
 * and regenerates them using sentence-transformers/all-MiniLM-L6-v2 (384 dims)
 * via the HuggingFace Inference API.
 *
 * Run AFTER migrate-to-hf.js and after setting HF_API_KEY in .env
 *
 * node src/scripts/re-embed.js
 */

require('dotenv').config();

const path = require('path');
const SRC  = path.resolve(__dirname, '..');

async function run() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  RE-EMBED — HuggingFace all-MiniLM-L6-v2');
  console.log('══════════════════════════════════════════════\n');

  if (!process.env.HF_API_KEY || process.env.HF_API_KEY === 'your_key_here') {
    console.error('  ❌  HF_API_KEY not set in .env');
    console.error('  Add: HF_API_KEY=hf_xxxxxxxxxxxxxxxxxxxx');
    process.exit(1);
  }

  const db           = require(path.join(SRC, 'db'));
  const { embed }    = require(path.join(SRC, 'ollama')); // now points to HF client

  // Get all chunks
  const chunks = db.prepare(`
    SELECT chunk_id, content, document_id FROM chunks ORDER BY document_id, chunk_id
  `).all();

  console.log(`  Found ${chunks.length} chunks to re-embed\n`);

  if (chunks.length === 0) {
    console.log('  No chunks found. Upload documents first, then run this script.');
    return;
  }

  // Clear all existing embeddings first
  db.prepare("UPDATE chunks SET embedding = '' WHERE 1=1").run();
  console.log('  Cleared old embeddings\n');

  const updateStmt = db.prepare('UPDATE chunks SET embedding = ? WHERE chunk_id = ?');

  let done = 0, failed = 0;

  for (const chunk of chunks) {
    process.stdout.write(`  [${done + failed + 1}/${chunks.length}] ${chunk.chunk_id.slice(0,8)}… `);

    try {
      const vector     = await embed(chunk.content);
      const serialized = JSON.stringify(vector);
      updateStmt.run(serialized, chunk.chunk_id);
      done++;
      console.log(`✓  (${vector.length} dims)`);
    } catch (err) {
      failed++;
      console.log(`✗  ${err.message}`);

      // If model is loading, wait and retry once
      if (err.message.includes('loading') || err.message.includes('503')) {
        console.log('  Model loading — waiting 25 seconds then retrying…');
        await new Promise(r => setTimeout(r, 25000));
        try {
          const vector     = await embed(chunk.content);
          updateStmt.run(JSON.stringify(vector), chunk.chunk_id);
          done++; failed--;
          console.log(`  Retry ✓ (${vector.length} dims)`);
        } catch (err2) {
          console.log(`  Retry ✗ ${err2.message}`);
        }
      }
    }

    // Small delay between requests to avoid HF rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`  Done: ${done} embedded, ${failed} failed`);

  if (failed > 0) {
    console.log('  Re-run this script to retry failed chunks.');
  } else {
    console.log('\n  ✅  All chunks re-embedded with 384-dim vectors');
    console.log('  You can now start the server: npm run dev');
  }

  // Verify
  const withEmbeddings = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE length(embedding) > 10").get();
  const total          = db.prepare("SELECT COUNT(*) as n FROM chunks").get();
  console.log(`\n  Verification: ${withEmbeddings.n}/${total.n} chunks have embeddings`);

  console.log('══════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('\nRe-embed failed:', err.message);
  process.exit(1);
});