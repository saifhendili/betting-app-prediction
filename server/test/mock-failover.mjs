/**
 * Failover harness: the first sports key always returns 429, the first TWO
 * Gemini keys always return 429. Proves the pool benches dead keys, retries the
 * request on the next one, and degrades gracefully when every key is spent.
 *
 *   node --import ./test/mock-failover.mjs src/index.js
 */
process.env.SPORTS_API_KEYS = 'deadKey1,goodKey2,goodKey3';
process.env.GEMINI_API_KEYS = 'gDead1,gDead2';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/betting_failover';
process.env.PORT = '5056';

await import('./mock-upstream.mjs');

const patched = globalThis.fetch;
const seen = { sports429: 0, gemini429: 0, sportsOk: 0, geminiOk: 0 };

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (url.includes('api-sports.io')) {
    const key = init?.headers?.['x-apisports-key'];
    if (key === 'deadKey1') {
      seen.sports429 += 1;
      return new Response(JSON.stringify({ errors: { requests: 'You have reached your daily request limit' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    seen.sportsOk += 1;
  }

  if (url.includes('generativelanguage')) {
    const key = init?.headers?.['x-goog-api-key'];
    if (key === 'gDead1' || key === 'gDead2') {
      seen.gemini429 += 1;
      return new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } }), {
        status: 429, headers: { 'content-type': 'application/json' },
      });
    }
    seen.geminiOk += 1;
  }

  return patched(input, init);
};

globalThis.__failoverCounters = seen;
console.log('[failover] sports key 1 and both gemini keys will report quota exhaustion');
