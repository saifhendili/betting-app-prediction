import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Segmented } from './components/Controls.jsx';
import { GameList } from './components/GameList.jsx';
import { PredictionPanel } from './components/PredictionPanel.jsx';
import { SuggestedBets } from './components/SuggestedBets.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { SavedPanel } from './components/SavedPanel.jsx';
import { savedStore, useSaved, pickKey, rehydrateRun, uiPrefs } from './storage.js';
import { SUGGEST_SCOPES } from './format.js';

const SPORTS = [
  { key: 'football', label: 'Football', icon: '⚽' },
  { key: 'basketball', label: 'Basketball', icon: '🏀' },
  { key: 'hockey', label: 'Hockey', icon: '🏒' },
  { key: 'all', label: 'All', icon: '🌐', title: 'All three sports (uses 3× the upstream quota)' },
];

const WINDOWS = [
  { key: 'live', label: 'Live', icon: '🔴' },
  { key: '1h', label: '1h' },
  { key: '3h', label: '3h' },
  { key: '6h', label: '6h' },
  { key: '12h', label: '12h' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'all', label: 'Both days' },
];

const RISKS = [
  { key: 'easy', label: 'Easy', icon: '🛡️', title: 'High probability, small returns' },
  { key: 'mid', label: 'Mid', icon: '⚖️', title: 'Balanced probability and price' },
  { key: 'aggressive', label: 'Aggressive', icon: '🔥', title: 'Value hunting, big payouts' },
];

const LIVE_REFRESH_MS = 45_000;

