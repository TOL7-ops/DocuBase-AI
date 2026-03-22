#!/usr/bin/env node
/**
 * CLEANUP + FIX
 *
 * 1. Removes duplicate documents (keeps newest of each title)
 * 2. Lowers MIN_SCORE threshold to 0.35
 * 3. Fixes retriever.js if fix-retrieval.js was not applied
 *
 * Run: node src/scripts/cleanup.js
 * Then restart: npm run dev
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const SRC  = path.resolve(__dirname, '..');

console.log('\n══════════════════════════════════════════════');
console.log('  CLEANUP — Remove duplicates + fix threshold');
console.log('══════════════════════════════════════════════\n');

// ── 1. Fix retriever threshold ────────────────────────────────────────────────
const retrieverPath = path.join(SRC, 'retriever.js');
let retriever = fs.readFileSync(retrieverPath, 'utf8');

if (retriever.includes('0.50')) {
  retriever = retriever.replace('const MIN_SCORE = 0.50', 'const MIN_SCORE = 0.35');
  fs.writeFileSync(retrieverPath, retriever);
  console.log('  ✅  Fixed MIN_SCORE: 0.50 → 0.35 in retriever.js');
} else if (retriever.includes('0.35')) {
  console.log('  ✓   MIN_SCORE already 0.35 in retriever.js');
} else {
  console.log('  ⚠️   Could not find MIN_SCORE in retriever.js — check manually');
}

// ── 2. Fix ask.js prompt (apply fix-retrieval changes if not done) ────────────
const askPath = path.join(SRC, 'routes/ask.js');
const askContent = fs.readFileSync(askPath, 'utf8');

if (!askContent.includes('You may summarize')) {
  console.log('\n  Applying improved LLM prompt to ask.js...');
  // Patch just the prompt section
  const oldPrompt = `const prompt = \`\${historyBlock}Context:\\n\${contextBlock}\\n\\nQuestion: \${question.trim()}\``;
  const newPrompt = `const prompt = \`\${historyBlock}Here is content from the user's uploaded documents:\\n\\n\${contextBlock}\\n\\nUser request: \${question.trim()}\\n\\nInstructions: Use the document excerpts above to respond. You may summarize, generate questions, explain, or answer directly. If the excerpts contain no relevant information, say: "The answer is not found in the uploaded documents."\``;

  if (askContent.includes('const prompt = `${historyBlock}Context:')) {
    fs.writeFileSync(askPath, askContent.replace(
      `const prompt = \`\${historyBlock}Context:\\n\${contextBlock}\\n\\nQuestion: \${question.trim()}\``,
      newPrompt
    ));
    console.log('  ✅  Updated LLM prompt in ask.js');
  } else {
    console.log('  ⚠️   ask.js prompt format not recognized — run fix-retrieval.js separately');
  }
} else {
  console.log('  ✓   ask.js already has improved prompt');
}

// ── 3. Remove duplicate documents from DB ────────────────────────────────────
console.log('\n── REMOVING DUPLICATE DOCUMENTS ────────────');

const db = require(path.join(SRC, 'db'));

// Find all documents grouped by title
const all = db.prepare(`
  SELECT document_id, title, created_at FROM documents ORDER BY title, created_at DESC
`).all();

// Group by title
const byTitle = {};
for (const doc of all) {
  if (!byTitle[doc.title]) byTitle[doc.title] = [];
  byTitle[doc.title].push(doc);
}

let removed = 0;
const toDelete = [];

for (const [title, docs] of Object.entries(byTitle)) {
  if (docs.length > 1) {
    // Keep the first (most recent), delete the rest
    const keep    = docs[0];
    const deletes = docs.slice(1);
    console.log(`  "${title.slice(0,40)}" — keeping newest (${keep.created_at.slice(0,10)}), removing ${deletes.length} duplicate(s)`);
    deletes.forEach(d => toDelete.push(d.document_id));
    removed += deletes.length;
  }
}

if (toDelete.length > 0) {
  // Delete chunks first (FK), then documents
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE document_id = ?');
  const deleteDocs   = db.prepare('DELETE FROM documents WHERE document_id = ?');

  const deleteAll = db.transaction(() => {
    for (const id of toDelete) {
      const chunkResult = deleteChunks.run(id);
      deleteDocs.run(id);
    }
  });

  deleteAll();
  console.log(`\n  ✅  Removed ${removed} duplicate documents`);
} else {
  console.log('  ✓   No duplicates found');
}

// ── 4. Show final state ────────────────────────────────────────────────────────
const finalDocs   = db.prepare('SELECT title, created_at FROM documents ORDER BY created_at DESC').all();
const finalChunks = db.prepare('SELECT COUNT(*) as n FROM chunks').get();

console.log('\n── FINAL DATABASE STATE ─────────────────────');
console.log(`  Documents: ${finalDocs.length}`);
finalDocs.forEach(d => console.log(`    • ${d.title.slice(0,50)}`));
console.log(`  Chunks: ${finalChunks.n}`);

console.log('\n══════════════════════════════════════════════');
console.log('  DONE. Next steps:\n');
console.log('  1. Restart server:  npm run dev');
console.log('  2. Wait for:        [ollama] all models loaded — server ready');
console.log('  3. Test in chat:    "Summarize this document"');
console.log('  4. For the CV:      Re-upload Spencer-FullStack-DevOps-CV.txt');
console.log('     (PDF text extraction needs pdfjs-dist — use .txt copy for now)');
console.log('══════════════════════════════════════════════\n');