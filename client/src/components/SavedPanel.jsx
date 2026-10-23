import { useState } from 'react';
import { savedStore, useSaved } from '../storage.js';
import { pct, odds, clockTime, dayLabel, scopeLabel } from '../format.js';

const when = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const gameLine = (g) => (
  <>
    {g.home} <span style={{ color: 'var(--text-faint)' }}>vs</span> {g.away}
  </>
);

/** What the game looked like when the bet was saved. */
function SavedState({ g }) {
  if (g.state === 'live') {
    return (
      <span className="live-badge" style={{ fontSize: 9.5 }}>
        LIVE {g.minute || g.statusShort} · {g.score?.home}–{g.score?.away}
      </span>
    );
  }
  return (
    <span className="sg-time">
      {dayLabel(g.kickoff)} {clockTime(g.kickoff)}
    </span>
  );
}

function SavedPick({ entry, onOpen }) {
  const { game: g, pick: p } = entry;
  return (
    <div className="saved-row">
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="sg-meta" style={{ marginBottom: 4 }}>
          <SavedState g={g} />
          <span className="sg-league">{g.league}</span>
        </div>
        <div className="saved-teams">{gameLine(g)}</div>
        <div className="saved-pick">
          <span className="sg-market">{p.market}</span> {p.selection}
        </div>
        <div className="saved-sub">
          saved {when(entry.savedAt)} · {entry.risk} profile · confidence {entry.confidence}
        </div>
      </div>
      <div className="sg-pick-nums">
        <strong>{pct(p.probability)}</strong>
        <span>{odds(p.marketOdds || p.fairOdds)}</span>
      </div>
      <div className="saved-actions">
        <button type="button" className="link-btn" onClick={() => onOpen(g)}>
          Open
        </button>
        <button type="button" className="link-btn danger" onClick={() => savedStore.removePick(entry.key)}>
          Remove
        </button>
      </div>
    </div>
  );
}

function SavedRun({ run, onOpen, onShow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="saved-run">
      <button type="button" className="saved-run-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <strong>{when(run.savedAt)}</strong>
        <span className="chip">{run.sport}</span>
        {run.window ? <span className="chip">{scopeLabel(run.window)}</span> : null}
        {run.gamesMode === 'all' ? <span className="chip">all games</span> : null}
        <span className="chip">{run.risk}</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {run.items.length} games{run.liveCount ? ` · ${run.liveCount} live` : ''}
        </span>
      </button>
      {open ? (
        <div className="saved-run-body">
          {run.items.map((it) => (
            <div className="saved-row compact" key={it.game.gameKey}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="sg-meta" style={{ marginBottom: 3 }}>
                  <SavedState g={it.game} />
                  <span className="sg-league">{it.game.league}</span>
                </div>
                <div className="saved-teams">{gameLine(it.game)}</div>
                {it.best ? (
                  <div className="saved-pick">
                    <span className="sg-market">{it.best.market}</span> {it.best.selection} ·{' '}
                    <strong>{pct(it.best.probability)}</strong> @ {odds(it.best.marketOdds || it.best.fairOdds)}
                  </div>
                ) : null}
                {it.options?.length ? (
                  <div className="saved-sub">
                    also: {it.options.map((o) => `${o.selection} (${pct(o.probability)})`).join(' · ')}
                  </div>
                ) : null}
              </div>
              <div className="saved-actions">
                <span className="tp-conf-mini">{it.confidence}</span>
                <button type="button" className="link-btn" onClick={() => onOpen(it.game)}>
                  Open
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            {onShow ? (
              <button type="button" className="link-btn" onClick={() => onShow(run.id)}>
                Show in Suggested bets →
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="link-btn danger" onClick={() => savedStore.removeRun(run.id)}>
              Delete this run
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SavedPanel({ onClose, onOpenGame, onShowRun }) {
  const { runs, picks } = useSaved();
  const [tab, setTab] = useState(picks.length || !runs.length ? 'picks' : 'runs');

  const open = (g) => {
    onOpenGame(g);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Saved">
        <div className="panel-head">
          <h2>📁 Saved</h2>
          <button type="button" className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <div className="segmented" role="tablist">
            <button type="button" aria-pressed={tab === 'picks'} onClick={() => setTab('picks')}>
              Saved bets <span className="count">{picks.length}</span>
            </button>
            <button type="button" aria-pressed={tab === 'runs'} onClick={() => setTab('runs')}>
              Suggestion history <span className="count">{runs.length}</span>
            </button>
          </div>
        </div>

        <div className="modal-body">
          {tab === 'picks' ? (
            picks.length ? (
              picks.map((e) => <SavedPick key={e.key} entry={e} onOpen={open} />)
            ) : (
              <div className="empty">
                <div className="icon">☆</div>
                <h3>No saved bets yet</h3>
                <p>Tap ☆ on any bet — in Suggested bets or in a game&apos;s analysis — to keep it here.</p>
              </div>
            )
          ) : runs.length ? (
            runs.map((r) => (
              <SavedRun
                key={r.id}
                run={r}
                onOpen={open}
                onShow={
                  onShowRun
                    ? (id) => {
                        onShowRun(id);
                        onClose();
                      }
                    : null
                }
              />
            ))
          ) : (
            <div className="empty">
              <div className="icon">💡</div>
              <h3>No suggestion runs yet</h3>
              <p>Every time you run Suggested bets, the results are saved here automatically.</p>
            </div>
          )}
        </div>

        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <span className="field-note">Stored in this browser only (localStorage).</span>
          {runs.length || picks.length ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (window.confirm('Delete all saved bets and suggestion history from this browser?')) savedStore.clear();
              }}
            >
              Clear all
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
