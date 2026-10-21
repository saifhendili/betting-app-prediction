import { pct, pp, odds, clockTime, dayLabel, confidenceBand, verdictLabel } from '../format.js';
import { ConfidenceRing, ProbBar } from './Controls.jsx';

function Pick({ pick, marketDerived }) {
  return (
    <div className={`pick ${pick.isTopPick ? 'top' : ''}`}>
      <div className="pick-head">
        <div style={{ minWidth: 0 }}>
          <div className="market">{pick.market}</div>
          <div className="selection">{pick.selection}</div>
        </div>
        {pick.isTopPick ? <span className="badge-top">BEST</span> : <span className="rank">#{pick.rank}</span>}
      </div>

      <ProbBar value={pick.probability} />

      <div className="stat-grid">
        <div className="stat">
          <span>Probability</span>
          <strong>{pct(pick.probability, 1)}</strong>
        </div>
        <div className="stat">
          <span>Fair odds</span>
          <strong>{odds(pick.fairOdds)}</strong>
        </div>
        <div className="stat">
          <span>Book odds</span>
          <strong>{pick.marketOdds ? odds(pick.marketOdds) : '—'}</strong>
        </div>
        <div className="stat">
          <span>{marketDerived ? 'Edge (n/a)' : 'Edge'}</span>
          <strong className={marketDerived ? '' : pick.edge > 0.005 ? 'pos' : pick.edge < -0.005 ? 'neg' : ''}>
            {marketDerived ? '—' : pp(pick.edge)}
          </strong>
        </div>
        <div className="stat">
          <span>Rating</span>
          <strong className="stars">{'★'.repeat(pick.stars)}{'☆'.repeat(5 - pick.stars)}</strong>
        </div>
      </div>

      {pick.disagreement === 'extreme' && !marketDerived ? (
        <div className="degraded-note">
          The model disagrees with the bookmaker by more than 15pp here. That usually means the model is
          missing information (an absence, a stale line, a meaningless fixture) rather than a real edge.
        </div>
      ) : null}

      {pick.aiAdjusted ? (
        <div className="degraded-note">
          AI adjusted this probability by {pp(pick.aiDelta)}.
        </div>
      ) : null}
    </div>
  );
}

function ThreeWay({ prediction }) {
  const { model, market, game, sport } = { ...prediction, sport: prediction.sport };
  const isFootball = sport === 'football';
  const mk = market?.moneyline?.probs;
  const isLive = Boolean(model.live);
  const cells = [
    { label: game.teams.home.name, model: model.outcome.home, market: mk?.home },
    ...(isFootball ? [{ label: 'Draw', model: model.outcome.draw, market: mk?.draw }] : []),
    { label: game.teams.away.name, model: model.outcome.away, market: mk?.away },
  ];
  return (
    <>
      <div className={`three-way ${isFootball ? '' : 'two'}`}>
        {cells.map((c) => (
          <div key={c.label}>
            <span>{c.label}</span>
            <strong>{pct(c.model)}</strong>
            {Number.isFinite(c.market) ? (
              <span className="vs-market">{isLive ? 'pre-match' : 'book'} {pct(c.market)}</span>
            ) : null}
          </div>
        ))}
      </div>
      {isLive && mk ? (
        <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '8px 0 0', lineHeight: 1.5 }}>
          The large figure is the live probability given the current score with {model.live.remainingMinutes}&apos;
          left. The smaller one is the <em>pre-match</em> price, shown for reference — the two are expected to
          differ once goals have been scored.
        </p>
      ) : null}
    </>
  );
}