export default function App() {
  const [sport, setSport] = useState('football');
  const [window_, setWindow] = useState('today');
  const [risk, setRisk] = useState('mid');

  const [slate, setSlate] = useState(null);
  const [slateLoading, setSlateLoading] = useState(true);
  const [slateError, setSlateError] = useState(null);

  const [selected, setSelected] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [predLoading, setPredLoading] = useState(false);
  const [predError, setPredError] = useState(null);

  const [health, setHealth] = useState(null);
  const [riskMeta, setRiskMeta] = useState([]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  // The last suggestions run comes back after a refresh: it is restored from
  // localStorage (a snapshot — the panel says so) rather than re-run, which
  // would cost a Gemini call per game.
  const [topSavedAt, setTopSavedAt] = useState(() => savedStore.load().runs[0]?.savedAt || null);
  const saved = useSaved();
  const savedKeys = useMemo(() => new Set(saved.picks.map((p) => p.key)), [saved.picks]);
  const [topCount, setTopCount] = useState(() => uiPrefs.get('suggestCount', 10));
  // which games Suggested bets looks at — independent of the list's "When" tab
  const [suggestScope, setSuggestScope] = useState(() => {
    const saved = uiPrefs.get('suggestScope', 'mix');
    return SUGGEST_SCOPES.some((s) => s.key === saved) ? saved : 'mix';
  });
  const [topOpen, setTopOpen] = useState(
    () => Boolean(savedStore.load().runs[0]) && uiPrefs.get('suggestionsOpen', true)
  );
  const [topData, setTopData] = useState(() => rehydrateRun(savedStore.load().runs[0]));
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState(null);

  useEffect(() => {
    uiPrefs.set('suggestionsOpen', topOpen);
  }, [topOpen]);
  useEffect(() => {
    uiPrefs.set('suggestScope', suggestScope);
    uiPrefs.set('suggestCount', topCount);
  }, [suggestScope, topCount]);

  const slateAbort = useRef(null);
  const predAbort = useRef(null);

  // ── meta + health ────────────────────────────────────────────────────────
  useEffect(() => {
    api.meta().then((m) => setRiskMeta(m.risks || [])).catch(() => {});
    const poll = () => api.health().then(setHealth).catch(() => setHealth(null));
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── the slate ────────────────────────────────────────────────────────────
  const loadSlate = useCallback(async () => {
    slateAbort.current?.abort();
    const ac = new AbortController();
    slateAbort.current = ac;
    setSlateLoading(true);
    setSlateError(null);
    try {
      const data = await api.games({ sport, window: window_ }, { signal: ac.signal });
      setSlate(data);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setSlateError(err.message);
        setSlate(null);
      }
    } finally {
      if (!ac.signal.aborted) setSlateLoading(false);
    }
  }, [sport, window_]);

  useEffect(() => { loadSlate(); }, [loadSlate]);

  // keep live scores moving without hammering the quota
  useEffect(() => {
    const hasLive = window_ === 'live' || (slate?.counts?.live || 0) > 0;
    if (!hasLive) return undefined;
    const id = setInterval(loadSlate, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [window_, slate?.counts?.live, loadSlate]);

  // ── prediction ───────────────────────────────────────────────────────────
  const loadPrediction = useCallback(async (game, { refresh = false } = {}) => {
    if (!game) return;
    predAbort.current?.abort();
    const ac = new AbortController();
    predAbort.current = ac;
    setPredLoading(true);
    setPredError(null);
    try {
      const data = await api.prediction(
        { sport: game.sport, id: game.id, risk, refresh },
        { signal: ac.signal }
      );
      setPrediction(data);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setPredError(err.message);
        setPrediction(null);
      }
    } finally {
      if (!ac.signal.aborted) setPredLoading(false);
    }
  }, [risk]);

  const onSelect = useCallback((game) => {
    setSelected(game);
    loadPrediction(game);
  }, [loadPrediction]);

  // changing the risk profile re-predicts the open game
  useEffect(() => {
    if (selected) loadPrediction(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [risk]);

  // ── suggested bets ───────────────────────────────────────────────────────
  // Live games are always included (the server reserves them up to half the
  // slots); on the Live tab the suggestions are live-only.
  const loadTopPicks = useCallback(async () => {
    setTopOpen(true);
    setTopLoading(true);
    setTopError(null);
    setTopSavedAt(null);
    try {
      const scope = SUGGEST_SCOPES.find((s) => s.key === suggestScope) || SUGGEST_SCOPES[1];
      const data = await api.topPicks({ sport, window: scope.window, live: scope.live, risk, count: topCount });
      data.scope = scope.key;
      // every run is kept in this browser automatically
      if (data?.predictions?.length) {
        const run = savedStore.addRun({ sport, window: scope.key, risk, data });
        setTopSavedAt(run.savedAt);
        setTopData({ ...data, runId: run.id });
      } else {
        setTopData(data);
      }
    } catch (err) {
      setTopError(err.message);
    } finally {
      setTopLoading(false);
    }
  }, [sport, suggestScope, risk, topCount]);

  /** ☆ / ★ on any pick: save it, or remove it if it is already saved. */
  const toggleSavePick = useCallback((prediction, pick) => {
    const key = pickKey(prediction.game.gameKey, pick.id);
    if (savedKeys.has(key)) savedStore.removePick(key);
    else savedStore.addPick({ prediction, pick });
  }, [savedKeys]);

  /** Put a previous run back into the Suggested bets panel. */
  const loadRun = useCallback((runId) => {
    const run = savedStore.load().runs.find((r) => r.id === runId);
    if (!run) return;
    setTopData(rehydrateRun(run));
    setTopSavedAt(run.savedAt);
    setTopError(null);
    setTopLoading(false);
    setTopOpen(true);
  }, []);

  /** Re-open a game from the saved list — fetches a fresh prediction for it. */
  const openSavedGame = useCallback((g) => {
    const game = {
      sport: g.sport,
      id: g.id,
      gameKey: g.gameKey,
      kickoff: g.kickoff,
      state: g.state,
      score: g.score || { home: null, away: null },
      status: { short: g.statusShort, elapsed: g.minute },
      league: { name: g.league },
      teams: { home: { name: g.home, logo: g.homeLogo }, away: { name: g.away, logo: g.awayLogo } },
    };
    setSelected(game);
    loadPrediction(game);
  }, [loadPrediction]);

  const onSettingsSaved = useCallback(() => {
    api.health().then(setHealth).catch(() => {});
    api.meta().then((m) => setRiskMeta(m.risks || [])).catch(() => {});
    loadSlate();
    if (selected) loadPrediction(selected, { refresh: true });
  }, [loadSlate, loadPrediction, selected]);

  const activeRisk = useMemo(() => riskMeta.find((r) => r.key === risk), [riskMeta, risk]);

  const windowOptions = useMemo(
    () => WINDOWS.map((w) => (w.key === 'live' ? { ...w, count: slate?.counts?.live } : w)),
    [slate?.counts?.live]
  );

  const noKeys = health && health.sportsData !== 'ok';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">🎯</div>
          <div>
            <h1>Betting Oracle</h1>
            <p>Poisson &amp; market model · reasoned by Gemini</p>
          </div>
        </div>
        <div className="status-chips">
          <button
            type="button"
            className={`chip clickable ${health?.sportsData === 'ok' ? 'ok' : 'bad'}`}
            onClick={() => setSettingsOpen(true)}
            title={health?.dataSource?.reason || health?.sportsData || 'sports data status'}
          >
            <span className="dot" />
            {health?.dataSource?.effective === 'apisports' ? 'API-SPORTS' : 'ESPN'}
          </button>
          <button
            type="button"
            className={`chip clickable ${health?.ai === 'ok' ? 'ok' : 'warn'}`}
            onClick={() => setSettingsOpen(true)}
            title={health?.ai || 'AI status'}
          >
            <span className="dot" />AI
          </button>
          <span className={`chip ${health?.mongo === 'connected' ? 'ok' : 'warn'}`} title={health?.mongo}>
            <span className="dot" />db
          </span>
          <button type="button" className="btn saved-btn" onClick={() => setSavedOpen(true)} title="Saved bets and suggestion history">
            📁 Saved <span className="count">{saved.picks.length}</span>
          </button>
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings — API keys">
            ⚙️
          </button>
        </div>
      </header>

      <div className="controls">
        <div className="control-row">
          <span className="control-label">Sport</span>
          <Segmented options={SPORTS} value={sport} onChange={setSport} />
        </div>
        <div className="control-row">
          <span className="control-label">When</span>
          <Segmented options={windowOptions} value={window_} onChange={setWindow} />
        </div>
        <div className="control-row">
          <span className="control-label">Risk</span>
          <Segmented options={RISKS} value={risk} onChange={setRisk} prefix="risk-" />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <label htmlFor="suggest-scope" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              bet on
            </label>
            <select
              id="suggest-scope"
              className="mini-select"
              value={suggestScope}
              onChange={(e) => setSuggestScope(e.target.value)}
              title="Which games Suggested bets analyses"
            >
              {SUGGEST_SCOPES.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <select
              id="top-count"
              className="mini-select"
              value={topCount}
              onChange={(e) => setTopCount(Number(e.target.value))}
              title="How many games to analyse"
            >
              {[5, 10, 15, 20, 25].map((n) => (
                <option key={n} value={n}>{n} games</option>
              ))}
            </select>
            <button type="button" className="btn primary" onClick={loadTopPicks}>
              💡 Suggested bets
            </button>
          </div>
        </div>
        {activeRisk ? <p className="risk-note">{activeRisk.description}</p> : null}
      </div>

      {noKeys ? (
        <div className="error-box">
          <strong>Sports data unavailable</strong>
          {health.sportsData === 'no key configured' ? (
            <>
              No sports API key yet. Open{' '}
              <button type="button" className="btn ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setSettingsOpen(true)}>
                ⚙️ Settings
              </button>{' '}
              and paste a free key from <code>dashboard.api-football.com/register</code> — 100 requests/day for
              each sport, and it applies without a restart.
            </>
          ) : (
            <>
              All sports API keys are currently rate-limited. Add more keys in{' '}
              <button type="button" className="btn ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setSettingsOpen(true)}>
                ⚙️ Settings
              </button>{' '}
              (they rotate automatically) or wait for the daily reset.
            </>
          )}
        </div>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel onClose={() => setSettingsOpen(false)} onSaved={onSettingsSaved} />
      ) : null}

      {savedOpen ? (
        <SavedPanel onClose={() => setSavedOpen(false)} onOpenGame={openSavedGame} onShowRun={loadRun} />
      ) : null}

      {topOpen ? (
        <SuggestedBets
          data={topData}
          loading={topLoading}
          error={topError}
          savedAt={topSavedAt}
          runs={saved.runs}
          onLoadRun={loadRun}
          onRerun={loadTopPicks}
          savedKeys={savedKeys}
          onToggleSave={toggleSavePick}
          onClose={() => setTopOpen(false)}
          onSelectGame={(p) => {
            setSelected(p.game);
            // a restored snapshot has no model detail — fetch a fresh analysis
            if (p.restored) {
              loadPrediction(p.game);
              return;
            }
            setPrediction(p);
            setPredError(null);
          }}
        />
      ) : null}

      <div className="layout">
        <section className="panel">
          <div className="panel-head">
            <h2>{slate?.window?.label || 'Games'}</h2>
            <span className="muted">
              {slateLoading ? <span className="spinner" /> : null}
              {slate ? `${slate.counts.total} games · ${slate.counts.live} live` : ''}
            </span>
          </div>
          <div className="panel-body panel-scroll">
            {slateError ? (
              <div className="error-box"><strong>Could not load games</strong>{slateError}</div>
            ) : slateLoading && !slate ? (
              Array.from({ length: 6 }).map((_, i) => <div className="skeleton skeleton-game" key={i} />)
            ) : !slate?.games?.length ? (
              <div className="empty">
                <div className="icon">📅</div>
                <h3>No games in this window</h3>
                <p>
                  {window_ === 'live'
                    ? 'Nothing is being played right now. Try “Today” or a time window.'
                    : 'Try a wider window, another sport, or tomorrow.'}
                </p>
              </div>
            ) : (
              <GameList games={slate.games} selectedKey={selected?.gameKey} onSelect={onSelect} />
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Prediction</h2>
            {prediction ? <span className="muted">{prediction.riskProfile.label}</span> : null}
          </div>
          <div className="panel-scroll">
            <PredictionPanel
              savedKeys={savedKeys}
              onToggleSave={toggleSavePick}
              prediction={prediction}
              loading={predLoading}
              error={predError}
              onRefresh={() => loadPrediction(selected, { refresh: true })}
            />
          </div>
        </section>
      </div>

      <p className="footer-note">
        <strong>How this works:</strong> season and recent-form scoring rates feed a Poisson model (football,
        hockey) or a normal scoring model (basketball). Bookmaker odds are de-vigged and fused with the model,
        then Gemini re-ranks the shortlist for your risk profile and writes the reasoning. Probabilities are
        estimates, not certainties — the bookmaker margin means no model wins long term.{' '}
        <strong>Bet only what you can afford to lose.</strong>
      </p>
    </div>
  );
}
