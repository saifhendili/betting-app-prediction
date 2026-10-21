import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { log } from '../utils/logger.js';

let connected = false;
export const isMongoUp = () => connected;

/**
 * Mongo is used as the cache + history store. If it is unreachable we keep
 * running on the in-memory fallback cache instead of taking the app down —
 * predictions still work, they just are not persisted across restarts.
 */
export async function connectDB() {
  if (!env.mongoUri) {
    log.warn('No MONGO_URI set — running with in-memory cache only.');
    return false;
  }
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000,
    });
    connected = true;
    log.ok(`MongoDB connected → ${mongoose.connection.name}`);

    mongoose.connection.on('disconnected', () => {
      connected = false;
      log.warn('MongoDB disconnected — falling back to in-memory cache.');
    });
    mongoose.connection.on('connected', () => {
      connected = true;
    });
    return true;
  } catch (err) {
    connected = false;
    log.warn(`MongoDB unavailable (${err.message}). Using in-memory cache.`);
    log.warn('Start one with:  npm run mongo:up   (needs Docker)');
    return false;
  }
}
