import { useEffect, useMemo, useRef, useState } from 'react';
import { levels, parseLogs, sampleLogs, type LogEvent, type LogLevel } from './logs';

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});

const rowBatch = 500;

function formatTime(event: LogEvent) {
  if (!event.timestamp) return `line ${event.line}`;
  return timeFormat.format(event.timestamp);
}

function formatSpan(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function formatRaw(event: LogEvent) {
  return typeof event.raw.original === 'string' && Object.keys(event.raw).length === 1
    ? event.raw.original
    : JSON.stringify(event.raw, null, 2);
}

function isSevere(level: LogLevel) {
  return level === 'error' || level === 'fatal';
}

function buildTimeline(events: LogEvent[], start: number, end: number, buckets = 28) {
  const output = Array.from({ length: buckets }, () => ({ total: 0, severe: 0 }));
  const width = Math.max(1, end - start);
  for (const event of events) {
    if (!event.timestamp) continue;
    const index = Math.min(
      buckets - 1,
      Math.floor(((event.timestamp.getTime() - start) / width) * buckets),
    );
    output[index].total += 1;
    if (isSevere(event.level)) output[index].severe += 1;
  }
  return output;
}

function App() {
  const [source, setSource] = useState(() => {
    try {
      return localStorage.getItem('traceboard-source') ?? '';
    } catch {
      return '';
    }
  });
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [service, setService] = useState('all');
  const [correlation, setCorrelation] = useState('all');
  const [enabledLevels, setEnabledLevels] = useState<LogLevel[]>([...levels]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [rowLimit, setRowLimit] = useState(rowBatch);
  const [importOpen, setImportOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
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
        (!needle || formatRaw(event).toLowerCase().includes(needle)),
    );
  }, [correlation, enabledLevels, parsed.events, query, service]);
  const selected = filtered.find((event) => event.line === selectedId) ?? filtered[0] ?? null;
  const [firstTime, lastTime] = useMemo(
    () =>
      parsed.events.reduce(
        ([min, max], event) => {
          const time = event.timestamp?.getTime();
          return time === undefined ? [min, max] : [Math.min(min, time), Math.max(max, time)];
        },
        [Infinity, -Infinity],
      ),
    [parsed.events],
  );
  const span = Number.isFinite(firstTime) ? lastTime - firstTime : 0;
  const timeline = useMemo(
    () => buildTimeline(filtered, firstTime, lastTime),
    [filtered, firstTime, lastTime],
  );
  const timelineMaximum = Math.max(1, ...timeline.map((bucket) => bucket.total));

  useEffect(() => {
    try {
      localStorage.removeItem('traceboard-source');
      localStorage.setItem('traceboard-source', source);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }, [source]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key === '/' &&
        !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') setImportOpen(false);
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  function resetFilters() {
    setQuery('');
    setService('all');
    setCorrelation('all');
    setEnabledLevels([...levels]);
  }

  function load(nextSource: string) {
    setSource(nextSource);
    setDraft('');
    resetFilters();
    setSelectedId(null);
    setRowLimit(rowBatch);
    setImportOpen(false);
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    load(await file.text());
  }

  function toggleLevel(level: LogLevel) {
    setEnabledLevels((current) =>
      current.includes(level) ? current.filter((item) => item !== level) : [...current, level],
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar" inert={importOpen}>
        <div className="wordmark">
          <span className="mark" aria-hidden="true">
            T/
          </span>
          <span>Traceboard</span>
          <span className="edition">local workspace</span>
        </div>
        <span className="privacy-status">
          <span className="privacy-dot" /> Nothing leaves this browser
        </span>
      </header>

      {parsed.events.length === 0 ? (
        <main className="welcome" inert={importOpen}>
          <section className="welcome-copy">
            <h1>Explore logs in your browser.</h1>
            <p className="lede">
              Import plain-text, JSON or JSONL logs and filter them by level, service or request ID.
            </p>
            <div className="welcome-actions">
              <button className="primary-button" type="button" onClick={() => setImportOpen(true)}>
                Import logs
              </button>
              <button className="text-button" type="button" onClick={() => load(sampleLogs)}>
                Explore sample data →
              </button>
            </div>
            {source.trim() && (
              <p className="parse-error">No events found in this input.</p>
            )}
          </section>
          <section className="welcome-preview" aria-label="Traceboard preview">
            <div className="preview-header">
              <span>req-a72f</span>
              <span>7 events</span>
            </div>
            {[
              ['09:42:11.104', 'api', 'Request accepted', 'info'],
              ['09:42:11.189', 'worker', 'Processing started', 'info'],
              ['09:42:11.461', 'postgres', 'Checkpoint exceeded target', 'warn'],
              ['09:42:11.522', 'api', 'Request completed', 'info'],
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
        <main className="workspace" inert={importOpen}>
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
                {levels.map((level) => {
                  const count = parsed.events.filter((event) => event.level === level).length;
                  return (
                    <button
                      className={enabledLevels.includes(level) ? 'active' : ''}
                      aria-pressed={enabledLevels.includes(level)}
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
                aria-pressed={correlation === 'all'}
                onClick={() => setCorrelation('all')}
              >
                <span>All traces</span>
                <span>{parsed.events.length}</span>
              </button>
              {correlations.slice(0, 7).map(([id, count]) => (
                <button
                  type="button"
                  className={correlation === id ? 'active' : ''}
                  aria-pressed={correlation === id}
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
                  {parsed.events.filter((event) => isSevere(event.level)).length}
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
                <span>
                  {Number.isFinite(firstTime) &&
                    `${new Date(firstTime).toLocaleTimeString()} — ${new Date(lastTime).toLocaleTimeString()}`}
                </span>
              </div>
              <div className="timeline" role="img" aria-label="Event distribution over time">
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
              <div className="event-list">
                {filtered.length === 0 ? (
                  <div className="no-results">
                    <strong>No events match this view.</strong>
                    <button type="button" onClick={resetFilters}>
                      Reset filters
                    </button>
                  </div>
                ) : (
                  <>
                    {filtered.slice(0, rowLimit).map((event) => (
                      <button
                        type="button"
                        className={`event-row ${selected?.line === event.line ? 'selected' : ''}`}
                        aria-current={selected?.line === event.line}
                        key={event.line}
                        onClick={() => setSelectedId(event.line)}
                      >
                        <span className={`level-pill level-${event.level}`}>{event.level}</span>
                        <time>{formatTime(event)}</time>
                        <span className="event-service">{event.service}</span>
                        <span className="event-message">{event.message}</span>
                        <span className="event-correlation">{event.correlation ?? '—'}</span>
                      </button>
                    ))}
                    {filtered.length > rowLimit && (
                      <button
                        type="button"
                        className="show-more"
                        onClick={() => setRowLimit((limit) => limit + rowBatch)}
                      >
                        Show more · {(filtered.length - rowLimit).toLocaleString()} not shown
                      </button>
                    )}
                  </>
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
                        onClick={() => navigator.clipboard.writeText(formatRaw(selected))}
                      >
                        copy
                      </button>
                    </div>
                    <pre>{formatRaw(selected)}</pre>
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
                <h2 id="import-title">Import logs</h2>
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
                type="file"
                accept=".json,.jsonl,.ndjson,.log,.txt,application/json,text/plain"
                onChange={(event) => importFile(event.target.files?.[0])}
              />
              <strong>Choose a log, text, JSON, or JSONL file</strong>
              <span>Files are read locally and never uploaded.</span>
            </label>
            <div className="dialog-divider"><span>or paste log output</span></div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={'{"timestamp":"2026-09-17T09:42:11Z","level":"info","message":"Ready"}'}
              rows={8}
              autoFocus
            />
            <div className="dialog-footer">
              <span>Plain text, container output, JSON arrays, and JSONL are supported.</span>
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
