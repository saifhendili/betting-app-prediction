import { log } from '../utils/logger.js';

/**
 * Rotates a list of API keys and benches the ones that report exhaustion.
 *
 * Why: both Gemini and API-Sports free tiers are quota-limited per key, so the
 * app is designed around "bring as many keys as you like" — the pool spreads
 * load round-robin and automatically skips a key that returned 429 / quota
 * errors until its cooldown expires.
 */
export class KeyPool {
  constructor(name, keys = [], { cooldownMs = 10 * 60 * 1000 } = {}) {
    this.name = name;
    this.cooldownMs = cooldownMs;
    this.cursor = 0;
    this.keys = keys.map((key, i) => ({
      key,
      label: `${name}#${i + 1}`,
      masked: maskKey(key),
      calls: 0,
      errors: 0,
      benchedUntil: 0,
      lastError: null,
      lastUsed: null,
    }));
    if (!this.keys.length) log.warn(`${name}: no API keys configured.`);
    else log.ok(`${name}: ${this.keys.length} key(s) loaded (${this.keys.map((k) => k.masked).join(', ')})`);
  }

  get size() {
    return this.keys.length;
  }

  /**
   * Replace the key list at runtime (settings panel save). Keys that are still
   * present keep their counters and any active cooldown, so saving settings
   * cannot be used to wipe a rate-limit bench.
   */
  setKeys(keys = []) {
    const existing = new Map(this.keys.map((k) => [k.key, k]));
    this.keys = keys
      .filter((k) => typeof k === 'string' && k.trim())
      .map((raw, i) => {
        const key = raw.trim();
        const prev = existing.get(key);
        if (prev) {
          prev.label = `${this.name}#${i + 1}`;
          return prev;
        }
        return {
          key,
          label: `${this.name}#${i + 1}`,
          masked: maskKey(key),
          calls: 0,
          errors: 0,
          benchedUntil: 0,
          lastError: null,
          lastUsed: null,
        };
      });
    this.cursor = 0;
    log.ok(`${this.name}: now ${this.keys.length} key(s) (${this.keys.map((k) => k.masked).join(', ') || 'none'})`);
    return this.keys.length;
  }

  available() {
    const now = Date.now();
    return this.keys.filter((k) => k.benchedUntil <= now);
  }

  /** Round-robin over the non-benched keys. */
  next() {
    const pool = this.available();
    if (!pool.length) return null;
    const entry = pool[this.cursor % pool.length];
    this.cursor = (this.cursor + 1) % pool.length;
    entry.calls += 1;
    entry.lastUsed = new Date().toISOString();
    return entry;
  }

  /** Record that a request was actually sent with this key. */
  markUsed(entry) {
    if (!entry) return;
    entry.calls += 1;
    entry.lastUsed = new Date().toISOString();
  }

  /**
   * Every key, starting at the rotation cursor — used to retry across keys.
   * Callers must call markUsed() for the key they actually send with, since
   * only some of the returned candidates will be tried.
   */
  orderedCandidates() {
    const pool = this.available();
    if (!pool.length) return [];
    const start = this.cursor % pool.length;
    const ordered = [...pool.slice(start), ...pool.slice(0, start)];
    this.cursor = (this.cursor + 1) % pool.length;
    return ordered;
  }

  bench(entry, reason, ms = this.cooldownMs) {
    if (!entry) return;
    // Guard against a caller passing 0/NaN and silently un-benching the key.
    const cooldown = Number.isFinite(ms) && ms > 0 ? ms : this.cooldownMs;
    entry.benchedUntil = Date.now() + cooldown;
    entry.errors += 1;
    entry.lastError = reason?.slice?.(0, 200) || String(reason);
    log.warn(`${entry.label} benched for ${Math.round(cooldown / 60000)}min — ${entry.lastError}`);
  }

  noteError(entry, reason) {
    if (!entry) return;
    entry.errors += 1;
    entry.lastError = reason?.slice?.(0, 200) || String(reason);
  }

  health() {
    const now = Date.now();
    return {
      name: this.name,
      configured: this.keys.length,
      available: this.available().length,
      keys: this.keys.map((k) => ({
        label: k.label,
        key: k.masked,
        calls: k.calls,
        errors: k.errors,
        benched: k.benchedUntil > now,
        benchedForSeconds: k.benchedUntil > now ? Math.ceil((k.benchedUntil - now) / 1000) : 0,
        lastUsed: k.lastUsed,
        lastError: k.lastError,
        dayRemaining: k.dayRemaining ?? null,
        dayLimit: k.dayLimit ?? null,
        perMinuteLimit: k.rateLimitPerMin ?? null,
      })),
    };
  }
}

export function maskKey(key) {
  if (!key) return '—';
  if (key.length <= 8) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
