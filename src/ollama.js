/**
 * HuggingFace Inference API client
 * Drop-in replacement for ollama.js — same exported functions.
 *
 * LLM:   Qwen/Qwen2.5-72B-Instruct
 * Embed: sentence-transformers/all-MiniLM-L6-v2 (384 dims)
 */

const https = require('https');

const HF_API_KEY  = process.env.HF_API_KEY;
const LLM_MODEL   = 'Qwen/Qwen2.5-72B-Instruct';
const EMBED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const EMBED_DIMS  = 384;

const SYSTEM_PROMPT = `You are a helpful assistant. Answer in 2-4 sentences using only the provided context.
If the context does not contain the answer, say exactly: "The answer is not found in the uploaded documents."`;

function hfPost(urlPath, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!HF_API_KEY || HF_API_KEY === 'your_key_here') {
      reject(new Error('HF_API_KEY is not set in .env'));
      return;
    }
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'router.huggingface.co',
      path:     urlPath,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${HF_API_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(bufs).toString('utf8');
        if (res.statusCode === 503) { reject(new Error('HF model loading — retry in 20s')); return; }
        if (res.statusCode === 402) { reject(new Error('HF 402: insufficient credits — check huggingface.co/pricing')); return; }
        if (res.statusCode === 401) { reject(new Error('HF 401: invalid API key — check HF_API_KEY in .env')); return; }
        if (res.statusCode >= 400) { reject(new Error(`HF ${urlPath} ${res.statusCode}: ${text.slice(0, 300)}`)); return; }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`HF non-JSON: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`HF ${urlPath} timed out after ${timeoutMs}ms`)); });
    req.write(payload);
    req.end();
  });
}

async function ping() {
  if (!HF_API_KEY || HF_API_KEY === 'your_key_here') return false;
  try {
    return await new Promise(resolve => {
      const req = https.get('https://huggingface.co', { timeout: 4000 }, res => { resolve(res.statusCode < 500); res.resume(); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } catch { return false; }
}

async function embed(text) {
  if (!text?.trim()) throw new Error('embed: text is required');
  const result = await hfPost(
    `/hf-inference/models/${EMBED_MODEL}/pipeline/feature-extraction`,
    { inputs: [text.trim()] },
    30000
  );
  const vector = Array.isArray(result[0]) ? result[0] : result;
  if (vector.length !== EMBED_DIMS) throw new Error(`embed: expected ${EMBED_DIMS} dims, got ${vector.length}`);
  return vector;
}

async function chat(prompt) {
  if (!prompt?.trim()) throw new Error('chat: prompt is required');
  const result = await hfPost(
    `/v1/chat/completions`,
    {
      model:       LLM_MODEL,
      messages:    [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt.trim() }],
      max_tokens:  300,
      temperature: 0.2,
      stream:      false,
    },
    60000
  );
  const text = result?.choices?.[0]?.message?.content;
  if (!text) throw new Error('chat: no content in HF response: ' + JSON.stringify(result).slice(0, 200));
  return text.trim();
}

async function warmup() {
  if (!HF_API_KEY || HF_API_KEY === 'your_key_here') {
    console.warn('[hf] ⚠️  HF_API_KEY not set — add it to .env');
    return;
  }
  console.log('[hf] warming up HuggingFace models...');
  try {
    await embed('warmup');
    console.log(`[hf] embed ready (${EMBED_MODEL})`);
  } catch (err) {
    console.warn('[hf] embed warmup failed:', err.message);
  }
  try {
    await chat('Say "ready".');
    console.log(`[hf] LLM ready (${LLM_MODEL})`);
  } catch (err) {
    console.warn('[hf] LLM warmup failed:', err.message);
    if (err.message.includes('402') || err.message.includes('PRO')) {
      console.warn('[hf] ⚠️  Check your HF account credits at huggingface.co/pricing');
      console.warn('[hf]    Qwen2.5-72B should be free — verify at huggingface.co/Qwen/Qwen2.5-72B-Instruct');
    }
  }
  console.log('[hf] server ready');
}

module.exports = { ping, embed, chat, warmup };