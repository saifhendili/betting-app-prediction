/**
 * Test preload: replaces global fetch with canned API-SPORTS + Gemini responses
 * so the whole pipeline (routes → adapters → model → odds → AI) can be exercised
 * without burning real quota.
 *
 * Usage:  node --import ./test/mock-upstream.mjs src/index.js
 */
process.env.SPORTS_API_KEYS = process.env.SPORTS_API_KEYS || 'mockA,mockB,mockC';
process.env.GEMINI_API_KEYS = process.env.GEMINI_API_KEYS || 'gmockA,gmockB';
// isolate from the real cache so tests never read or write production data
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/betting_mocktest';
process.env.PORT = process.env.PORT || '5055';
// The admin-token gate is a hosting concern; tests exercise the settings API
// directly, so it defaults to off — but an explicit value still wins, so the
// gate itself can be tested.
if (process.env.ADMIN_TOKEN === undefined) process.env.ADMIN_TOKEN = '';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const wrap = (response) => ({ get: 'mock', parameters: {}, errors: [], results: Array.isArray(response) ? response.length : 1, response });

const now = Date.now();
const iso = (mins) => new Date(now + mins * 60000).toISOString();

const FOOTBALL_FIXTURE = (id, kickoffMins, status = { short: 'NS', long: 'Not Started' }) => ({
  fixture: { id, date: iso(kickoffMins), timestamp: Math.floor((now + kickoffMins * 60000) / 1000), status, venue: { name: 'Emirates Stadium' } },
  league: { id: 39, name: 'Premier League', country: 'England', logo: null, season: 2026, round: 'Regular Season - 9' },
  teams: { home: { id: 42, name: 'Arsenal', logo: null }, away: { id: 45, name: 'Everton', logo: null } },
  goals: { home: status.short === 'NS' ? null : 1, away: status.short === 'NS' ? null : 0 },
  score: {},
});

const BASKET_GAME = (id, kickoffMins, status = { short: 'NS', long: 'Not Started' }) => ({
  id, date: iso(kickoffMins), time: '20:00', timestamp: 0, timezone: 'UTC', stage: null, status,
  league: { id: 12, name: 'NBA', type: 'League', season: '2026-2027', logo: null },
  country: { name: 'USA' },
  teams: { home: { id: 139, name: 'Boston Celtics', logo: null }, away: { id: 141, name: 'Miami Heat', logo: null } },
  scores: { home: { total: status.short === 'NS' ? null : 58 }, away: { total: status.short === 'NS' ? null : 52 } },
});

const HOCKEY_GAME = (id, kickoffMins, status = { short: 'NS', long: 'Not Started' }) => ({
  id, date: iso(kickoffMins), time: '19:00', timestamp: 0, status,
  league: { id: 57, name: 'NHL', season: 2026, logo: null },
  country: { name: 'USA' },
  teams: { home: { id: 700, name: 'Boston Bruins', logo: null }, away: { id: 711, name: 'Toronto Maple Leafs', logo: null } },
  scores: { home: status.short === 'NS' ? null : 2, away: status.short === 'NS' ? null : 1 },
  periods: {},
});

const FOOTBALL_STATS = (teamId) => {
  const strong = String(teamId) === '42';
  return {
    league: { id: 39, name: 'Premier League', season: 2026 },
    team: { id: teamId, name: strong ? 'Arsenal' : 'Everton' },
    form: strong ? 'WWDWW' : 'LDLWL',
    fixtures: {
      played: { home: 5, away: 4, total: 9 },
      wins: { home: strong ? 4 : 1, away: strong ? 3 : 1, total: strong ? 7 : 2 },
      draws: { home: 1, away: 0, total: strong ? 1 : 3 },
      loses: { home: 0, away: strong ? 1 : 3, total: strong ? 1 : 4 },
    },
    goals: {
      for: { average: { home: strong ? '2.40' : '1.20', away: strong ? '1.75' : '0.75', total: strong ? '2.11' : '1.00' } },
      against: { average: { home: strong ? '0.60' : '1.60', away: strong ? '1.00' : '2.25', total: strong ? '0.78' : '1.89' } },
    },
    clean_sheet: { total: strong ? 5 : 1 },
    failed_to_score: { total: strong ? 1 : 4 },
  };
};

