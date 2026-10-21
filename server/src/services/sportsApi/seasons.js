/**
 * Season identifiers differ per sport on API-SPORTS:
 *   football   → starting year, e.g. 2026
 *   basketball → "2026-2027"
 *   hockey     → starting year, e.g. 2026
 * European football/hockey seasons roll over in summer; US basketball in autumn.
 */
export function currentSeason(sport, date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1..12
  if (sport === 'basketball') {
    return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
  }
  // football + hockey: a season starting in July/Sept is labelled with its first year
  return m >= 7 ? y : y - 1;
}

/** Fall back across plausible season labels when stats come back empty. */
export function seasonCandidates(sport, declaredSeason) {
  const out = [];
  if (declaredSeason !== undefined && declaredSeason !== null && declaredSeason !== '') out.push(declaredSeason);
  const cur = currentSeason(sport);
  if (!out.includes(cur)) out.push(cur);
  if (sport === 'basketball') {
    const [a, b] = String(cur).split('-').map(Number);
    const prev = `${a - 1}-${b - 1}`;
    if (!out.includes(prev)) out.push(prev);
  } else {
    const prev = Number(cur) - 1;
    if (!out.includes(prev)) out.push(prev);
  }
  return out;
}
