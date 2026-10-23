import { useState } from 'react';
import { pct, odds, clockTime, dayLabel, confidenceBand, scopeLabel } from '../format.js';
import { pickKey } from '../storage.js';

function SaveButton({ saved, onClick }) {
  return (
    <button
      type="button"
      className={`save-btn ${saved ? 'saved' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={saved ? 'Saved — click to remove' : 'Save this bet'}
      aria-pressed={saved}
    >
      {saved ? '★' : '☆'}
    </button>
  );
}

function PickLine({ pick, prediction, savedKeys, onToggleSave, best = false }) {
  const key = pickKey(prediction.game.gameKey, pick.id);
  const price = pick.marketOdds || pick.fairOdds;
  return (
    <div className={`sg-pick ${best ? 'best' : ''}`}>
      {best ? <span className="badge-top">BEST BET</span> : null}
      <div className="sg-pick-main">
        <div className="sg-market">{pick.market}</div>
        <div className="sg-selection">{pick.selection}</div>
      </div>
      <div className="sg-pick-nums">
        <strong>{pct(pick.probability)}</strong>
        <span>
          {odds(price)} {pick.marketOdds ? '' : 'fair'}
        </span>
      </div>
      <SaveButton saved={savedKeys.has(key)} onClick={() => onToggleSave(prediction, pick, key)} />
    </div>
  );
}

function SuggestionCard({ prediction, savedKeys, onToggleSave, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const { game, topPick, picks } = prediction;
  const live = game.state === 'live';
  const others = (picks || []).filter((p) => p.id !== topPick?.id);
  const noOdds = game.hasOdds === false;

  return (
    <div className={`sg-card ${live ? 'live' : ''} ${noOdds ? 'no-odds-card' : ''}`}>
      <div className="sg-head">
        <div className="sg-meta">
          {live ? (
            <span className="live-badge">
              <span className="pulse" />
              LIVE {game.status.elapsed || game.status.short} · {game.score.home}–{game.score.away}
            </span>
          ) : (
            <span className="sg-time">
              {dayLabel(game.kickoff)} {clockTime(game.kickoff)}
            </span>
          )}
          <span className="sg-league">{game.league.name}</span>
        </div>
        <div className={`tp-conf ${confidenceBand(prediction.confidence)}`} title="Confidence">
          {prediction.confidence}
        </div>
      </div>

      <div className="sg-teams">
        {game.teams.home.name} <span>vs</span> {game.teams.away.name}
      </div>

      {topPick ? (
        <PickLine pick={topPick} prediction={prediction} savedKeys={savedKeys} onToggleSave={onToggleSave} best />
      ) : (
        <p className="field-note">No pick for this risk level.</p>
      )}

      {expanded
        ? others.map((p) => (
            <PickLine key={p.id} pick={p} prediction={prediction} savedKeys={savedKeys} onToggleSave={onToggleSave} />
          ))
        : null}

      <div className="sg-actions">
        {others.length ? (
          <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide other options ▴' : `+${others.length} more bet option${others.length === 1 ? '' : 's'} ▾`}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="link-btn" onClick={() => onOpen(prediction)}>
          Full analysis →
        </button>
      </div>

      {noOdds ? (
        <div className="sg-foot muted-foot">
          No odds for this game — the prices shown are the model&apos;s fair odds from league averages, so treat
          this as a rough estimate.
        </div>
      ) : live && prediction.dataSource?.liveOdds ? (
        <div className="sg-foot">Priced against {prediction.dataSource.provider || 'the bookmaker'}&apos;s live in-play odds</div>
      ) : null}
    </div>
  );
}

const runLabel = (r) =>
  `${new Date(r.savedAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` +
  ` · ${r.sport} · ${scopeLabel(r.window)}${r.gamesMode === 'all' ? ' · all games' : ''} · ${r.risk}` +
  ` · ${r.items.length} games${r.liveCount ? ` (${r.liveCount} live)` : ''}`;

export function SuggestedBets({
  data,
  loading,
  error,
  savedAt,
  runs = [],
  onLoadRun,
  onRerun,
  savedKeys,
  onToggleSave,
  onSelectGame,
  onClose,
}) {
  const live = (data?.predictions || []).filter((p) => p.game.state === 'live');
  const upcoming = (data?.predictions || []).filter((p) => p.game.state !== 'live');
  const at = savedAt ? new Date(savedAt) : null;
  const scope = scopeLabel(data?.scope || data?.window);

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-head" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <h2>💡 Suggested bets</h2>
        {data && !loading ? (
          <span className="muted" style={{ marginLeft: 8 }}>
            {scope ? `${scope} · ` : ''}
            {data.gamesMode === 'all' ? 'all games · ' : ''}
            {data.predictions.length} games · {live.length} live
            {data.unpricedCount ? ` · ${data.unpricedCount} without odds` : ''}
            {at ? ` · ${data.restored ? 'from' : 'saved'} ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {runs.length ? (
            <select
              className="mini-select"
              aria-label="Previous suggestion runs"
              title="Load an earlier run"
              value={data?.runId && runs.some((r) => r.id === data.runId) ? data.runId : ''}
              onChange={(e) => e.target.value && onLoadRun?.(e.target.value)}
              disabled={loading}
            >
              {!data?.runId || !runs.some((r) => r.id === data.runId) ? <option value="">Previous runs…</option> : null}
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r)}
                </option>
              ))}
            </select>
          ) : null}
          {onRerun ? (
            <button type="button" className="btn" style={{ padding: '4px 10px' }} onClick={onRerun} disabled={loading}>
              ↻ Run again
            </button>
          ) : null}
          <button type="button" className="btn ghost" style={{ padding: '4px 10px' }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="panel-body">
        {data?.restored && !loading && !error ? (
          <div className="restored-note">
            Saved run from{' '}
            <strong>
              {at?.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </strong>{' '}
            ({data.sport}, {scope}, {data.risk}). Scores, minutes and prices are as they were then — <em>Full analysis</em> fetches
            a fresh one, and <em>Run again</em> builds new suggestions.
          </div>
        ) : null}
        {loading ? (
          <div className="loading-box">
            <span className="spinner" />
            <p style={{ marginTop: 10, fontSize: 13 }}>Analysing live and upcoming games…</p>
            <p style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Each game gets the model, the bookmaker&apos;s prices and a Gemini review — usually 2&ndash;4 seconds a
              game, a few at a time.
            </p>
          </div>
        ) : error ? (
          <div className="error-box">
            <strong>Could not build suggestions</strong>
            {error}
          </div>
        ) : !data?.predictions?.length ? (
          <div className="empty">
            <h3>Nothing to suggest{scope ? ` for “${scope}”` : ''}</h3>
            <p>
              {data?.gamesMode === 'all'
                ? 'No games at all in this window. Try a wider window or another sport.'
                : data?.scope === 'live'
                  ? 'No game with bookmaker prices is being played right now. Try “Live + next 12h” or an upcoming window.'
                  : 'No game with bookmaker prices in this window. Try a wider window, “Live now”, or another sport.'}
              {data?.skippedUnpriced
                ? ` ${data.skippedUnpriced} game${data.skippedUnpriced === 1 ? ' has' : 's have'} no odds — choose “All games” to include ${data.skippedUnpriced === 1 ? 'it' : 'them'}.`
                : ''}
            </p>
          </div>
        ) : (
          <>
            {live.length ? (
              <>
                <h3 className="sg-section">🔴 Live now · {live.length}</h3>
                <div className="sg-grid">
                  {live.map((p) => (
                    <SuggestionCard
                      key={p.game.gameKey}
                      prediction={p}
                      savedKeys={savedKeys}
                      onToggleSave={onToggleSave}
                      onOpen={onSelectGame}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {upcoming.length ? (
              <>
                <h3 className="sg-section">Upcoming · {upcoming.length}</h3>
                <div className="sg-grid">
                  {upcoming.map((p) => (
                    <SuggestionCard
                      key={p.game.gameKey}
                      prediction={p}
                      savedKeys={savedKeys}
                      onToggleSave={onToggleSave}
                      onOpen={onSelectGame}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {data.failures?.length || data.skippedUnpriced ? (
              <p className="field-note" style={{ marginTop: 12 }}>
                {data.skippedUnpriced
                  ? `${data.skippedUnpriced} game${data.skippedUnpriced === 1 ? '' : 's'} skipped because no bookmaker prices ${data.skippedUnpriced === 1 ? 'it' : 'them'} — choose “All games” to include ${data.skippedUnpriced === 1 ? 'it' : 'them'}. `
                  : ''}
                {data.failures?.length ? `${data.failures.length} game(s) could not be analysed.` : ''}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
