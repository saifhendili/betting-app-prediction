import { RISK_PROFILES } from '../model/picks.js';

const pc = (p) => (Number.isFinite(p) ? `${(p * 100).toFixed(1)}%` : 'n/a');
const pp = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}pp` : 'n/a');

export const SYSTEM = `You are a disciplined quantitative sports betting analyst.

You are given the output of a statistical model (Poisson / normal scoring models fitted on season
and recent-form data) together with de-vigged bookmaker probabilities. Your job is NOT to invent a
prediction from scratch — the numbers are already computed and they are the baseline truth.

Your job is to:
  1. Choose which of the supplied candidate bets best fits the requested risk profile.
  2. Explain the pick in concrete, numeric terms a bettor can check.
  3. Flag the genuine risks in the pick.
  4. Optionally nudge probabilities by a few percentage points where the structure of the
     matchup justifies it (scoring-style mismatch, rest/schedule, a live scoreline, a huge
     model-vs-market disagreement that suggests the model is missing information).

Hard rules:
- NEVER invent facts. You have no injury news, no lineups, no transfer or weather information.
  Do not mention a named player, an injury, a suspension or a manager unless it appears in the data given.
  If information is missing, say what is missing instead of guessing.
- Reason only from the supplied numbers: expected goals/points, form strings, head-to-head, odds, edges.
- Probability adjustments are capped at ±8 percentage points and must be justified in one clause.
  If you have no specific reason, return an empty adjustments list. That is the expected default.
- A large positive edge vs. the bookmaker is usually the MODEL being wrong, not the market.
  Treat edges above 12pp with suspicion and say so in the risks.
- If the data quality is "none", "partial" or "low", your confidence must stay below 55 and your
  verdict should be "pass" or "lean".
