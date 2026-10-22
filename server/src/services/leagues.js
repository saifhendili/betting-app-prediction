/**
 * A football slate can be 300+ games across every division on earth, so games
 * are ranked by competition importance before they reach the UI. Higher tier
 * first, then kickoff time.
 */
/**
 * Several competition names are ambiguous across countries — "Premier League"
 * is England's top flight but also Malta's and Egypt's, and "Serie A" is both
 * Italy's and Brazil's. A pattern may therefore require a country, so the
 * Maltese Premier League no longer outranks the Champions League.
 */
const TIERS = [
  {
    tier: 1,
    patterns: [
      { name: /^premier league$/i, country: /^england$/i },
      { name: /^la ?liga$/i, country: /^spain$/i },
      { name: /^serie a$/i, country: /^italy$/i },
      { name: /^bundesliga$/i, country: /^germany$/i },
      { name: /^ligue 1$/i, country: /^france$/i },
      { name: /^uefa champions league$/i },
      { name: /^uefa europa league$/i },
      { name: /^uefa europa conference league$|^uefa conference league$/i },
      { name: /world cup/i },
      { name: /^euro(pean)? championship$/i },
      { name: /libertadores/i },
      { name: /copa america/i },
      { name: /^nba$/i },
      { name: /^nhl$/i },
      { name: /euroleague/i },
    ],
  },
  {
    tier: 2,
    patterns: [
      { name: /champions league/i },        // continental variants (CAF, AFC, …)
      { name: /^eredivisie$/i },
      { name: /^primeira liga$/i },
      { name: /sudamericana/i },
      { name: /^saudi pro league$/i },
      { name: /^championship$/i, country: /^england$/i },
      { name: /^super ?lig$/i, country: /^t(ü|u)rkiye$|^turkey$/i },
      { name: /^(jupiler )?pro league$/i, country: /^belgium$/i },
      { name: /^liga mx$/i },
      { name: /^major league soccer$|^mls$/i },
      { name: /brasileir/i },
      { name: /^serie a$/i, country: /^brazil$/i },
      { name: /^primera divisi(o|ó)n$/i },
      { name: /^premiership$/i, country: /^scotland$/i },
      { name: /^copa del rey$/i },
      { name: /^fa cup$/i, country: /^england$/i },
      { name: /^coppa italia$/i },
      { name: /^dfb[- ]?pokal$/i },
      { name: /nations league/i },
      { name: /^acb$|^liga endesa$/i },
      { name: /^ncaa/i },
      { name: /^(lnb|bbl|vtb|lega a)$/i },
      { name: /^khl$/i },
      { name: /^(liiga|shl|del|extraliga)$/i },
      { name: /^wnba$/i },
      { name: /eurocup/i },
    ],
  },
  {
    tier: 3,
    patterns: [
      { name: /^2\.?\s?bundesliga$/i },
      { name: /^serie b$/i },
      { name: /^ligue 2$/i },
      { name: /^segunda/i },
      { name: /^league one$/i },
      { name: /^league two$/i },
      { name: /^premier league$/i },        // any other country's top flight
      { name: /^serie a$/i },
      { name: /^super ?lig$/i },
    ],
  },
];

const cache = new Map();

export function leagueTier(name = '', country = '') {
  const key = `${name}|${country}`;
  if (cache.has(key)) return cache.get(key);
  let tier = 5;
  for (const group of TIERS) {
    const match = group.patterns.some(
      (p) => p.name.test(name) && (!p.country || p.country.test(String(country || '')))
    );
    if (match) {
      tier = group.tier;
      break;
    }
  }
  // youth / reserve / friendly competitions are never the headline
  if (/u1[5-9]|u2[0-3]|youth|reserve|women|friendly|club friendl/i.test(name)) tier = Math.max(tier, 6);
  cache.set(key, tier);
  return tier;
}

/** Live first, then by competition importance, then by kickoff. */
export function sortGames(games) {
  const stateRank = { live: 0, upcoming: 1, finished: 2 };
  return [...games].sort((a, b) => {
    const s = (stateRank[a.state] ?? 3) - (stateRank[b.state] ?? 3);
    if (s) return s;
    if (a.state === 'upcoming') {
      const t = new Date(a.kickoff || 0) - new Date(b.kickoff || 0);
      const ta = leagueTier(a.league.name, a.league.country);
      const tb = leagueTier(b.league.name, b.league.country);
      // within the same ~3h slot, show the bigger competition first
      if (Math.abs(t) < 3 * 3600 * 1000 && ta !== tb) return ta - tb;
      if (t) return t;
      return ta - tb;
    }
    const ta = leagueTier(a.league.name, a.league.country);
    const tb = leagueTier(b.league.name, b.league.country);
    if (ta !== tb) return ta - tb;
    return new Date(a.kickoff || 0) - new Date(b.kickoff || 0);
  });
}

export function annotateTier(games) {
  return games.map((g) => ({ ...g, league: { ...g.league, tier: leagueTier(g.league.name, g.league.country) } }));
}
