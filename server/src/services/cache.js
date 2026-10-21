import { ApiCache } from '../models/ApiCache.js';
import { isMongoUp } from '../db/connect.js';

/**
 * Two-tier cache: a process-local Map in front of a Mongo collection.
 * The memory tier makes bursts of UI requests free; the Mongo tier survives
 * restarts, which matters a lot when the upstream quota is 100 calls/day.
 */
const mem = new Map();
const MEM_MAX = 2000;

function memSet(key, payload, ttlSeconds) {
  if (mem.size >= MEM_MAX) {
    // drop the oldest ~10% to keep memory bounded
    const victims = [...mem.keys()].slice(0, Math.ceil(MEM_MAX / 10));
    victims.forEach((k) => mem.delete(k));
  }
  mem.set(key, { payload, expires: Date.now() + ttlSeconds * 1000 });
}

export async function cacheGet(key) {
  const hit = mem.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.payload;
    mem.delete(key);
  }
  if (!isMongoUp()) return null;
  try {
    const doc = await ApiCache.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
    if (!doc) return null;
    const ttl = Math.max(1, Math.floor((new Date(doc.expiresAt) - Date.now()) / 1000));
    memSet(key, doc.payload, Math.min(ttl, 300));
    return doc.payload;
  } catch {
    return null;
  }
}

export async function cacheSet(key, payload, ttlSeconds) {
  memSet(key, payload, ttlSeconds);
  if (!isMongoUp()) return;
  try {
    await ApiCache.updateOne(
      { key },
      { $set: { payload, expiresAt: new Date(Date.now() + ttlSeconds * 1000) } },
      { upsert: true }
    );
  } catch {
    /* cache writes are best-effort */
  }
}

/** Fetch-through helper: returns {data, cached}. */
export async function cached(key, ttlSeconds, producer) {
  const hit = await cacheGet(key);
  if (hit !== null && hit !== undefined) return { data: hit, cached: true };
  const data = await producer();
  if (data !== null && data !== undefined) await cacheSet(key, data, ttlSeconds);
  return { data, cached: false };
}

export const cacheStats = () => ({ memoryEntries: mem.size });
