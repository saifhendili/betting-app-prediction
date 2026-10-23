// Same-origin: the API is served by the same process as this page, so a
// relative path is all that is ever needed — no base URL, no CORS.
const BASE = '/api';

const TOKEN_KEY = 'bettingOracle.adminToken';

/** The admin token is per-browser and only needed to change settings. */
export const adminToken = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private browsing — the token just won't persist */
    }
  },
};

async function request(path, { signal, method = 'GET', body } = {}) {
  const token = adminToken.get();
  const res = await fetch(`${BASE}${path}`, {
    signal,
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-admin-token': token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.needsToken = Boolean(payload?.needsToken);
    throw err;
  }
  return payload;
}

export const api = {
  meta: (opts) => request('/health/meta', opts),
  settings: (opts) => request('/settings', opts),
  saveSettings: (patch, opts) => request('/settings', { ...opts, method: 'PUT', body: patch }),
  testKeys: (payload, opts) => request('/settings/test', { ...opts, method: 'POST', body: payload || {} }),
  health: (opts) => request('/health', opts),
  keys: (opts) => request('/health/keys', opts),
  games: ({ sport, window, finished, league, limit = 120 }, opts) => {
    const q = new URLSearchParams({ sport, window, limit: String(limit) });
    if (finished) q.set('finished', 'true');
    if (league) q.set('league', league);
    return request(`/games?${q}`, opts);
  },
  prediction: ({ sport, id, risk, refresh }, opts) => {
    const q = new URLSearchParams({ risk });
    if (refresh) q.set('refresh', '1');
    return request(`/predictions/${sport}/${id}?${q}`, opts);
  },
  topPicks: ({ sport, window, risk, count = 8, live = true }, opts) => {
    const q = new URLSearchParams({ sport, window, risk, count: String(count), live: String(live) });
    return request(`/predictions/top?${q}`, opts);
  },
};
