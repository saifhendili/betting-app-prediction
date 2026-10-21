import { generateJson, GeminiUnavailable, geminiKeys, geminiUsage } from './client.js';
import { SYSTEM, RESPONSE_SCHEMA, buildPrompt } from './prompts.js';
import { confidenceFor } from '../model/picks.js';
import { clamp, fairOdds } from '../model/math.js';
import { log } from '../../utils/logger.js';

const MAX_ADJUSTMENT = 0.08; // ±8 percentage points, enforced server-side

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const strList = (v, max = 4) =>
  Array.isArray(v) ? v.map((s) => str(s, 300)).filter(Boolean).slice(0, max) : [];

/**
 * Runs the AI layer over the already-ranked candidates and folds the result
 * back into the numbers: clamped probability adjustments, a re-ordered pick
 * list and a narrative. Falls back to a pure model verdict if Gemini is down,
 * so a missing/exhausted key never breaks a prediction.
 */
export async function analyse({ game, model, market, picks, risk, h2h, recent }) {
  if (!geminiKeys.size) {
    return { ai: null, picks, degraded: 'no-gemini-key' };
  }

  const prompt = buildPrompt({ game, model, market, candidates: picks, risk, h2h, recent });

  let result;
  try {
    result = await generateJson({
      system: SYSTEM,
      prompt,
      schema: RESPONSE_SCHEMA,
      temperature: risk === 'aggressive' ? 0.45 : 0.3,
      maxOutputTokens: 2048,
    });
  } catch (err) {
    if (err instanceof GeminiUnavailable) {
      log.warn(`AI layer skipped: ${err.message}`);
      return { ai: null, picks, degraded: 'gemini-unavailable', error: err.message };
    }
    throw err;
  }

  const raw = result.data || {};

  // ── apply clamped adjustments ────────────────────────────────────────────
  const applied = [];
  const byId = new Map(picks.map((p) => [p.id, p]));
  let adjusted = picks.map((p) => ({ ...p }));

  if (Array.isArray(raw.adjustments)) {
    raw.adjustments.slice(0, 6).forEach((adj) => {
      const target = byId.get(str(adj?.pickId, 120));
      if (!target) return;
      const deltaPp = Number(adj?.deltaPercentagePoints);
      if (!Number.isFinite(deltaPp) || deltaPp === 0) return;
      const delta = clamp(deltaPp / 100, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
      const row = adjusted.find((p) => p.id === target.id);
      if (!row) return;
      const before = row.probability;
      row.probability = clamp(before + delta, 0.01, 0.985);
      row.fairOdds = fairOdds(row.probability);
      row.aiAdjusted = true;
      row.aiDelta = Math.round((row.probability - before) * 1000) / 1000;
      if (Number.isFinite(row.marketOdds)) row.ev = row.probability * row.marketOdds - 1;
      // Refresh the edge only if the pick had a comparable one already. A null
      // edge means the quoted price is not comparable to this model — a
      // pre-match price against an in-play model — and recomputing it here
      // would put a meaningless number back on the card.
      const hadComparableEdge = Number.isFinite(row.edge);
      if (hadComparableEdge && Number.isFinite(row.marketProbability)) {
        row.edge = row.probability - row.marketProbability;
      }
      applied.push({
        pickId: row.id,
        selection: row.selection,
        deltaPercentagePoints: Math.round(row.aiDelta * 1000) / 10,
        why: str(adj?.why, 240),
      });
    });
  }

  // recompute confidence after adjustment
  adjusted = adjusted.map((p) => {
    const confidence = confidenceFor(p, { model, market });
    return { ...p, confidence, stars: Math.max(1, Math.min(5, Math.round(confidence / 20))) };
  });

  // ── promote the AI's chosen pick to the top ──────────────────────────────
  const chosenId = str(raw.bestPickId, 120);
  const chosenIdx = adjusted.findIndex((p) => p.id === chosenId);
  if (chosenIdx > 0) {
    const [chosen] = adjusted.splice(chosenIdx, 1);
    adjusted.unshift(chosen);
  }
  adjusted = adjusted.map((p, i) => ({ ...p, rank: i + 1, isTopPick: i === 0 }));

  const aiConfidence = Number(raw.confidence);
  const verdict = ['strong', 'lean', 'pass'].includes(raw.verdict) ? raw.verdict : 'lean';

  const ai = {
    verdict,
    headline: str(raw.headline, 180),
    confidence: Number.isFinite(aiConfidence) ? Math.round(clamp(aiConfidence, 0, 100)) : null,
    reasoning: strList(raw.reasoning, 4),
    keyFactors: strList(raw.keyFactors, 3),
    risks: strList(raw.risks, 3),
    adjustments: applied,
    chosePickId: chosenIdx >= 0 ? chosenId : null,
    model: result.model,
    key: result.keyLabel,
    tokens: result.usage ? { in: result.usage.promptTokenCount, out: result.usage.candidatesTokenCount } : null,
  };

  return { ai, picks: adjusted, degraded: null };
}

export { geminiKeys, geminiUsage };