export function PredictionPanel({ prediction, loading, error, onRefresh }) {
  if (loading) {
    return (
      <div className="loading-box">
        <span className="spinner" />
        <p style={{ marginTop: 12, fontSize: 13 }}>
          Running the model, pulling odds and asking Gemini…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel-body">
        <div className="error-box">
          <strong>Prediction failed</strong>
          {error}
        </div>
        <button type="button" className="btn" onClick={onRefresh}>Try again</button>
      </div>
    );
  }

  if (!prediction) {
    return (
      <div className="empty">
        <div className="icon">🎯</div>
        <h3>Pick a game</h3>
        <p>Select any fixture on the left to get a prediction: a statistical model fused with the bookmaker market, then reasoned over by Gemini for your chosen risk level.</p>
      </div>
    );
  }

  const { game, model, market, ai, picks, confidence, headline, verdict, engine, riskProfile, context } = prediction;
  const band = confidenceBand(confidence);
  const unit = prediction.sport === 'basketball' ? 'pts' : 'goals';

  return (
    <>
      <div className="pred-hero">
        <div className="pred-match">
          <h3>{game.teams.home.name} vs {game.teams.away.name}</h3>
        </div>
        <div className="pred-meta">
          <span>{game.league.name}</span>
          <span>·</span>
          <span>{dayLabel(game.kickoff)} {clockTime(game.kickoff)}</span>
          {game.state === 'live' ? (
            <>
              <span>·</span>
              <span className="live-badge"><span className="pulse" />LIVE {game.score.home}–{game.score.away}</span>
            </>
          ) : null}
          <span>·</span>
          <span style={{ fontFamily: 'var(--mono)' }}>{riskProfile.label}</span>
        </div>

        <div className="hero-grid">
          <ConfidenceRing value={confidence} band={band} />
          <div>
            <div className="headline">{headline}</div>
            <div className="verdict-row">
              <span className={`verdict ${verdict}`}>{verdictLabel[verdict] || verdict}</span>
              <span className="chip">{engine}</span>
              {ai?.model ? <span className="chip">{ai.model}</span> : null}
              <span className={`chip ${context.dataQuality.level === 'high' ? 'ok' : context.dataQuality.level === 'none' || context.dataQuality.level === 'partial' || context.dataQuality.level === 'priors-only' ? 'bad' : 'warn'}`}>
                data: {context.dataQuality.level}
              </span>
              {context.oddsAvailable ? (
                <span className="chip ok">odds: {context.bookmakers.length} book{context.bookmakers.length === 1 ? '' : 's'}</span>
              ) : (
                <span className="chip warn">no odds</span>
              )}
            </div>
            {prediction.dataSource?.note ? (
              <div className={prediction.dataSource.model === 'priors-only' ? 'error-box' : 'degraded-note'} style={{ marginTop: 10 }}>
                <strong style={{ display: 'block', marginBottom: 3 }}>{prediction.dataSource.label}</strong>
                {prediction.dataSource.note}
              </div>
            ) : null}

            {prediction.degraded ? (
              <div className="degraded-note">
                {prediction.degraded === 'no-gemini-key'
                  ? 'No Gemini key configured — this is a pure statistical prediction. Add one in Settings (gear icon) for AI reasoning.'
                  : `AI layer unavailable (${prediction.degradedReason || prediction.degraded}) — showing the statistical model only.`}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {model.live ? (
        <div className="section">
          <h4>In-play adjustment</h4>
          <div className="kv">
            <div>
              <span>Score</span>
              <strong>{model.live.currentScore.home}–{model.live.currentScore.away}</strong>
            </div>
            <div>
              <span>Played</span>
              <strong>{model.live.elapsedMinutes}&apos;</strong>
            </div>
            <div>
              <span>Remaining</span>
              <strong>{model.live.remainingMinutes}&apos;</strong>
            </div>
            <div>
              <span>Still to come</span>
              <strong>{model.live.remainingExpected.home} – {model.live.remainingExpected.away}</strong>
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '9px 0 0', lineHeight: 1.5 }}>
            Every probability below is rebased on the current scoreline and the time left, not on
            pre-match numbers.
          </p>
        </div>
      ) : null}

      <div className="section">
        <h4>Recommended picks — {riskProfile.label.toLowerCase()} profile</h4>
        {prediction.dataSource?.marketIsStale ? (
          <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '-2px 0 10px', lineHeight: 1.5 }}>
            Book prices below are the <em>pre-match</em> ones — they do not know the current score, so they are
            shown for reference only and no edge is calculated against them.
          </p>
        ) : null}
        {picks.map((p) => (
          <Pick
            key={p.id}
            pick={p}
            marketDerived={prediction.dataSource?.canFindValue === false || prediction.dataSource?.marketIsStale}
          />
        ))}
      </div>

      {ai?.reasoning?.length ? (
        <div className="section">
          <h4>Why</h4>
          <ul className="bullets">
            {ai.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      ) : null}

      {ai?.risks?.length ? (
        <div className="section">
          <h4>Risks</h4>
          <ul className="bullets risk">
            {ai.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="section">
        <h4>{prediction.dataSource?.canFindValue === false ? 'Implied probabilities' : 'Model vs market'}</h4>
        <ThreeWay prediction={prediction} />
        <div className="kv" style={{ marginTop: 10 }}>
          <div>
            <span>Expected {unit}</span>
            <strong>{model.expected.home} – {model.expected.away}</strong>
          </div>
          <div>
            <span>Projected total</span>
            <strong>{model.expected.total}</strong>
          </div>
          {model.form?.home || model.form?.away ? (
            <div>
              <span>Form H / A</span>
              <strong style={{ fontSize: 12 }}>{model.form.home || '—'} / {model.form.away || '—'}</strong>
            </div>
          ) : null}
          {market?.moneyline?.overround ? (
            <div>
              <span>Book margin</span>
              <strong>{((market.moneyline.overround - 1) * 100).toFixed(1)}%</strong>
            </div>
          ) : null}
        </div>
      </div>

      {model.correctScores?.length ? (
        <div className="section">
          <h4>Most likely scorelines</h4>
          <div className="three-way" style={{ gridTemplateColumns: `repeat(${model.correctScores.length}, 1fr)` }}>
            {model.correctScores.map((s) => (
              <div key={s.score}>
                <span>{s.score}</span>
                <strong>{pct(s.p, 1)}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {context.h2h?.length ? (
        <div className="section">
          <h4>Head to head</h4>
          <table className="h2h">
            <tbody>
              {context.h2h.slice().reverse().map((g, i) => (
                <tr key={i}>
                  <td style={{ width: 62, fontFamily: 'var(--mono)', fontSize: 11 }}>{String(g.date).slice(0, 10)}</td>
                  <td style={{ textAlign: 'right' }}>{g.home}</td>
                  <td className="score" style={{ width: 54 }}>{g.score}</td>
                  <td>{g.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="section" style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        <button type="button" className="btn" onClick={onRefresh}>↻ Regenerate</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          Generated {new Date(prediction.generatedAt).toLocaleTimeString()}
          {prediction.cached ? ' · from cache' : ''}
        </span>
      </div>
    </>
  );
}
