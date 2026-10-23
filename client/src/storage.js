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
    // false = no bookmaker prices it; kept so a restored run still says so
    hasOdds: g.hasOdds !== false,
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
  addRun({ sport, window, risk, gamesMode = 'auto', data }) {
    const d = read();
    const run = {
      id: uid(),
      savedAt: new Date().toISOString(),
      sport,
      window,
      risk,
      gamesMode,
      liveCount: data.liveCount ?? 0,
      unpricedCount: data.unpricedCount ?? 0,
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

/**
 * Turn a saved run back into the shape the Suggested bets panel renders.
 *
 * It is a snapshot: scores, minutes and prices are as they were when the run
 * was made, and there is no model/market detail — "Full analysis" therefore
 * fetches a fresh prediction instead of reusing this object.
 */
function rehydrateItem(it) {
  const g = it.game;
  const best = it.best ? { ...it.best, isTopPick: true, rank: 1 } : null;
  const options = (it.options || []).filter(Boolean).map((o, i) => ({ ...o, isTopPick: false, rank: i + 2 }));
  return {
    restored: true,
    sport: g.sport,
    gameId: g.id,
    risk: it.risk,
    confidence: it.confidence,
    verdict: it.verdict,
    headline: it.headline,
    topPick: best,
    picks: best ? [best, ...options] : options,
    dataSource: { marketKind: it.marketKind, liveOdds: it.marketKind === 'inplay', provider: it.provider },
    ai: it.reasoning?.length ? { reasoning: it.reasoning } : null,
    game: {
      sport: g.sport,
      id: g.id,
      gameKey: g.gameKey,
      kickoff: g.kickoff,
      state: g.state,
      score: g.score || { home: null, away: null },
      status: { short: g.statusShort, elapsed: g.minute },
      league: { name: g.league },
      teams: { home: { name: g.home, logo: g.homeLogo }, away: { name: g.away, logo: g.awayLogo } },
      // runs saved before this flag existed only ever held priced games
      hasOdds: g.hasOdds !== false,
    },
  };
}

export function rehydrateRun(run) {
  if (!run) return null;
  return {
    restored: true,
    runId: run.id,
    savedAt: run.savedAt,
    sport: run.sport,
    window: run.window,
    risk: run.risk,
    liveCount: run.liveCount ?? 0,
    unpricedCount: run.unpricedCount ?? 0,
    gamesMode: run.gamesMode || 'auto',
    scope: run.window,
    requested: run.items.length,
    failures: [],
    skippedUnpriced: 0,
    predictions: run.items.map(rehydrateItem),
  };
}

/** Small per-browser UI preferences (which panels were open). */
const PREFS = 'bettingOracle.ui.v1';
export const uiPrefs = {
  get(name, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(PREFS) || '{}')[name];
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(name, value) {
    try {
      const all = JSON.parse(localStorage.getItem(PREFS) || '{}');
      all[name] = value;
      localStorage.setItem(PREFS, JSON.stringify(all));
    } catch {
      /* private browsing: preferences just won't persist */
    }
  },
};
