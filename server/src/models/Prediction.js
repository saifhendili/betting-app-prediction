import mongoose from 'mongoose';

const pickSchema = new mongoose.Schema(
  {
    market: String,       // "1X2" | "Over/Under" | "Double Chance" | ...
    selection: String,    // human label, e.g. "Over 2.5 goals"
    probability: Number,  // 0..1 final blended probability
    fairOdds: Number,     // 1 / probability
    marketOdds: Number,   // bookmaker price if we had one
    edge: Number,         // probability - market implied probability
    confidence: Number,   // 0..100
    stars: Number,        // 1..5 display rating
    reason: String,
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    cacheKey: { type: String, required: true, unique: true, index: true },
    sport: { type: String, index: true },
    fixtureId: { type: String, index: true },
    risk: { type: String, index: true },
    kickoff: Date,
    teams: { home: String, away: String },
    league: String,
    model: mongoose.Schema.Types.Mixed,   // raw statistical output
    market: mongoose.Schema.Types.Mixed,  // de-vigged bookmaker probabilities
    blended: mongoose.Schema.Types.Mixed, // model+market fusion
    ai: mongoose.Schema.Types.Mixed,      // Gemini narrative + adjustments
    picks: [pickSchema],
    headline: String,
    confidence: Number,
    engine: String,                       // "model+market+gemini" etc.
    expiresAt: { type: Date, index: { expires: 0 } },
  },
  { timestamps: true }
);

export const Prediction = mongoose.model('Prediction', schema);
