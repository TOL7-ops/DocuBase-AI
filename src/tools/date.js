function run(input) {
  if (!input || typeof input !== 'string') return { result: null, error: 'Input must be a non-empty string' };
  const cmd = input.trim().toLowerCase();
  const now = new Date();
  switch (cmd) {
    case 'today': {
      const yyyy = now.getFullYear();
      const mm   = String(now.getMonth() + 1).padStart(2, '0');
      const dd   = String(now.getDate()).padStart(2, '0');
      return { result: `${yyyy}-${mm}-${dd}`, error: null };
    }
    case 'now':       return { result: now.toISOString(), error: null };
    case 'timestamp': return { result: String(now.getTime()), error: null };
    default:          return { result: null, error: `Unsupported input: "${input}". Use "today", "now", or "timestamp"` };
  }
}
module.exports = { run };
