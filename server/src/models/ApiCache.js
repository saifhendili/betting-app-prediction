import mongoose from 'mongoose';

/** Raw upstream responses, keyed by request signature. Mongo TTL reaps them. */
const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

export const ApiCache = mongoose.model('ApiCache', schema);
