import { pct, odds, confidenceBand } from '../format.js';

export function TopPicks({ data, loading, error, onSelectGame, onClose }) {
  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-head">
        <h2>⭐ Best bets on this slate</h2>
        <button type="button" className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={onClose}>
          Close
        </button>
      </div>
      <div className="panel-body">
        {loading ? (
          <div className="loading-box">
            <span className="spinner" />
            <p style={{ marginTop: 10, fontSize: 13 }}>Analysing the top games — one model run and one AI call each…</p>
          </div>
        ) : error ? (
          <div className="error-box"><strong>Could not build the shortlist</strong>{error}</div>
        ) : !data?.predictions?.length ? (
          <div className="empty"><p>No games in this window could be analysed.</p></div>
        ) : (
          <div className="top-picks-grid">
            {data.predictions.map((p) => {
              const pick = p.topPick;
              if (!pick) return null;
              return (
                <button type="button" className="tp-card" key={`${p.sport}:${p.gameId}`} onClick={() => onSelectGame(p)}>
                  <div className={`tp-conf ${confidenceBand(p.confidence)}`}>{p.confidence}</div>
                  <div className="tp-body">
                    <div className="match">{p.game.teams.home.name} vs {p.game.teams.away.name}</div>
                    <div className="sel">{pick.market}: <strong style={{ color: 'var(--text)' }}>{pick.selection}</strong> · {pct(pick.probability)}</div>
                  </div>
                  <div className="tp-odds">
                    <strong>{odds(pick.marketOdds || pick.fairOdds)}</strong>
                    <span>{pick.marketOdds ? 'book' : 'fair'}</span>
                  </div>
                </button>
              );
            })}
            {data.failures?.length ? (
              <div className="degraded-note">
                {data.failures.length} game(s) could not be analysed (usually an upstream quota limit).
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
