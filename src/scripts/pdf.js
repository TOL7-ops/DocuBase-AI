#!/usr/bin/env node
/**
 * ADD BACKEND PDF EXTRACTION
 *
 * Installs pdf-parse and patches routes/documents.js to detect
 * and extract text from PDFs that arrive as raw binary (multipart)
 * or base64 data URLs (fallback from older upload paths).
 *
 * Run: node src/scripts/add-pdf-extraction.js
 * Then: npm install pdf-parse
 * Then: npm run dev
 */

const fs   = require('fs');
const path = require('path');
const SRC  = path.resolve(__dirname, '..');

function write(relPath, content) {
  const full = path.join(SRC, relPath);
  fs.writeFileSync(full, content.trimStart(), 'utf8');
  console.log(`  ✅  Wrote src/${relPath}  (${fs.statSync(full).size} bytes)`);
}

console.log('\n══════════════════════════════════════════════');
console.log('  ADD BACKEND PDF EXTRACTION');
console.log('══════════════════════════════════════════════\n');

// ── pdf utility module ────────────────────────────────────────────────────────
write('pdfExtract.js', `
/**
 * pdfExtract.js — extract plain text from PDF buffers
 *
 * Uses pdf-parse (install: npm install pdf-parse)
 * Falls back gracefully if the package isn't installed.
 */

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null;
}

/**
 * Detect if a string is a base64 data URL for a PDF.
 * Frontend sends PDFs as: "data:application/pdf;base64,JVBERi0x..."
 */
function isBase64Pdf(str) {
  return typeof str === 'string' && str.startsWith('data:application/pdf;base64,');
}

/**
 * Extract text from a PDF.
 * Accepts:
 *   - Buffer (raw PDF bytes)
 *   - base64 data URL string (data:application/pdf;base64,...)
 *
 * Returns extracted text string, or throws if extraction fails.
 */
async function extractPdfText(input) {
  if (!pdfParse) {
    throw new Error(
      'pdf-parse is not installed. Run: npm install pdf-parse'
    );
  }

  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else if (isBase64Pdf(input)) {
    const base64 = input.replace('data:application/pdf;base64,', '');
    buffer = Buffer.from(base64, 'base64');
  } else {
    throw new Error('extractPdfText: input must be a Buffer or base64 PDF data URL');
  }

  const result = await pdfParse(buffer);
  const text   = (result.text || '').trim();

  if (!text) {
    throw new Error(
      'PDF appears to be scanned or image-only — no text could be extracted. ' +
      'Try copying the text manually and uploading as a .txt file.'
    );
  }

  return text;
}

module.exports = { extractPdfText, isBase64Pdf };
`);

// ── Patch routes/documents.js to handle base64 PDF content ───────────────────
const docsPath = path.join(SRC, 'routes/documents.js');
let docs = fs.readFileSync(docsPath, 'utf8');

// Add import at top if not already there
if (!docs.includes('pdfExtract')) {
  docs = docs.replace(
    "const { chunkText } = require('../chunker');",
    "const { chunkText }          = require('../chunker');\nconst { extractPdfText, isBase64Pdf } = require('../pdfExtract');"
  );
  console.log('  ✅  Added pdfExtract import to routes/documents.js');
}

// Add PDF content processing before chunking
const TARGET = '    // 1. Chunk\n    const chunks = chunkText(content, document_id);';
const REPLACEMENT = `    // 1. Handle PDF base64 content sent from older frontend paths
    let processedContent = content;
    if (isBase64Pdf(content)) {
      try {
        console.log('[documents] Detected base64 PDF — extracting text server-side');
        processedContent = await extractPdfText(content);
        console.log(\`[documents] PDF text extracted: \${processedContent.length} chars\`);
      } catch (err) {
        return res.status(400).json({
          error:   'PDF_EXTRACTION_FAILED',
          message: err.message,
          field:   'content',
        });
      }
    }

    // 1. Chunk
    const chunks = chunkText(processedContent, document_id);`;

if (!docs.includes('isBase64Pdf(content)') && docs.includes(TARGET)) {
  docs = docs.replace(TARGET, REPLACEMENT);
  console.log('  ✅  Added PDF base64 extraction to POST /documents');
}

fs.writeFileSync(docsPath, docs, 'utf8');
console.log(`  ✅  Updated routes/documents.js`);

console.log('\n══════════════════════════════════════════════');
console.log('  DONE. One more step:\n');
console.log('  Install the PDF parser in your backend:');
console.log('  npm install pdf-parse\n');
console.log('  Then restart: npm run dev\n');
console.log('  How it works:');
console.log('  • Frontend (pdfjs-dist): extracts text in browser before upload');
console.log('    → fast, no server load, works for text-based PDFs');
console.log('  • Backend (pdf-parse): catches any base64 PDF that slips through');
console.log('    → fallback for older code paths or direct API uploads');
console.log('  • Both return plain text to the chunker — same pipeline from there');
console.log('══════════════════════════════════════════════\n');