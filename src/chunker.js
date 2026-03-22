const crypto = require('crypto');

const CHUNK_CHARS   = 2048;
const OVERLAP_CHARS =  256;
const MIN_CHARS     =  200;
const STEP          = CHUNK_CHARS - OVERLAP_CHARS; // 1792

const SENTENCE_END_RE = /[.!?\n]{1,3}\s+/g;

function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function findBreakPoint(text, searchStart, searchEnd) {
  const window = text.slice(searchStart, searchEnd);

  const paraIdx = window.lastIndexOf('\n\n');
  if (paraIdx !== -1 && paraIdx > 0) return searchStart + paraIdx + 2;

  let lastSentenceEnd = -1;
  let match;
  SENTENCE_END_RE.lastIndex = 0;
  while ((match = SENTENCE_END_RE.exec(window)) !== null) {
    lastSentenceEnd = match.index + match[0].length;
  }
  if (lastSentenceEnd > 0) return searchStart + lastSentenceEnd;

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) return searchStart + lastSpace + 1;

  return searchEnd;
}

function chunkText(rawText, documentId) {
  if (!rawText || typeof rawText !== 'string') throw new Error('chunkText: rawText must be a non-empty string');
  if (!documentId || typeof documentId !== 'string') throw new Error('chunkText: documentId must be a non-empty string');

  const text = cleanText(rawText);
  const chunks = [];
  let pos = 0;
  let chunkIndex = 0;

  if (text.length <= CHUNK_CHARS) {
    if (text.length >= MIN_CHARS) {
      chunks.push({ chunk_id: crypto.randomUUID(), document_id: documentId, chunk_index: 0, content: text, char_start: 0, char_end: text.length });
    }
    return chunks;
  }

  while (pos < text.length) {
    const rawEnd = Math.min(pos + CHUNK_CHARS, text.length);
    let end;

    if (rawEnd === text.length) {
      end = text.length;
    } else {
      const searchStart = pos + Math.floor(CHUNK_CHARS * 0.75);
      end = findBreakPoint(text, searchStart, rawEnd);
    }

    const content = text.slice(pos, end).trim();

    if (content.length >= MIN_CHARS) {
      chunks.push({ chunk_id: crypto.randomUUID(), document_id: documentId, chunk_index: chunkIndex, content, char_start: pos, char_end: end });
      chunkIndex++;
    }

    const prevPos = pos;
    pos = Math.max(end - OVERLAP_CHARS, pos + STEP);
    if (pos <= prevPos) pos = end;
  }

  return chunks;
}

module.exports = { chunkText, cleanText };
