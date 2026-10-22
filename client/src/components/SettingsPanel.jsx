import { useEffect, useState } from 'react';
import { api, adminToken } from '../api.js';

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

/** One key per line is the easiest thing to paste into. */
const toLines = (text) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function SettingsPanel({ onClose, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [geminiText, setGeminiText] = useState('');
  const [sportsText, setSportsText] = useState('');
  const [model, setModel] = useState(GEMINI_MODELS[0]);
  const [provider, setProvider] = useState('apisports');
  const [dataSource, setDataSource] = useState('espn');

  const [token, setToken] = useState(() => adminToken.get());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.settings()
      .then((s) => {
        setSettings(s);
        setModel(s.gemini.model || GEMINI_MODELS[0]);
        setProvider(s.sports.provider || 'apisports');
        setDataSource(s.sports.dataSource?.configured || 'espn');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    adminToken.set(token.trim());
    try {
      const patch = { geminiModel: model, sportsProvider: provider, dataSource };
      // An untouched box means "leave what is already stored alone".
      if (geminiText.trim()) patch.geminiKeys = toLines(geminiText);
      if (sportsText.trim()) patch.sportsKeys = toLines(sportsText);

      const res = await api.saveSettings(patch);
      setSettings(res.settings);
      setGeminiText('');
      setSportsText('');
      setMessage(res.warning || 'Saved. The keys are live immediately — no restart needed.');
      onSaved?.(res.settings);
    } catch (err) {
      setError(
        err.needsToken
          ? 'This instance requires an admin token. Paste the ADMIN_TOKEN from the server environment below and save again.'
          : err.message
      );
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    adminToken.set(token.trim());
    try {
      // test what is typed if anything is, otherwise what is already saved
      const payload = {};
      if (geminiText.trim()) payload.geminiKeys = toLines(geminiText);
      if (sportsText.trim()) payload.sportsKeys = toLines(sportsText);
      setTestResult(await api.testKeys(payload));
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  const geminiCount = toLines(geminiText).length;
  const sportsCount = toLines(sportsText).length;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="panel-head">
          <h2>⚙️ Settings</h2>
          <button type="button" className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="loading-box"><span className="spinner" /></div>
          ) : (
            <>
              {error ? <div className="error-box"><strong>Problem</strong>{error}</div> : null}
              {message ? <div className="ok-box">{message}</div> : null}

              {/* ── Gemini ───────────────────────────────────────────── */}
              <div className="field">
                <label htmlFor="gemini-keys">
                  Gemini API keys
                  <span className="field-hint">
                    {settings?.gemini.count
                      ? `${settings.gemini.count} saved (${settings.gemini.source}): ${settings.gemini.masked.join(', ')}`
                      : 'none saved yet'}
                  </span>
                </label>
                <textarea
                  id="gemini-keys"
                  rows={4}
                  spellCheck="false"
                  autoComplete="off"
                  placeholder={
                    settings?.gemini.count
                      ? 'Paste new keys to replace the saved ones — one per line…'
                      : 'AIzaSy...key1\nAIzaSy...key2\nAIzaSy...key3'
                  }
                  value={geminiText}
                  onChange={(e) => setGeminiText(e.target.value)}
                />
                <p className="field-note">
                  One key per line (commas work too). Free keys:{' '}
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>.
                  Add several — they are rotated automatically, so N keys give roughly N× the free daily quota.
                  {geminiCount ? <strong> {geminiCount} key{geminiCount === 1 ? '' : 's'} entered.</strong> : null}
                </p>
              </div>

              <div className="field">
                <label htmlFor="gemini-model">Gemini model</label>
                <select id="gemini-model" value={model} onChange={(e) => setModel(e.target.value)}>
                  {GEMINI_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <p className="field-note">
                  The others are used automatically as fallbacks if this one is overloaded.
                </p>
              </div>

              {/* ── Sports data ──────────────────────────────────────── */}
              <div className="field">
                <label htmlFor="data-source">
                  Sports data source
                  <span className="field-hint">
                    {settings?.sports.dataSource?.fellBack
                      ? `using ESPN — ${settings.sports.dataSource.reason}`
                      : `currently using ${settings?.sports.dataSource?.effective === 'apisports' ? 'API-SPORTS' : 'ESPN'}`}
                  </span>
                </label>
                <select id="data-source" value={dataSource} onChange={(e) => setDataSource(e.target.value)}>
                  <option value="espn">ESPN — free, no key, no daily limit, live in-play odds</option>
                  <option value="apisports">API-SPORTS — needs a key (100 requests/day on the free plan)</option>
                </select>
                <p className="field-note">
                  ESPN covers football worldwide, NBA/WNBA/college basketball and the NHL, with DraftKings prices on
                  every fixture a bookmaker offers. If API-SPORTS is selected but its key is missing, used up or
                  suspended, the app switches to ESPN on its own.
                </p>
              </div>

              <div className="field">
                <label htmlFor="sports-keys">
                  API-SPORTS keys <span style={{ fontWeight: 500, color: 'var(--text-faint)' }}>(only for the API-SPORTS source)</span>
                  <span className="field-hint">
                    {settings?.sports.count
                      ? `${settings.sports.count} saved (${settings.sports.source}): ${settings.sports.masked.join(', ')}`
                      : 'none saved yet — required for games to load'}
                  </span>
                </label>
                <textarea
                  id="sports-keys"
                  rows={3}
                  spellCheck="false"
                  autoComplete="off"
                  placeholder={
                    settings?.sports.count
                      ? 'Paste new keys to replace the saved ones — one per line…'
                      : 'your_api_sports_key'
                  }
                  value={sportsText}
                  onChange={(e) => setSportsText(e.target.value)}
                />
                <p className="field-note">
                  Free key:{' '}
                  <a href="https://dashboard.api-football.com/register" target="_blank" rel="noreferrer">dashboard.api-football.com/register</a>
                  {' '}— one account covers football, basketball and hockey at 100 requests/day each.
                  {sportsCount ? <strong> {sportsCount} key{sportsCount === 1 ? '' : 's'} entered.</strong> : null}
                </p>
              </div>

              <div className="field">
                <label htmlFor="provider">Sports key source</label>
                <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="apisports">api-sports.io (direct)</option>
                  <option value="rapidapi">RapidAPI</option>
                </select>
                <p className="field-note">Pick RapidAPI only if you got the key through RapidAPI rather than api-sports.io.</p>
              </div>

              {/* ── Test results ─────────────────────────────────────── */}
              {testResult ? (
                <div className="field">
                  <label>
                    Key test
                    <span className="field-hint">
                      Gemini {testResult.summary.geminiOk}/{testResult.summary.geminiTotal} ok ·
                      {' '}Sports {testResult.summary.sportsOk}/{testResult.summary.sportsTotal} ok
                    </span>
                  </label>
                  <div className="test-results">
                    {[...testResult.gemini, ...testResult.sports].map((r) => (
                      <div className={`test-row ${r.ok ? 'ok' : 'bad'}`} key={r.label}>
                        <span className="tr-icon">{r.ok ? '✓' : '✕'}</span>
                        <span className="tr-label">{r.label}</span>
                        <span className="tr-key">{r.key}</span>
                        <span className="tr-detail">{r.detail}</span>
                      </div>
                    ))}
                    {!testResult.gemini.length && !testResult.sports.length ? (
                      <p className="field-note">No keys to test yet — paste some above first.</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {settings?.requiresToken ? (
                <div className="field">
                  <label htmlFor="admin-token">
                    Admin token
                    <span className="field-hint">
                      {token ? 'stored in this browser' : 'required to change settings on this instance'}
                    </span>
                  </label>
                  <input
                    id="admin-token"
                    type="password"
                    spellCheck="false"
                    autoComplete="off"
                    placeholder="paste ADMIN_TOKEN…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <p className="field-note">
                    This instance is hosted, so changing API keys needs the <code>ADMIN_TOKEN</code> set in the
                    server environment. It is remembered in this browser only — never sent anywhere except this
                    app&apos;s own API.
                  </p>
                </div>
              ) : null}

              <p className="field-note" style={{ marginTop: 4 }}>
                Keys are stored in your local MongoDB ({settings?.persistence}). They are never sent anywhere
                except to Google and the sports provider, and the app only ever shows them masked once saved.
              </p>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={test} disabled={testing || loading}>
            {testing ? <><span className="spinner" /> Testing…</> : 'Test keys'}
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={saving || loading}>
            {saving ? <><span className="spinner" /> Saving…</> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
