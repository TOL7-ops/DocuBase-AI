const math = require('mathjs');

function run(input) {
  if (!input || typeof input !== 'string') return { result: null, error: 'Input must be a non-empty string' };
  const sanitised = input.trim();
  if (sanitised.length > 500) return { result: null, error: 'Expression too long (max 500 chars)' };

  try {
    const raw = math.evaluate(sanitised);
    let result;
    if (typeof raw === 'number') {
      if (!isFinite(raw)) return { result: null, error: 'Result is not finite (e.g. division by zero)' };
      result = Number.isInteger(raw) ? String(raw) : String(parseFloat(raw.toPrecision(12)));
    } else if (typeof raw === 'bigint') {
      result = String(raw);
    } else {
      result = math.format(raw, { precision: 12 });
    }
    return { result, error: null };
  } catch (err) {
    return { result: null, error: err.message || String(err) };
  }
}

module.exports = { run };
