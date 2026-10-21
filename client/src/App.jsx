import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Segmented } from './components/Controls.jsx';
import { GameList } from './components/GameList.jsx';
import { PredictionPanel } from './components/PredictionPanel.jsx';
import { TopPicks } from './components/TopPicks.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';

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
  const [topOpen, setTopOpen] = useState(false);
  const [topData, setTopData] = useState(null);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState(null);

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

  // ── top picks ────────────────────────────────────────────────────────────
  const loadTopPicks = useCallback(async () => {
    setTopOpen(true);
    setTopLoading(true);
    setTopError(null);
    try {
      const data = await api.topPicks({ sport, window: window_ === 'live' ? '12h' : window_, risk, count: 5 });
      setTopData(data);
    } catch (err) {
      setTopError(err.message);
    } finally {
      setTopLoading(false);
    }
  }, [sport, window_, risk]);

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
            title={health?.sportsData || 'sports data status'}
          >
            <span className="dot" />data
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
          <button type="button" className="btn primary" onClick={loadTopPicks} style={{ marginLeft: 'auto' }}>
            ⭐ Best bets
          </button>
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

      {topOpen ? (
        <TopPicks
          data={topData}
          loading={topLoading}
          error={topError}
          onClose={() => setTopOpen(false)}
          onSelectGame={(p) => {
            setSelected(p.game);
            setPrediction(p);
            setPredError(null);
            setTopOpen(false);
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
