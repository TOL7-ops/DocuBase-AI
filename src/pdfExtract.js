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
