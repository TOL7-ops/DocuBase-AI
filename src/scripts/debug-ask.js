#!/usr/bin/env node
/**
 * DEBUG /ask — shows the raw response to identify the shape mismatch
 * node src/scripts/debug-ask.js
 */

const BASE = 'http://localhost:3000';

async function post(url, body, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await r.text(); // raw text first
    console.log('\n── RAW HTTP STATUS:', r.status);
    console.log('── RAW BODY (first 1000 chars):');
    console.log(text.slice(0, 1000));
    console.log('\n── PARSED JSON:');
    try {
      const json = JSON.parse(text);
      console.log(JSON.stringify(json, null, 2));
      return { status: r.status, body: json };
    } catch (e) {
      console.log('(could not parse as JSON:', e.message, ')');
      return { status: r.status, body: null };
    }
  } catch (err) {
    if (err.name === 'AbortError') console.log('TIMED OUT after', timeoutMs, 'ms');
    else console.log('FETCH ERROR:', err.message);
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  console.log('\n══════════════════════════════════════════');
  console.log('  DEBUG: POST /ask');
  console.log('══════════════════════════════════════════');

  console.log('\n[Test 1] Simple grounded question...');
  await post(`${BASE}/ask`, { question: 'What is machine learning?' });

  console.log('\n\n[Test 2] Off-topic question (should return fallback)...');
  await post(`${BASE}/ask`, { question: 'What is the capital of France?' });

  console.log('\n\n[Test 3] Calculator question...');
  await post(`${BASE}/ask`, { question: 'What is 142 * 365?' });

  console.log('\n══════════════════════════════════════════\n');
}

run();