const BASKET_STATS = (teamId) => {
  const strong = String(teamId) === '139';
  return {
    league: { id: 12, name: 'NBA', season: '2026-2027' },
    team: { id: teamId },
    games: {
      played: { home: 10, away: 9, all: 19 },
      wins: { home: { total: strong ? 8 : 4 }, away: { total: strong ? 6 : 3 }, all: { total: strong ? 14 : 7 } },
      loses: { all: { total: strong ? 5 : 12 } },
    },
    points: {
      for: { average: { home: strong ? '121.4' : '110.2', away: strong ? '115.8' : '106.4', all: strong ? '118.7' : '108.4' } },
      against: { average: { home: strong ? '108.2' : '116.9', away: strong ? '112.5' : '120.1', all: strong ? '110.3' : '118.4' } },
    },
  };
};

const HOCKEY_STATS = (teamId) => {
  const strong = String(teamId) === '700';
  return {
    league: { id: 57, name: 'NHL', season: 2026 },
    team: { id: teamId },
    games: {
      played: { home: 8, away: 8, all: 16 },
      wins: { home: { total: strong ? 6 : 3 }, away: { total: strong ? 5 : 3 }, all: { total: strong ? 11 : 6 } },
      loses: { all: { total: strong ? 5 : 10 } },
    },
    goals: {
      for: { average: { home: strong ? '3.60' : '2.80', away: strong ? '3.10' : '2.50', all: strong ? '3.35' : '2.65' } },
      against: { average: { home: strong ? '2.40' : '3.20', away: strong ? '2.90' : '3.60', all: strong ? '2.65' : '3.40' } },
    },
  };
};

