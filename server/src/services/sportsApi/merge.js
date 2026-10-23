/**
 * Merging fixtures from two feeds that name teams differently — ESPN says
 * "AFC Bournemouth" and "Lillestrøm", TheSportsDB "Bournemouth" and
 * "Lillestrom". Two entries are the same fixture when kick-off is within three
 * hours and BOTH sides share a distinctive word. Generic words ("FC",
 * "Real", "United", "City") don't count, or every Real-vs-United game would
 * collide.
 */
const GENERIC = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'ssc', 'as', 'fk', 'sk', 'bk', 'if', 'hc', 'bc', 'kk', 'club', 'de', 'del', 'la',
  'the', 'cd', 'ud', 'sd', 'rc', 'sv', 'vfb', 'vfl', 'tsg', 'calcio', 'football', 'futbol', 'futebol', 'real',
  'city', 'united', 'sporting', 'athletic', 'atletico', 'deportivo', 'inter', 'saint', 'santa', 'union',
  'nacional', 'national', 'sport', 'sports', 'team', 'women', 'ladies', 'reserves', 'youth', 'academy',
  'u17', 'u18', 'u19', 'u20', 'u21', 'u23', 'ii', 'iii',
]);

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/ß/g, 'ss')
    .toLowerCase();

export function teamTokens(name) {
  return new Set(
    fold(name)
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !GENERIC.has(t))
  );
}

const squash = (name) => fold(name).replace(/[^a-z0-9]+/g, '');

function sameTeam(a, b) {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  // "Athletic Club", "Sporting CP": nothing distinctive left — compare whole names
  if (!ta.size || !tb.size) {
    const sa = squash(a);
    const sb = squash(b);
    return Boolean(sa && sb && (sa === sb || sa.startsWith(sb) || sb.startsWith(sa)));
  }
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

export function sameFixture(a, b) {
  if (a.sport !== b.sport) return false;
  const ka = Date.parse(a.kickoff || '');
  const kb = Date.parse(b.kickoff || '');
  if (!Number.isFinite(ka) || !Number.isFinite(kb) || Math.abs(ka - kb) > 3 * 3600e3) return false;
  return sameTeam(a.teams.home.name, b.teams.home.name) && sameTeam(a.teams.away.name, b.teams.away.name);
}

/** `primary` wins every collision; `extra` only contributes fixtures it lacks. */
export function mergeGames(primary, extra) {
  const out = [...primary];
  for (const g of extra) {
    if (!primary.some((p) => sameFixture(p, g))) out.push(g);
  }
  return out;
}