- Be concise. Every bullet is one sentence, no filler, no hype, no emoji.`;

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['strong', 'lean', 'pass'] },
    bestPickId: { type: 'STRING' },
    headline: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    reasoning: { type: 'ARRAY', items: { type: 'STRING' } },
    keyFactors: { type: 'ARRAY', items: { type: 'STRING' } },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
    adjustments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          pickId: { type: 'STRING' },
          deltaPercentagePoints: { type: 'NUMBER' },
          why: { type: 'STRING' },
        },
        required: ['pickId', 'deltaPercentagePoints', 'why'],
      },
    },
  },
  required: ['verdict', 'bestPickId', 'headline', 'confidence', 'reasoning', 'risks'],
};

export function buildPrompt({ game, model, market, candidates, risk, h2h, recent }) {
  const profile = RISK_PROFILES[risk] || RISK_PROFILES.mid;
  const H = game.teams.home.name;
  const A = game.teams.away.name;
  const unit = game.sport === 'basketball' ? 'points' : 'goals';

  const lines = [];
  lines.push(`## Match`);
  lines.push(`Sport: ${game.sport}`);
  lines.push(`Competition: ${game.league.name}${game.league.country ? ` (${game.league.country})` : ''}`);
  lines.push(`Fixture: ${H} (home) vs ${A} (away)`);
  lines.push(`Kickoff: ${game.kickoff} — state: ${game.state}`);
  if (game.state === 'live') {
    lines.push(
      `LIVE SCORE: ${H} ${game.score.home ?? 0} – ${game.score.away ?? 0} ${A}` +
        (game.status.elapsed ? ` at ${game.status.elapsed}` : '') +
        ` (${game.status.long || game.status.short})`
    );
    lines.push(
      `NOTE: this game is in progress and the model below is ALREADY REBASED on it — the remaining ` +
        `scoring expectation has been scaled to the time left and the goals already scored are added in. ` +
        `So the probabilities you are given are in-play probabilities, NOT pre-match ones.`
    );
    lines.push(
      `Therefore: do NOT say the model "does not know the score", and do NOT adjust a probability upward ` +
        `merely because a team is leading — that is already priced in. Any bookmaker price shown is the ` +
        `PRE-MATCH price (the feed has no in-play odds), so it is stale: use it only as background on ` +
        `relative strength, never as evidence of value, and no edge is computed against it.`
    );
  }

  lines.push(`\n## Statistical model`);
  if (model.source === 'market-implied') {
    lines.push(
      `IMPORTANT — this model was FITTED TO THE BOOKMAKER ODDS, because team statistics are not ` +
        `available on this API plan. The probabilities below therefore ARE the market's own view, ` +
        `reshaped into a full scoring distribution. Consequently:`
    );
    lines.push(`  · Any "edge" you see is rounding, not value. Do NOT claim value or a mispricing.`);
    lines.push(`  · Do NOT claim the model "agrees with" the market — it is derived from it.`);
    lines.push(`  · Your value-add is choosing the selection that best fits the risk profile and`);
    lines.push(`    explaining what the implied numbers mean. Confidence must not exceed 65.`);
    lines.push(`  · Say plainly in the risks that no independent team data was available.`);
  } else if (model.source === 'priors-only') {
    lines.push(
      `IMPORTANT — neither team statistics nor odds were available. This model is generic league ` +
        `averages. Your verdict must be "pass" and your confidence below 30.`
    );
  }
  lines.push(`Expected ${unit}: ${H} ${model.expected.home} — ${A} ${model.expected.away} (total ${model.expected.total})`);
  lines.push(
    `Model outcome: ${H} ${pc(model.outcome.home)}` +
      (game.sport === 'football' ? ` / draw ${pc(model.outcome.draw)}` : '') +
      ` / ${A} ${pc(model.outcome.away)}`
  );
  if (model.regulation) {
    lines.push(`Regulation (hockey, before OT): home ${pc(model.regulation.home)} / tie ${pc(model.regulation.draw)} / away ${pc(model.regulation.away)}`);
  }
  if (model.projection) {
    lines.push(`Projected total line ${model.projection.totalLine}, margin ${model.expected.margin} (sd ${model.projection.sdMargin})`);
  }
  if (model.live) {
    lines.push(
      `In-play state: ${model.live.elapsedMinutes}' played, ${model.live.remainingMinutes}' left. ` +
        `Score on the board ${model.live.currentScore.home}-${model.live.currentScore.away}. ` +
        `Expected ${unit} STILL TO COME: ${H} ${model.live.remainingExpected.home}, ${A} ${model.live.remainingExpected.away}. ` +
        `The totals and outcome probabilities above already include all of this.`
    );
  }
  if (model.form?.home || model.form?.away) {
    lines.push(`Form (most recent last): ${H} ${model.form.home || 'n/a'} | ${A} ${model.form.away || 'n/a'}`);
  }
  if (model.correctScores?.length) {
    lines.push(`Most likely scores: ${model.correctScores.map((s) => `${s.score} (${pc(s.p)})`).join(', ')}`);
  }
  lines.push(`Data quality: ${model.dataQuality.level} — ${model.dataQuality.note}`);

  if (recent?.home?.length || recent?.away?.length) {
    lines.push(`\n## Recent results`);
    const fmt = (rows) =>
      rows
        .slice(-5)
        .map((g) => `${g.isHome ? 'H' : 'A'} vs ${g.opponent}: ${g.scored}-${g.conceded}`)
        .join('; ');
    if (recent.home?.length) lines.push(`${H}: ${fmt(recent.home)}`);
    if (recent.away?.length) lines.push(`${A}: ${fmt(recent.away)}`);
  }

  if (h2h?.length) {
    lines.push(`\n## Head to head (last ${Math.min(h2h.length, 6)})`);
    h2h.slice(-6).forEach((g) => lines.push(`${String(g.date).slice(0, 10)} ${g.home} ${g.score} ${g.away}`));
  }

  if (market) {
    lines.push(`\n## Bookmaker market (vig removed, median of ${market.bookmakerCount} book(s))`);
    if (market.moneyline) {
      lines.push(
        `Match winner: ${Object.entries(market.moneyline.probs)
          .map(([k, v]) => `${k} ${pc(v)} @ ${market.moneyline.odds[k]}`)
          .join(' | ')} (overround ${market.moneyline.overround})`
      );
    }
    Object.entries(market.totals || {}).slice(0, 4).forEach(([line, t]) => {
      lines.push(`Total ${line}: over ${pc(t.probs?.over)} @ ${t.odds.over} | under ${pc(t.probs?.under)} @ ${t.odds.under}`);
    });
    if (market.btts) lines.push(`Both teams score: yes ${pc(market.btts.probs?.yes)} @ ${market.btts.odds.yes}`);
  } else {
    lines.push(`\n## Bookmaker market`);
    lines.push(`No odds available for this game — the model has no market anchor, so be more cautious.`);
  }

  lines.push(`\n## Requested risk profile: ${profile.label.toUpperCase()}`);
  lines.push(profile.description);
  lines.push(
    `The user wants ${
      risk === 'easy'
        ? 'the highest-probability selection, accepting a small return.'
        : risk === 'aggressive'
          ? 'the best value even if the probability is below 50% — reward matters more than hit-rate.'
          : 'the best balance of probability and price.'
    }`
  );

  lines.push(`\n## Candidate bets (already filtered for this risk profile)`);
  lines.push(
    `Columns: id | selection | blended probability | fair odds | book odds | edge vs market | model EV`
  );
  candidates.forEach((c) => {
    lines.push(
      `- ${c.id} | ${c.market}: ${c.selection} | ${pc(c.probability)} | ${c.fairOdds ?? '-'} | ${
        c.marketOdds ?? 'no price'
      } | ${pp(c.edge)} | ${c.evModel != null ? `${(c.evModel * 100).toFixed(1)}%` : 'n/a'}${
        c.disagreement === 'extreme' ? '  <<< EXTREME model/market disagreement — treat as a model warning, not value' : ''
      }`
    );
  });

  lines.push(`\n## Your task`);
  lines.push(
    `Pick the single best candidate for the ${profile.label} profile and set bestPickId to its exact id ` +
      `from the list above. Give 2-4 reasoning bullets citing the actual numbers, 1-3 key factors, and ` +
      `1-3 risks. Set confidence 0-100 for that pick. Return adjustments only where you have a concrete, ` +
      `data-grounded reason (otherwise an empty array).`
  );

  return lines.join('\n');
}