const ODDS = (sport) => [
  {
    bookmakers: [
      {
        id: 8, name: 'Bet365',
        bets: sport === 'football'
          ? [
              { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.45' }, { value: 'Draw', odd: '4.50' }, { value: 'Away', odd: '7.00' }] },
              { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: '1.72' }, { value: 'Under 2.5', odd: '2.10' }, { value: 'Over 1.5', odd: '1.22' }, { value: 'Under 1.5', odd: '4.20' }, { value: 'Over 3.5', odd: '2.90' }, { value: 'Under 3.5', odd: '1.42' }] },
              { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.95' }, { value: 'No', odd: '1.85' }] },
              { id: 12, name: 'Double Chance', values: [{ value: 'Home/Draw', odd: '1.10' }, { value: 'Home/Away', odd: '1.22' }, { value: 'Draw/Away', odd: '2.70' }] },
              { id: 4, name: 'Asian Handicap', values: [{ value: 'Home -1.5', odd: '2.05' }, { value: 'Away +1.5', odd: '1.80' }] },
            ]
          : [
              { id: 1, name: 'Home/Away', values: [{ value: 'Home', odd: '1.55' }, { value: 'Away', odd: '2.50' }] },
              { id: 2, name: 'Over/Under', values: sport === 'basketball'
                  ? [{ value: 'Over 228.5', odd: '1.90' }, { value: 'Under 228.5', odd: '1.90' }, { value: 'Over 224.5', odd: '1.65' }, { value: 'Under 224.5', odd: '2.25' }]
                  : [{ value: 'Over 5.5', odd: '1.85' }, { value: 'Under 5.5', odd: '1.95' }, { value: 'Over 6.5', odd: '2.60' }, { value: 'Under 6.5', odd: '1.50' }] },
              { id: 3, name: 'Handicap', values: sport === 'basketball'
                  ? [{ value: 'Home -5.5', odd: '1.90' }, { value: 'Away +5.5', odd: '1.90' }]
                  : [{ value: 'Home -1.5', odd: '2.40' }, { value: 'Away +1.5', odd: '1.58' }] },
            ],
      },
      {
        id: 2, name: 'Pinnacle',
        bets: sport === 'football'
          ? [{ id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.48' }, { value: 'Draw', odd: '4.60' }, { value: 'Away', odd: '7.20' }] }]
          : [{ id: 1, name: 'Home/Away', values: [{ value: 'Home', odd: '1.58' }, { value: 'Away', odd: '2.55' }] }],
      },
    ],
  },
];

const GEMINI_REPLY = {
  candidates: [
    {
      finishReason: 'STOP',
      content: {
        parts: [
          {
            text: JSON.stringify({
              verdict: 'strong',
              bestPickId: '__FIRST__',
              headline: 'Model and market agree on the home side; the total is the cleaner angle.',
              confidence: 71,
              reasoning: [
                'Expected goals favour the home team heavily on the back of a 2.40 home scoring rate against a side conceding 2.25 away.',
                'The de-vigged market and the model sit within 3pp of each other on this selection, which is the agreement you want.',
                'The projected total sits comfortably above the line rather than hugging it.',
              ],
              keyFactors: ['Strong home scoring rate', 'Away defence leaking on the road'],
              risks: [
                'Only nine matches of season data, so the scoring rates are still noisy.',
                'No lineup or injury information is available to this model.',
              ],
              adjustments: [{ pickId: '__FIRST__', deltaPercentagePoints: 2.5, why: 'Home form run is stronger than the season average suggests.' }],
            }),
          },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 1180, candidatesTokenCount: 260 },
};

const realFetch = globalThis.fetch;
let lastCandidateIds = [];

globalThis.fetch = async (input, init) => {
  // fetch accepts a string, a URL instance or a Request — normalise all three
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  // ── Gemini ──
  if (url.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(init.body);
    const prompt = body.contents[0].parts[0].text;
    // echo back a real candidate id from the prompt so bestPickId resolves
    const ids = [...prompt.matchAll(/^- ([^\s|]+) \|/gm)].map((m) => m[1]);
    lastCandidateIds = ids;
    const reply = JSON.parse(JSON.stringify(GEMINI_REPLY));
    reply.candidates[0].content.parts[0].text = reply.candidates[0].content.parts[0].text.replaceAll(
      '__FIRST__',
      ids[1] || ids[0] || 'unknown'
    );
    return json(reply);
  }

  // ── API-SPORTS ──
  if (url.includes('api-sports.io')) {
    const u = new URL(url);
    const sport = url.includes('v3.football') ? 'football' : url.includes('v1.basketball') ? 'basketball' : 'hockey';
    const p = u.pathname;
    const q = u.searchParams;

    const mk = { football: FOOTBALL_FIXTURE, basketball: BASKET_GAME, hockey: HOCKEY_GAME }[sport];

    if (p.endsWith('/fixtures') || p.endsWith('/games')) {
      if (q.get('id')) {
        const live = q.get('id') === '999';
        return json(wrap([mk(Number(q.get('id')), live ? -30 : 150, live
          ? { short: sport === 'football' ? '2H' : sport === 'basketball' ? 'Q3' : 'P2', long: 'Second half', elapsed: 63 }
          : undefined)]));
      }
      if (q.get('live') === 'all') {
        return json(wrap([mk(999, -30, { short: sport === 'football' ? '2H' : sport === 'basketball' ? 'Q3' : 'P2', long: 'Second half', elapsed: 63 })]));
      }
      if (q.get('team')) {
        return json(wrap([mk(500, -4000, { short: 'FT', long: 'Match Finished' }), mk(501, -8000, { short: 'FT', long: 'Match Finished' })]));
      }
      if (q.get('h2h')) {
        return json(wrap([mk(600, -20000, { short: 'FT', long: 'Match Finished' }), mk(601, -40000, { short: 'FT', long: 'Match Finished' })]));
      }
      // date listing: a few games at staggered kick-offs
      return json(wrap([mk(101, 35), mk(102, 110), mk(103, 300), mk(104, 700)]));
    }

    if (p.includes('headtohead') || p.endsWith('/games/h2h')) {
      return json(wrap([mk(600, -20000, { short: 'FT', long: 'Match Finished' })]));
    }

    if (p.includes('statistics')) {
      const teamId = q.get('team');
      const stats = { football: FOOTBALL_STATS, basketball: BASKET_STATS, hockey: HOCKEY_STATS }[sport];
      return json(wrap(stats(teamId)));
    }

    if (p.endsWith('/odds')) return json(wrap(ODDS(sport)));

    return json(wrap([]));
  }

  return realFetch(input, init);
};

console.log('[mock] upstream fetch patched (api-sports + gemini)');
