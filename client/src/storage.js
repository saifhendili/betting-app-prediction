import { useEffect, useState } from 'react';

/**
 * Saved results, kept in this browser's localStorage.
 *
 *   runs  — every "Suggested bets" run, saved automatically
 *   picks — individual bets you saved with the 💾 button
 *
 * Only a condensed snapshot is stored (teams, score at the time, the picks and
 * their prices), never the full prediction payload, so hundreds of entries
 * fit comfortably inside the browser's ~5 MB budget.
 */
const KEY = 'bettingOracle.saved.v1';
const EVENT = 'bettingOracle:saved';
const MAX_RUNS = 30;
const MAX_PICKS = 200;

const empty = () => ({ runs: [], picks: [] });

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    return {
      runs: Array.isArray(data?.runs) ? data.runs : [],
      picks: Array.isArray(data?.picks) ? data.picks : [],
    };
  } catch {
    return empty();
  }
}

function write(data) {
  const attempt = (d) => {
    localStorage.setItem(KEY, JSON.stringify(d));
    window.dispatchEvent(new Event(EVENT));
  };
  try {
    attempt(data);
    return true;
  } catch {
    // storage full: shed the oldest half of the history once, then give up
    try {
      attempt({ ...data, runs: data.runs.slice(0, Math.ceil(data.runs.length / 2)) });
      return true;
    } catch {
      return false;
    }
  }
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function condensePick(pk) {
  if (!pk) return null;
  return {
    id: pk.id,
    market: pk.market,
    selection: pk.selection,
    probability: pk.probability,
    fairOdds: pk.fairOdds,
    marketOdds: pk.marketOdds ?? null,
    edge: pk.edge ?? null,
    confidence: pk.confidence,
    stars: pk.stars,
  };
}

/** The game as it was when saved — the score of a live game will move on. */
function condenseGame(g) {
  return {
    gameKey: g.gameKey,
    sport: g.sport,
    id: g.id,
    home: g.teams.home.name,
    away: g.teams.away.name,
    homeLogo: g.teams.home.logo || null,
    awayLogo: g.teams.away.logo || null,
    league: g.league.name,
    kickoff: g.kickoff,
    state: g.state,
    score: g.score,
    minute: g.status?.elapsed ?? null,
    statusShort: g.status?.short ?? null,
  };
}

export function condensePrediction(p) {
  return {
    game: condenseGame(p.game),
    risk: p.risk,
    confidence: p.confidence,
    verdict: p.verdict,
    headline: p.headline,
    marketKind: p.dataSource?.marketKind || null,
    provider: p.dataSource?.provider || null,
    best: condensePick(p.topPick),
    options: (p.picks || []).slice(1).map(condensePick),
    reasoning: (p.ai?.reasoning || []).slice(0, 3),
  };
}

export const pickKey = (gameKey, pickId) => `${gameKey}|${pickId}`;

export const savedStore = {
  load: read,

  /** Save a whole suggestions run. Returns the stored run. */
  addRun({ sport, window, risk, data }) {
    const d = read();
    const run = {
      id: uid(),
      savedAt: new Date().toISOString(),
      sport,
      window,
      risk,
      liveCount: data.liveCount ?? 0,
      items: (data.predictions || []).map(condensePrediction),
    };
    d.runs = [run, ...d.runs].slice(0, MAX_RUNS);
    write(d);
    return run;
  },

  removeRun(id) {
    const d = read();
    d.runs = d.runs.filter((r) => r.id !== id);
    write(d);
  },

  /** Save one pick. Saving the same pick again just refreshes it. */
  addPick({ prediction, pick }) {
    const d = read();
    const game = condenseGame(prediction.game);
    const key = pickKey(game.gameKey, pick.id);
    const entry = {
      id: uid(),
      key,
      savedAt: new Date().toISOString(),
      risk: prediction.risk,
      confidence: prediction.confidence,
      marketKind: prediction.dataSource?.marketKind || null,
      game,
      pick: condensePick(pick),
    };
    d.picks = [entry, ...d.picks.filter((p) => p.key !== key)].slice(0, MAX_PICKS);
    write(d);
    return entry;
  },

  removePick(key) {
    const d = read();
    d.picks = d.picks.filter((p) => p.key !== key && p.id !== key);
    write(d);
  },

  clear() {
    write(empty());
  },
};

/** Live view of the store; updates on saves here and in other tabs. */
export function useSaved() {
  const [data, setData] = useState(read);
  useEffect(() => {
    const refresh = () => setData(read());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return data;
}
