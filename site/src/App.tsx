import { useEffect, useMemo, useRef, useState } from 'react';
import { levels, parseLogs, sampleLogs, type LogEvent, type LogLevel } from './logs';

const activeLevels = [...levels];

function formatTime(event: LogEvent) {
  if (!event.timestamp) return `line ${event.line}`;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(event.timestamp);
}

function formatSpan(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function buildTimeline(events: LogEvent[], buckets = 28) {
  const dated = events.filter((event) => event.timestamp);
  if (dated.length === 0) return Array.from({ length: buckets }, () => ({ total: 0, severe: 0 }));
  const start = dated[0].timestamp!.getTime();
  const end = dated[dated.length - 1].timestamp!.getTime();
  const width = Math.max(1, end - start);
  const output = Array.from({ length: buckets }, () => ({ total: 0, severe: 0 }));
  for (const event of dated) {
    const index = Math.min(
      buckets - 1,
      Math.floor(((event.timestamp!.getTime() - start) / width) * buckets),
    );
    output[index].total += 1;
    if (event.level === 'error' || event.level === 'fatal') output[index].severe += 1;
  }
  return output;
}

function App() {
  const [source, setSource] = useState(() => localStorage.getItem('traceboard-source') ?? '');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [service, setService] = useState('all');
  const [correlation, setCorrelation] = useState('all');
  const [enabledLevels, setEnabledLevels] = useState<LogLevel[]>([...activeLevels]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('traceboard-theme') ?? 'light');
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseLogs(source), [source]);
  const services = useMemo(
    () => [...new Set(parsed.events.map((event) => event.service))].sort(),
    [parsed.events],
  );
  const correlations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of parsed.events) {
      if (event.correlation) counts.set(event.correlation, (counts.get(event.correlation) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [parsed.events]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return parsed.events.filter(
      (event) =>
        enabledLevels.includes(event.level) &&
        (service === 'all' || event.service === service) &&
        (correlation === 'all' || event.correlation === correlation) &&
        (!needle || JSON.stringify(event.raw).toLowerCase().includes(needle)),
    );
  }, [correlation, enabledLevels, parsed.events, query, service]);
  const selected = filtered.find((event) => event.id === selectedId) ?? filtered[0] ?? null;
  const timeline = useMemo(() => buildTimeline(filtered), [filtered]);
  const timelineMaximum = Math.max(1, ...timeline.map((bucket) => bucket.total));
  const firstTimestamp = parsed.events.find((event) => event.timestamp)?.timestamp;
  const lastTimestamp = [...parsed.events].reverse().find((event) => event.timestamp)?.timestamp;
  const span = firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

  useEffect(() => {
    localStorage.setItem('traceboard-source', source);
  }, [source]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('traceboard-theme', theme);
  }, [theme]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') setImportOpen(false);
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  function load(nextSource: string) {
    setSource(nextSource);
    setDraft('');
    setQuery('');
    setService('all');
    setCorrelation('all');
    setEnabledLevels([...activeLevels]);
    setSelectedId(null);
    setImportOpen(false);
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    load(await file.text());
    if (fileRef.current) fileRef.current.value = '';
  }

  function toggleLevel(level: LogLevel) {
    setEnabledLevels((current) =>
      current.includes(level) ? current.filter((item) => item !== level) : [...current, level],
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="wordmark">
          <span className="mark" aria-hidden="true">
            T/
          </span>
          <span>Traceboard</span>
          <span className="edition">local workspace</span>
        </div>
        <div className="top-actions">
          <span className="privacy-status">
            <span className="privacy-dot" /> Nothing leaves this browser
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
            aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}
          >
            {theme === 'light' ? '◐' : '◑'}
          </button>
        </div>
      </header>

      {parsed.events.length === 0 ? (
        <main className="welcome">
          <section className="welcome-copy">
            <p className="eyebrow">structured logs / without the noise</p>
            <h1>Find the event that changed everything.</h1>
            <p className="lede">
              Traceboard turns raw JSON logs into a quiet, inspectable timeline. Filter a service,
              follow a request, and keep every byte on your machine.
            </p>
            <div className="welcome-actions">
              <button className="primary-button" type="button" onClick={() => setImportOpen(true)}>
                Import logs
              </button>
              <button className="text-button" type="button" onClick={() => load(sampleLogs)}>
                Explore sample data →
              </button>
            </div>
            {source && parsed.rejected > 0 && (
              <p className="parse-error">No structured events found. Check the JSON or JSONL input.</p>
            )}
          </section>
          <section className="welcome-preview" aria-label="Traceboard preview">
            <div className="preview-header">
              <span>req-a72f</span>
              <span>7 events</span>
            </div>
            {[
              ['09:42:11.104', 'gateway', 'Checkout request accepted', 'info'],
              ['09:42:11.189', 'catalog', 'Inventory reserved', 'info'],
              ['09:42:11.461', 'payments', 'Provider response exceeded target', 'warn'],
              ['09:42:11.522', 'orders', 'Order committed', 'info'],
            ].map(([time, sourceName, message, level]) => (
              <div className="preview-event" key={time}>
                <span className={`level-dot level-${level}`} />
                <time>{time}</time>
                <strong>{sourceName}</strong>
                <span>{message}</span>
              </div>
            ))}
          </section>
        </main>
      ) : (
        <main className="workspace">
          <aside className="rail">
            <div className="rail-section">
              <p className="rail-label">dataset</p>
              <strong className="dataset-name">Current session</strong>
              <span className="dataset-meta">
                {parsed.events.length.toLocaleString()} events
                {parsed.rejected > 0 && ` · ${parsed.rejected} rejected`}
              </span>
              <div className="rail-actions">
                <button type="button" onClick={() => setImportOpen(true)}>
                  Replace
                </button>
                <button type="button" onClick={() => load('')}>
                  Clear
                </button>
              </div>
            </div>

            <div className="rail-section">
              <p className="rail-label">levels</p>
              <div className="level-filters">
                {activeLevels.map((level) => {
                  const count = parsed.events.filter((event) => event.level === level).length;
                  return (
                    <button
                      className={enabledLevels.includes(level) ? 'active' : ''}
                      type="button"
                      key={level}
                      onClick={() => toggleLevel(level)}
                    >
                      <span className={`level-dot level-${level}`} />
                      <span>{level}</span>
                      <span className="filter-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rail-section correlations">
              <p className="rail-label">correlations</p>
              <button
                type="button"
                className={correlation === 'all' ? 'active' : ''}
                onClick={() => setCorrelation('all')}
              >
                <span>All traces</span>
                <span>{parsed.events.length}</span>
              </button>
              {correlations.slice(0, 7).map(([id, count]) => (
                <button
                  type="button"
                  className={correlation === id ? 'active' : ''}
                  key={id}
                  onClick={() => setCorrelation(id)}
                >
                  <span>{id}</span>
                  <span>{count}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="board">
            <div className="board-header">
              <div>
                <p className="eyebrow">current view</p>
                <h1>Event stream</h1>
              </div>
              <div className="search-wrap">
                <span aria-hidden="true">⌕</span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search any field"
                  aria-label="Search all event fields"
                />
                <kbd>/</kbd>
              </div>
            </div>

            <div className="metrics">
              <div>
                <span>visible events</span>
                <strong>{filtered.length.toLocaleString()}</strong>
              </div>
              <div>
                <span>services</span>
                <strong>{services.length}</strong>
              </div>
              <div>
                <span>errors</span>
                <strong>
                  {parsed.events.filter((event) => ['error', 'fatal'].includes(event.level)).length}
                </strong>
              </div>
              <div>
                <span>time span</span>
                <strong>{formatSpan(span)}</strong>
              </div>
            </div>

            <section className="timeline-panel">
              <div className="panel-heading">
                <span>event distribution</span>
                <span>{firstTimestamp?.toLocaleTimeString()} — {lastTimestamp?.toLocaleTimeString()}</span>
              </div>
              <div className="timeline" aria-label="Event distribution over time">
                {timeline.map((bucket, index) => (
                  <span
                    className="timeline-column"
                    key={index}
                    style={{ height: `${Math.max(4, (bucket.total / timelineMaximum) * 100)}%` }}
                  >
                    {bucket.severe > 0 && <span className="timeline-severe" />}
                  </span>
                ))}
              </div>
            </section>

            <div className="stream-tools">
              <span>{filtered.length} matching events</span>
              <label>
                service
                <select value={service} onChange={(event) => setService(event.target.value)}>
                  <option value="all">all services</option>
                  {services.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="event-layout">
              <div className="event-list" role="list">
                {filtered.length === 0 ? (
                  <div className="no-results">
                    <strong>No events match this view.</strong>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('');
                        setService('all');
                        setCorrelation('all');
                        setEnabledLevels([...activeLevels]);
                      }}
                    >
                      Reset filters
                    </button>
                  </div>
                ) : (
                  filtered.map((event) => (
                    <button
                      type="button"
                      role="listitem"
                      className={`event-row ${selected?.id === event.id ? 'selected' : ''}`}
                      key={event.id}
                      onClick={() => setSelectedId(event.id)}
                    >
                      <span className={`level-pill level-${event.level}`}>{event.level}</span>
                      <time>{formatTime(event)}</time>
                      <span className="event-service">{event.service}</span>
                      <span className="event-message">{event.message}</span>
                      <span className="event-correlation">{event.correlation ?? '—'}</span>
                    </button>
                  ))
                )}
              </div>

              <aside className="inspector">
                {selected ? (
                  <>
                    <div className="inspector-heading">
                      <div>
                        <span className={`level-pill level-${selected.level}`}>
                          {selected.level}
                        </span>
                        <span>{formatTime(selected)}</span>
                      </div>
                      <strong>{selected.message}</strong>
                    </div>
                    <dl>
                      <div>
                        <dt>service</dt>
                        <dd>{selected.service}</dd>
                      </div>
                      <div>
                        <dt>correlation</dt>
                        <dd>{selected.correlation ?? 'not provided'}</dd>
                      </div>
                      <div>
                        <dt>source line</dt>
                        <dd>{selected.line}</dd>
                      </div>
                    </dl>
                    <div className="raw-heading">
                      <span>raw event</span>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(JSON.stringify(selected.raw, null, 2))}
                      >
                        copy
                      </button>
                    </div>
                    <pre>{JSON.stringify(selected.raw, null, 2)}</pre>
                  </>
                ) : (
                  <p className="inspector-empty">Select an event to inspect every field.</p>
                )}
              </aside>
            </div>
          </section>
        </main>
      )}

      {importOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setImportOpen(false)}>
          <section
            className="import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">new dataset</p>
                <h2 id="import-title">Bring your logs into focus.</h2>
              </div>
              <button type="button" onClick={() => setImportOpen(false)} aria-label="Close import dialog">
                ×
              </button>
            </div>
            <label
              className="drop-target"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                importFile(event.dataTransfer.files[0]);
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".json,.jsonl,.ndjson,application/json"
                onChange={(event) => importFile(event.target.files?.[0])}
              />
              <strong>Choose a JSON or JSONL file</strong>
              <span>Files are read locally and never uploaded.</span>
            </label>
            <div className="dialog-divider"><span>or paste structured logs</span></div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={'{"timestamp":"2026-09-17T09:42:11Z","level":"info","message":"Ready"}'}
              rows={8}
              autoFocus
            />
            <div className="dialog-footer">
              <span>JSON arrays and newline-delimited JSON are supported.</span>
              <button
                className="primary-button"
                type="button"
                disabled={!draft.trim()}
                onClick={() => load(draft)}
              >
                Open dataset
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
