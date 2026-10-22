import { useState } from 'react';
import { pct, odds, clockTime, dayLabel, confidenceBand } from '../format.js';
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

  return (
    <div className={`sg-card ${live ? 'live' : ''}`}>
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

      {live && prediction.dataSource?.liveOdds ? (
        <div className="sg-foot">Priced against {prediction.dataSource.provider || 'the bookmaker'}&apos;s live in-play odds</div>
      ) : null}
    </div>
  );
}

export function SuggestedBets({ data, loading, error, savedAt, savedKeys, onToggleSave, onSelectGame, onClose }) {
  const live = (data?.predictions || []).filter((p) => p.game.state === 'live');
  const upcoming = (data?.predictions || []).filter((p) => p.game.state !== 'live');

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-head">
        <h2>💡 Suggested bets</h2>
        {data && !loading ? (
          <span className="muted" style={{ marginLeft: 8 }}>
            {data.predictions.length} games · {live.length} live
            {savedAt ? ` · saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        ) : null}
        <button type="button" className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={onClose}>
          Close
        </button>
      </div>
      <div className="panel-body">
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
            <p>No priced games in this window. Try a wider window or another sport.</p>
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
                {data.skippedUnpriced ? `${data.skippedUnpriced} games skipped because no bookmaker prices them. ` : ''}
                {data.failures?.length ? `${data.failures.length} game(s) could not be analysed.` : ''}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
