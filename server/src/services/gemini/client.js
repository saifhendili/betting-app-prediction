import { env } from '../../config/env.js';
import { KeyPool } from '../keyPool.js';
import { log } from '../../utils/logger.js';

export const geminiKeys = new KeyPool('gemini', env.gemini.keys, { cooldownMs: 15 * 60 * 1000 });

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const usage = { day: null, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0 };
function countCall(ok, meta) {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0 });
  usage.calls += 1;
  if (!ok) usage.failures += 1;
  if (meta) {
    usage.tokensIn += meta.promptTokenCount || 0;
    usage.tokensOut += meta.candidatesTokenCount || 0;
  }
}
export const geminiUsage = () => ({ ...usage });

export class GeminiUnavailable extends Error {}
class RetryableGemini extends Error {}

function extractText(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

/** Models can wrap JSON in prose or fences despite responseMimeType — be forgiving. */
function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * One generateContent call, retried across every key and then across the
 * fallback models. Keys that report quota exhaustion get benched by the pool,
 * which is what makes "bring N keys" multiply the free tier.
 */
export async function generateJson({ system, prompt, schema, temperature = 0.35, maxOutputTokens = 2048 }) {
  if (!geminiKeys.size) {
    throw new GeminiUnavailable(
      'No Gemini API key configured. Add GEMINI_API_KEYS to server/.env (free keys at https://aistudio.google.com/apikey).'
    );
  }

  const models = [env.gemini.model, ...env.gemini.fallbackModels].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastError;

  for (const model of models) {
    const candidates = geminiKeys.orderedCandidates();
    if (!candidates.length) break;

    for (const entry of candidates) {
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          responseMimeType: 'application/json',
          ...(schema ? { responseSchema: schema } : {}),
          // 2.5 models support a thinking budget; a small one measurably helps
          // the reasoning quality here. 2.0 rejects the field entirely.
          ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 512 } } : {}),
        },
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      };

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), env.gemini.timeoutMs);
      try {
        geminiKeys.markUsed(entry);
        const res = await fetch(`${BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': entry.key },
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        if (res.status === 429) {
          // A missing retry-after must fall back to the pool default, not 0ms.
          const raw = res.headers.get('retry-after');
          const secs = raw === null ? NaN : Number(raw);
          const benchMs = Number.isFinite(secs) && secs > 0 ? Math.max(secs * 1000, 60_000) : undefined;
          geminiKeys.bench(entry, 'quota / rate limit (429)', benchMs);
          countCall(false);
          throw new RetryableGemini('429');
        }
        if (res.status === 400 || res.status === 403) {
          const txt = await res.text();
          if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(txt)) {
            geminiKeys.bench(entry, 'key rejected', 6 * 3600 * 1000);
            countCall(false);
            throw new RetryableGemini('invalid key');
          }
          countCall(false);
          throw new GeminiUnavailable(`Gemini rejected the request (${res.status}): ${txt.slice(0, 300)}`);
        }
        if (res.status === 404) {
          countCall(false);
          throw new RetryableGemini(`model ${model} not available for this key`);
        }
        if (res.status >= 500) {
          countCall(false);
          throw new RetryableGemini(`upstream ${res.status}`);
        }
        if (!res.ok) {
          countCall(false);
          throw new RetryableGemini(`HTTP ${res.status}`);
        }

        const json = await res.json();
        countCall(true, json.usageMetadata);

        const finish = json?.candidates?.[0]?.finishReason;
        const text = extractText(json);
        const parsed = parseJson(text);
        if (!parsed) {
          geminiKeys.noteError(entry, `unparseable response (finishReason=${finish})`);
          throw new RetryableGemini(`unparseable JSON (finishReason=${finish})`);
        }

        return { data: parsed, model, keyLabel: entry.label, finishReason: finish, usage: json.usageMetadata || null };
      } catch (err) {
        lastError = err;
        if (err instanceof RetryableGemini) continue;
        if (err.name === 'AbortError') {
          geminiKeys.noteError(entry, 'timeout');
          countCall(false);
          continue;
        }
        if (err instanceof GeminiUnavailable) throw err;
        geminiKeys.noteError(entry, err.message);
        countCall(false);
      } finally {
        clearTimeout(timer);
      }
    }
    log.warn(`Gemini: model ${model} exhausted all keys, trying fallback…`);
  }

  throw new GeminiUnavailable(
    `Gemini unavailable after trying ${models.length} model(s) across ${geminiKeys.size} key(s). Last error: ${lastError?.message || 'unknown'}`
  );
}
