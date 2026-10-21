import mongoose from 'mongoose';

/**
 * Single-document runtime configuration, so API keys can be managed from the
 * app's settings panel instead of editing .env and restarting.
 * Anything left empty here falls back to the corresponding .env value.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    geminiKeys: { type: [String], default: [] },
    sportsKeys: { type: [String], default: [] },
    geminiModel: { type: String, default: null },
    sportsProvider: { type: String, default: null },
    marketWeight: { type: Number, default: null },
    enableOdds: { type: Boolean, default: null },
    timezone: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

export const Settings = mongoose.model('Settings', schema);
