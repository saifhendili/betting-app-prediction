import { env } from '../config/env.js';
import { Settings } from '../models/Settings.js';
import { isMongoUp } from '../db/connect.js';
import { maskKey } from './keyPool.js';
import { geminiKeys } from './gemini/client.js';
import { sportsKeys } from './sportsApi/client.js';
import { describeSource } from './sportsApi/index.js';
import { log } from '../utils/logger.js';

/**
 * Runtime settings: keys entered in the app's settings panel win over .env.
 * Changes are applied to the live key pools immediately — no restart.
 *
 * `current` is the in-memory source of truth so the app still works when Mongo
 * is unavailable; it just can't persist across restarts in that case.
 */
const current = {
  geminiKeys: null,   // null = "not set here, use .env"
  sportsKeys: null,
  geminiModel: null,
  sportsProvider: null,
  dataSource: null,
  marketWeight: null,
  enableOdds: null,
};

const clean = (arr) =>
  (Array.isArray(arr) ? arr : String(arr || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);

/** Effective key list for a provider: settings first, then .env. */
const effectiveKeys = (fromSettings, fromEnv) =>
  fromSettings && fromSettings.length ? fromSettings : fromEnv;

/** Push the effective configuration into the live pools and env object. */
export function applySettings() {
  sportsKeys.setKeys(effectiveKeys(current.sportsKeys, env.sports.keys));
  geminiKeys.setKeys(effectiveKeys(current.geminiKeys, env.gemini.keys));

  if (current.geminiModel) env.gemini.model = current.geminiModel;
  if (current.sportsProvider) env.sports.provider = current.sportsProvider;
  if (current.dataSource) env.sports.dataSource = current.dataSource;
  if (Number.isFinite(current.marketWeight)) env.marketWeight = current.marketWeight;
  if (typeof current.enableOdds === 'boolean') env.enableOdds = current.enableOdds;
}

/** Read persisted settings at boot. Safe to call with Mongo down. */
export async function loadSettings() {
  if (isMongoUp()) {
    try {
      const doc = await Settings.findById('global').lean();
      if (doc) {
        current.geminiKeys = clean(doc.geminiKeys);
        current.sportsKeys = clean(doc.sportsKeys);
        current.geminiModel = doc.geminiModel || null;
        current.sportsProvider = doc.sportsProvider || null;
        current.dataSource = ['espn', 'apisports'].includes(doc.dataSource) ? doc.dataSource : null;
        current.marketWeight = Number.isFinite(doc.marketWeight) ? doc.marketWeight : null;
        current.enableOdds = typeof doc.enableOdds === 'boolean' ? doc.enableOdds : null;
        log.ok(
          `settings loaded from database (${current.geminiKeys.length} gemini, ${current.sportsKeys.length} sports key(s))`
        );
      }
    } catch (err) {
      log.warn(`could not read settings: ${err.message}`);
    }
  }
  applySettings();
}

/**
 * Save a patch. Only the fields present are touched, so the panel can update
 * the Gemini keys without clearing the sports keys.
 */
export async function saveSettings(patch = {}) {
  if ('geminiKeys' in patch) current.geminiKeys = clean(patch.geminiKeys);
  if ('sportsKeys' in patch) current.sportsKeys = clean(patch.sportsKeys);
  if ('geminiModel' in patch) current.geminiModel = patch.geminiModel?.trim() || null;
  if ('sportsProvider' in patch) {
    const p = String(patch.sportsProvider || '').toLowerCase();
    current.sportsProvider = p === 'rapidapi' || p === 'apisports' ? p : null;
  }
  if ('dataSource' in patch) {
    const d = String(patch.dataSource || '').toLowerCase();
    current.dataSource = d === 'espn' || d === 'apisports' ? d : null;
  }
  if ('marketWeight' in patch) {
    const w = Number(patch.marketWeight);
    current.marketWeight = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : null;
  }
  if ('enableOdds' in patch) current.enableOdds = Boolean(patch.enableOdds);

  applySettings();

  let persisted = false;
  if (isMongoUp()) {
    try {
      await Settings.findByIdAndUpdate(
        'global',
        {
          $set: {
            geminiKeys: current.geminiKeys || [],
            sportsKeys: current.sportsKeys || [],
            geminiModel: current.geminiModel,
            sportsProvider: current.sportsProvider,
            dataSource: current.dataSource,
            marketWeight: current.marketWeight,
            enableOdds: current.enableOdds,
          },
        },
        { upsert: true }
      );
      persisted = true;
    } catch (err) {
      log.warn(`could not persist settings: ${err.message}`);
    }
  }

  return { persisted };
}

/**
 * Masked view for the UI. Full keys are never sent back to the browser — once
 * saved, a key can be replaced but not read out again.
 */
export function describeSettings() {
  const gem = effectiveKeys(current.geminiKeys, env.gemini.keys);
  const spt = effectiveKeys(current.sportsKeys, env.sports.keys);
  return {
    gemini: {
      count: gem.length,
      masked: gem.map(maskKey),
      source: current.geminiKeys?.length ? 'settings' : env.gemini.keys.length ? 'env' : 'none',
      model: env.gemini.model,
      fallbackModels: env.gemini.fallbackModels,
    },
    sports: {
      count: spt.length,
      masked: spt.map(maskKey),
      source: current.sportsKeys?.length ? 'settings' : env.sports.keys.length ? 'env' : 'none',
      provider: env.sports.provider,
      dataSource: describeSource(),
    },
    options: { marketWeight: env.marketWeight, enableOdds: env.enableOdds, timezone: env.timezone },
    persistence: isMongoUp()
      ? 'database'
      : 'memory-only (MongoDB offline — settings will be lost on restart)',
  };
}

// ── live validation ─────────────────────────────────────────────────────────

/**
 * Check a Gemini key with the models endpoint rather than generateContent, so
 * validating a key costs nothing against the generation quota.
 */
async function testGeminiKey(key) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
      signal: ac.signal,
    });
    if (res.ok) {
      const body = await res.json();
      const names = (body.models || []).map((m) => String(m.name).replace('models/', ''));
      const wanted = [env.gemini.model, ...env.gemini.fallbackModels];
      const available = wanted.filter((w) => names.includes(w));
      return {
        ok: true,
        detail: available.length
          ? `valid · ${available.join(', ')} available`
          : `valid · but none of ${wanted.join(', ')} are available to this key`,
        models: available,
      };
    }
    const txt = await res.text();
    if (res.status === 400 || res.status === 403) return { ok: false, detail: 'key rejected — check you copied it fully' };
    if (res.status === 429) return { ok: false, detail: 'rate limited right now (the key itself may be fine)' };
    return { ok: false, detail: `HTTP ${res.status}: ${txt.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, detail: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** API-SPORTS /status reports the plan and today's usage without costing a request. */
async function testSportsKey(key) {
  const host =
    env.sports.provider === 'rapidapi'
      ? 'https://api-football-v1.p.rapidapi.com/v3/status'
      : 'https://v3.football.api-sports.io/status';
  const headers =
    env.sports.provider === 'rapidapi'
      ? { 'x-rapidapi-key': key, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
      : { 'x-apisports-key': key };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(host, { headers, signal: ac.signal });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    const errs = body?.errors;
    const errText = Array.isArray(errs) ? errs.join('; ') : errs && typeof errs === 'object' ? Object.values(errs).join('; ') : '';
    if (errText) return { ok: false, detail: errText.slice(0, 140) };
    const r = body?.response;
    if (!r?.account && !r?.subscription) return { ok: false, detail: 'unexpected response — is the key correct?' };
    const used = r?.requests?.current ?? '?';
    const cap = r?.requests?.limit_day ?? '?';
    return {
      ok: true,
      detail: `valid · plan ${r?.subscription?.plan || '?'} · ${used}/${cap} requests used today`,
      usage: { used, limit: cap },
    };
  } catch (err) {
    return { ok: false, detail: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Test the supplied keys, or whatever is currently configured. */
export async function testKeys({ geminiKeys: gk, sportsKeys: sk } = {}) {
  const gem = gk ? clean(gk) : effectiveKeys(current.geminiKeys, env.gemini.keys);
  const spt = sk ? clean(sk) : effectiveKeys(current.sportsKeys, env.sports.keys);

  const [gemini, sports] = await Promise.all([
    Promise.all(gem.map(async (k, i) => ({ label: `gemini#${i + 1}`, key: maskKey(k), ...(await testGeminiKey(k)) }))),
    Promise.all(spt.map(async (k, i) => ({ label: `sports#${i + 1}`, key: maskKey(k), ...(await testSportsKey(k)) }))),
  ]);

  return {
    gemini,
    sports,
    summary: {
      geminiOk: gemini.filter((r) => r.ok).length,
      geminiTotal: gemini.length,
      sportsOk: sports.filter((r) => r.ok).length,
      sportsTotal: sports.length,
    },
  };
}
