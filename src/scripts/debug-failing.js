#!/usr/bin/env node
/**
 * DEBUG — targeted at the 4 failing checks
 * node src/scripts/debug-failing.js
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
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, raw: text, body: json };
  } catch (err) {
    return { status: 0, raw: err.message, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function get(url) {
  try {
    const r = await fetch(url);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, raw: text, body: json };
  } catch (err) {
    return { status: 0, raw: err.message, body: null };
  }
}

function print(label, res) {
  console.log(`\n── ${label}`);
  console.log(`   status : ${res.status}`);
  console.log(`   raw    : ${res.raw.slice(0, 500)}`);
  if (res.body) {
    console.log(`   parsed :`);
    for (const [k, v] of Object.entries(res.body)) {
      const val = typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v)?.slice(0, 120);
      console.log(`     ${k}: ${val}`);
    }
  }
}

async function run() {
  console.log('\n══════════════════════════════════════════');
  console.log('  TARGETED DEBUG — 4 failing checks');
  console.log('══════════════════════════════════════════');

  // ── Check 4: grounded /ask ─────────────────────────────────────────────────
  console.log('\n\n[CHECK 4] POST /ask — grounded question');
  console.log('Waiting up to 5 min for LLM...');
  const ask4 = await post(`${BASE}/ask`, { question: 'What is machine learning?' }, 300000);
  print('POST /ask grounded', ask4);

  // ── Check 5: fallback /ask ─────────────────────────────────────────────────
  console.log('\n\n[CHECK 5] POST /ask — off-topic fallback');
  const ask5 = await post(`${BASE}/ask`, { question: 'What is the population of Mars?' }, 60000);
  print('POST /ask fallback', ask5);

  // ── Check 6: session history ───────────────────────────────────────────────
  console.log('\n\n[CHECK 6] GET /sessions/:id');
  const sid = ask4.body?.session_id;
  if (sid) {
    const sess = await get(`${BASE}/sessions/${sid}`);
    print(`GET /sessions/${sid}`, sess);
  } else {
    console.log('   ⚠️  No session_id returned from Check 4 — cannot test Check 6');
    console.log('   session_id in body:', ask4.body?.session_id);
    console.log('   full body keys:', ask4.body ? Object.keys(ask4.body) : 'null');
  }

  // ── Check 7: calculator ────────────────────────────────────────────────────
  console.log('\n\n[CHECK 7] POST /ask — calculator: 142 * 365');
  const ask7 = await post(`${BASE}/ask`, { question: 'What is 142 * 365?' }, 300000);
  print('POST /ask calculator', ask7);
  if (ask7.body) {
    console.log(`\n   tool_used   : ${ask7.body.tool_used}`);
    console.log(`   answer      : ${String(ask7.body.answer).slice(0, 200)}`);
    console.log(`   contains 51830: ${String(ask7.body.answer).includes('51830')}`);
  }

  console.log('\n══════════════════════════════════════════\n');
}

run().catch(console.error);