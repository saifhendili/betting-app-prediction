import { Router } from 'express';
import { listGames, getGame, windowList } from '../services/gamesService.js';
import { SPORTS } from '../config/env.js';

export const gamesRouter = Router();

const assertSport = (sport) => {
  if (sport !== 'all' && !SPORTS.includes(sport)) {
    const err = new Error(`Unknown sport "${sport}". Use: ${SPORTS.join(', ')} or all`);
    err.status = 400;
    throw err;
  }
};

gamesRouter.get('/', async (req, res, next) => {
  try {
    const sport = String(req.query.sport || 'football').toLowerCase();
    assertSport(sport);
    const data = await listGames({
      sport,
      window: String(req.query.window || 'today').toLowerCase(),
      includeFinished: String(req.query.finished || '') === 'true',
      league: req.query.league,
      limit: req.query.limit,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

gamesRouter.get('/windows', (_req, res) => res.json({ windows: windowList() }));

gamesRouter.get('/:sport/:id', async (req, res, next) => {
  try {
    const sport = String(req.params.sport).toLowerCase();
    assertSport(sport);
    res.json({ game: await getGame({ sport, gameId: req.params.id }) });
  } catch (err) {
    next(err);
  }
});
