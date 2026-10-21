import { clockTime, dayLabel, countdown } from '../format.js';

function GameRow({ game, selected, onSelect }) {
  const live = game.state === 'live';
  const finished = game.state === 'finished';
  const { home, away } = game.score;
  const hasScore = home !== null && home !== undefined;
  const homeWinning = hasScore && home > away;
  const awayWinning = hasScore && away > home;

  return (
    <button type="button" className="game" aria-current={selected} onClick={() => onSelect(game)}>
      <div className={`game-time ${live ? 'live' : ''}`}>
        {live ? (
          <>
            {game.status.elapsed ? `${game.status.elapsed}` : 'LIVE'}
            <small>{game.status.short}</small>
          </>
        ) : (
          <>
            {clockTime(game.kickoff)}
            <small>{finished ? game.status.short : dayLabel(game.kickoff)}</small>
          </>
        )}
      </div>

      <div className="game-teams">
        <div className={`team-row ${homeWinning ? 'winning' : awayWinning ? 'losing' : ''}`}>
          {game.teams.home.logo ? <img src={game.teams.home.logo} alt="" loading="lazy" /> : null}
          <span className="name">{game.teams.home.name}</span>
          {hasScore ? <span className="score">{home}</span> : null}
        </div>
        <div className={`team-row ${awayWinning ? 'winning' : homeWinning ? 'losing' : ''}`}>
          {game.teams.away.logo ? <img src={game.teams.away.logo} alt="" loading="lazy" /> : null}
          <span className="name">{game.teams.away.name}</span>
          {hasScore ? <span className="score">{away}</span> : null}
        </div>
      </div>

      <div style={{ textAlign: 'right' }}>
        {live ? (
          <span className="live-badge"><span className="pulse" />LIVE</span>
        ) : finished ? (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>FT</span>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
            {countdown(game.startsInMinutes)}
          </span>
        )}
      </div>
    </button>
  );
}

export function GameList({ games, selectedKey, onSelect, groupByLeague = true }) {
  if (!groupByLeague) {
    return games.map((g) => (
      <GameRow key={g.gameKey} game={g} selected={g.gameKey === selectedKey} onSelect={onSelect} />
    ));
  }

  // keep the incoming (already ranked) order while grouping
  const groups = [];
  const index = new Map();
  games.forEach((g) => {
    const key = `${g.sport}|${g.league.name}`;
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ key, league: g.league, sport: g.sport, games: [] });
    }
    groups[index.get(key)].games.push(g);
  });

  const icon = { football: '⚽', basketball: '🏀', hockey: '🏒' };

  return groups.map((grp) => (
    <div className="league-group" key={grp.key}>
      <div className="league-head">
        {grp.league.logo ? <img src={grp.league.logo} alt="" loading="lazy" /> : <span>{icon[grp.sport]}</span>}
        <span>{grp.league.name}</span>
        {grp.league.country ? <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>· {grp.league.country}</span> : null}
        {grp.league.tier <= 1 ? <span className="tier-badge">TOP</span> : null}
      </div>
      {grp.games.map((g) => (
        <GameRow key={g.gameKey} game={g} selected={g.gameKey === selectedKey} onSelect={onSelect} />
      ))}
    </div>
  ));
}
