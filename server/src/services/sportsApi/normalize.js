/** Status buckets shared by all three sports. */
const LIVE_SHORT = new Set([
  '1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INTR', 'SUSP',          // football
  'Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT1', 'BT2', 'BT3', 'HL',            // basketball
  'P1', 'P2', 'P3', 'PT', 'BT', 'AOT', 'AP',                          // hockey
]);
const FINISHED_SHORT = new Set(['FT', 'AET', 'PEN', 'AOT', 'AP', 'POST', 'ABD', 'CANC', 'AWD', 'WO']);

export function statusBucket(short, long = '') {
  const s = String(short || '').toUpperCase();
  const l = String(long || '').toLowerCase();
  if (s === 'NS' || /not started|scheduled/.test(l)) return 'upcoming';
  if (FINISHED_SHORT.has(s) || /finished|final|ended|cancel|postpon|abandon|after/.test(l)) return 'finished';
  if (LIVE_SHORT.has(s) || /quarter|period|half|play|live|progress|break|overtime/.test(l)) return 'live';
  return 'upcoming';
}

/**
 * The single game shape the rest of the app (and the UI) speaks.
 * Every sport adapter must emit exactly this.
 */
export function makeGame({
  sport,
  id,
  kickoff,
  statusShort,
  statusLong,
  elapsed = null,
  league,
  home,
  away,
  scoreHome = null,
  scoreAway = null,
  venue = null,
  round = null,
  // Feeds that report their own lifecycle state (ESPN: pre/in/post) pass it in
  // rather than having it guessed from status codes.
  stateOverride = null,
  // Minutes played on the sport's regulation clock, when the feed can compute
  // it exactly. The in-play model prefers this over phase-based guesses.
  elapsedMinutes = null,
  source = 'apisports',
  // Whether a bookmaker price exists. ESPN says so in the listing; for
  // API-SPORTS it is unknown until odds are fetched, hence null.
  hasOdds = null,
}) {
  const state = stateOverride || statusBucket(statusShort, statusLong);
  return {
    sport,
    source,
    id: String(id),
    gameKey: `${sport}:${id}`,
    kickoff: kickoff ? new Date(kickoff).toISOString() : null,
    startsInMinutes: kickoff ? Math.round((new Date(kickoff).getTime() - Date.now()) / 60000) : null,
    state,
    status: {
      short: statusShort || null,
      long: statusLong || null,
      elapsed,
      elapsedMinutes: Number.isFinite(elapsedMinutes) ? elapsedMinutes : null,
    },
    league: {
      id: league?.id != null ? String(league.id) : null,
      name: league?.name || 'Unknown league',
      country: league?.country || null,
      logo: league?.logo || null,
      season: league?.season ?? null,
      round: round || null,
    },
    teams: {
      home: { id: home?.id != null ? String(home.id) : null, name: home?.name || 'Home', logo: home?.logo || null },
      away: { id: away?.id != null ? String(away.id) : null, name: away?.name || 'Away', logo: away?.logo || null },
    },
    score: { home: scoreHome, away: scoreAway },
    venue,
    hasOdds,
  };
}
