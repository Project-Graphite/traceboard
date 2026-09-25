export const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'] as const;

export type LogLevel = (typeof levels)[number];

export interface LogEvent {
  line: number;
  timestamp: Date | null;
  level: LogLevel;
  service: string;
  message: string;
  correlation: string | null;
  raw: Record<string, unknown>;
}

interface ParseResult {
  events: LogEvent[];
  rejected: number;
}

const timestampKeys = ['timestamp', 'time', 'ts', '@timestamp', 'datetime', 'createdAt'];
const levelKeys = ['level', 'severity', 'log_level', 'logLevel'];
const serviceKeys = [
  'service',
  'service_name',
  'app',
  'application',
  'component',
  'logger',
  'module',
  'caller',
];
const messageKeys = ['message', 'msg', 'event', 'description'];
const correlationKeys = [
  'correlationId',
  'correlation_id',
  'requestId',
  'request_id',
  'traceId',
  'trace_id',
];
const recordCollectionKeys = ['events', 'logs', 'records', 'logEvents', 'items'];
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const containerPrefix = /^(\w[\w.-]*)\s+\|\s?/;

function valueFor(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
}

function nestedValueFor(record: Record<string, unknown>, keys: string[]): unknown {
  const direct = valueFor(record, keys);
  if (direct !== undefined) return direct;
  for (const value of Object.values(record)) {
    if (isRecord(value)) {
      const nested = nestedValueFor(value, keys);
      if (nested !== undefined) return nested;
    }
  }
}

function textFor(record: Record<string, unknown>, keys: string[], fallback: string) {
  const value = valueFor(record, keys);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function normalizeLevel(value: unknown): LogLevel {
  if (typeof value === 'number') return levels[value / 10 - 1] ?? 'unknown';
  const normalized = String(value).toLowerCase();
  if (normalized === 'warning') return 'warn';
  if (['critical', 'panic', 'emerg', 'alert'].includes(normalized)) return 'fatal';
  if (['err', 'severe', 'stderr'].includes(normalized)) return 'error';
  if (['log', 'notice', 'stdout'].includes(normalized)) return 'info';
  if (normalized === 'verbose') return 'trace';
  return levels.includes(normalized as LogLevel) ? (normalized as LogLevel) : 'unknown';
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'string') return timestampFor(value);
  if (typeof value !== 'number') return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRecord(
  record: Record<string, unknown>,
  line: number,
  fallbackService = 'unknown service',
): LogEvent {
  const entries = Object.entries(record);
  const wrapped =
    entries.length === 1 && isRecord(entries[0][1])
      ? ([entries[0][0], entries[0][1]] as const)
      : null;
  const content = wrapped ? wrapped[1] : record;
  const timestamp = parseTimestamp(nestedValueFor(record, timestampKeys));
  const correlationValue =
    nestedValueFor(record, correlationKeys) ??
    (wrapped ? valueFor(content, [`${wrapped[0]}Id`, 'id']) : valueFor(record, ['id']));
  const name = textFor(content, ['name', 'title'], '');
  return {
    line,
    timestamp,
    level: normalizeLevel(nestedValueFor(record, levelKeys)),
    service: textFor(content, serviceKeys, wrapped?.[0] ?? fallbackService),
    message: textFor(content, messageKeys, name || (wrapped ? `Structured ${wrapped[0]}` : 'Structured event')),
    correlation:
      typeof correlationValue === 'string' || typeof correlationValue === 'number'
        ? String(correlationValue)
        : null,
    raw: record,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function correlationFor(message: string) {
  const labeled = message.match(
    /\b(?:correlation|request|trace)[_-]?id\b\s*[=:]\s*["']?([\w:./-]+)/i,
  );
  if (labeled) return labeled[1];
  const entity = message.match(
    /\b(report|job|document|task)\s+(?:id\s*[=:]?\s*)?#?((?=[\w-]*\d)[\w-]+)/i,
  );
  if (entity) return `${entity[1].toLowerCase()}:${entity[2]}`;
  const context = message.match(/\[[\w-]+\]\s*\[([\w:./-]{6,})\]/);
  return context?.[1] ?? null;
}

function timestampFor(value: string) {
  const access = value.match(
    /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):([\d:]+)\s+([+-]\d{4})$/,
  );
  const date = new Date(
    access
      ? `${access[1]} ${access[2]} ${access[3]} ${access[4]} GMT${access[5]}`
      : value.replace(/(\d{2}),(\d{3})/, '$1.$2'),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanLine(source: string) {
  return source
    .replace(ansiEscape, '')
    .replace(/^│\s?/, '')
    .replace(/\s*│$/, '')
    .replace(/\[([A-Za-z][\w.-]*)\[\]/g, '[$1]')
    .trimEnd();
}

function textEvent(original: string, line: number): LogEvent {
  let text = original;
  let service: string | undefined;
  let timestamp: Date | null = null;
  let level: LogLevel = 'unknown';

  const container = text.match(containerPrefix);
  if (container) {
    service = container[1];
    text = text.slice(container[0].length);
  }

  const cri = text.match(/^(\d{4}-\d\d-\d\dT\S+)\s+(stdout|stderr)\s+[FP]\s+(.*)$/i);
  if (cri) {
    timestamp = timestampFor(cri[1]);
    level = normalizeLevel(cri[2]);
    text = cri[3];
  }

  let message = text;
  const stackFrame = text.match(/^\s*at\s+([\w.]+)/);
  const standaloneException = text.match(/^([\w.]+(?:Error|Exception)):\s*(.*)$/);
  const nest = text.match(
    /^\[Nest\]\s+\d+\s+-\s+(.+?)\s+(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+\[([^\]]+)\]\s*(?:\[([^\]]+)\]\s*)?(.*?)(?:\s+\+\d+ms)?$/i,
  );
  if (stackFrame) {
    level = 'error';
    service ??= stackFrame[1].split('.')[0];
    message = text.trim();
  } else if (standaloneException) {
    level = 'error';
    service ??= 'runtime';
    message = `${standaloneException[1]}: ${standaloneException[2]}`;
  } else if (nest) {
    timestamp = timestampFor(nest[1]);
    level = normalizeLevel(nest[2]);
    service ??= nest[3];
    message = nest[5];
  } else {
    const python = text.match(
      /^(\d{4}-\d\d-\d\d[ T][\d:.,+-]+)\s+-\s+\[?(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\]?\s+-\s+(?:\[[^\]]+\]\s+-\s+){0,2}([^\s]+)\s+-\s+(.*)$/i,
    );
    const pythonStandard = text.match(
      /^(\d{4}-\d\d-\d\d[ T][\d:.,+-]+)\s+-\s+([^\s]+)\s+-\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+-\s+(.*)$/i,
    );
    const pythonIso = text.match(
      /^(\d{4}-\d\d-\d\dT[\d:.,+-]+Z?)\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+-\s+([^\s]+)\s+-\s+(.*)$/i,
    );
    const pythonBracketed = text.match(
      /^\[([^\]]+)\]\s+(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+-\s+([^\s]+)\s+-\s+(.*)$/i,
    );
    const pythonWarning = text.match(/^(.+?\.py):\d+:\s+([\w.]*Warning):\s+(.*)$/);
    const celery = text.match(/^\[([^\]]+):\s+(\w+)\/[^\]]+\]\s+(.*)$/);
    const gunicorn = text.match(/^\[([^\]]+)\]\s+\[\d+\]\s+\[(\w+)\]\s+(.*)$/);
    const httpAccess = text.match(
      /^\[([^\]]+)\]\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s+=>\s+STATUS\[(\d{3})\]\s+(.*)$/i,
    );
    const workerNotice = text.match(/^\[([^\]]+)\]\s+-\s+(worker\s+\d+)\s+(.*)$/i);
    const postgres = text.match(
      /^(\d{4}-\d\d-\d\d[ T][\d:.+-]+(?:\s+\w+)?)\s+\[\d+\](?:\s+[\w.-]+@[\w.-]+)?\s+(\w+):\s+(.*)$/,
    );
    const bracketed = text.match(
      /^\[([^\]]+)\]\s+\[(TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\]\s+\[([^\]]+)\]\s+(.*)$/i,
    );
    const iso = text.match(
      /^(\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?)\s+(TRACE|DEBUG|INFO|NOTICE|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+([^:]+):\s+(.*)$/i,
    );
    const redis = text.match(
      /^\d+:[A-Z]\s+(\d{1,2}\s+\w+\s+\d{4}\s+[\d:.]+)\s+([#*.-])\s+(.*)$/,
    );

    if (python) {
      timestamp = timestampFor(python[1]);
      level = normalizeLevel(python[2]);
      service ??= python[3];
      message = python[4];
    } else if (pythonStandard) {
      timestamp = timestampFor(pythonStandard[1]);
      service ??= pythonStandard[2];
      level = normalizeLevel(pythonStandard[3]);
      message = pythonStandard[4];
    } else if (pythonIso) {
      timestamp = timestampFor(pythonIso[1]);
      level = normalizeLevel(pythonIso[2]);
      service ??= pythonIso[3];
      message = pythonIso[4];
    } else if (pythonBracketed) {
      timestamp = timestampFor(pythonBracketed[1]);
      level = normalizeLevel(pythonBracketed[2]);
      service ??= pythonBracketed[3];
      message = pythonBracketed[4];
    } else if (pythonWarning) {
      level = 'warn';
      service ??= pythonWarning[1].split('/').at(-1)!;
      message = `${pythonWarning[2]}: ${pythonWarning[3]}`;
    } else if (celery || gunicorn) {
      const match = celery ?? gunicorn!;
      timestamp = timestampFor(match[1]);
      level = normalizeLevel(match[2]);
      service ??= celery ? 'worker' : 'web';
      message = match[3];
    } else if (httpAccess) {
      timestamp = timestampFor(httpAccess[1]);
      const status = Number(httpAccess[4]);
      level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      service ??= 'http';
      message = `${httpAccess[2].toUpperCase()} ${httpAccess[3]} → ${status} ${httpAccess[5]}`;
    } else if (workerNotice) {
      timestamp = timestampFor(workerNotice[1]);
      level = 'info';
      service ??= 'worker';
      message = `${workerNotice[2]} ${workerNotice[3]}`;
    } else if (postgres) {
      timestamp = timestampFor(postgres[1]);
      level = normalizeLevel(postgres[2]);
      service ??= 'postgres';
      message = postgres[3];
    } else if (bracketed) {
      timestamp = timestampFor(bracketed[1]);
      level = normalizeLevel(bracketed[2]);
      service ??= bracketed[3];
      message = bracketed[4];
    } else if (iso) {
      timestamp = timestampFor(iso[1]);
      level = normalizeLevel(iso[2]);
      service ??= iso[3].trim();
      message = iso[4];
    } else if (redis) {
      timestamp = timestampFor(redis[1]);
      level = redis[2] === '#' ? 'warn' : redis[2] === '*' ? 'info' : 'debug';
      service ??= 'redis';
      message = redis[3];
    }
  }

  const correlation = nest?.[4] ?? correlationFor(message);
  return {
    line,
    timestamp,
    level,
    service: service ?? 'unknown service',
    message: message || 'Log event',
    correlation,
    raw: { original },
  };
}

function sortedByTime(events: LogEvent[]) {
  return events.every((event) => event.timestamp)
    ? events.sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime())
    : events;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeValues(values: unknown[]) {
  const events = values
    .map((value, index) => (isRecord(value) ? normalizeRecord(value, index + 1) : null))
    .filter((event): event is LogEvent => event !== null);
  return {
    events: sortedByTime(events),
    rejected: values.length - events.length,
  };
}

export function parseLogs(source: string): ParseResult {
  const trimmed = source.trim();
  if (!trimmed) return { events: [], rejected: 0 };

  const json = parseJson(trimmed);
  if (isRecord(json)) {
    for (const key of recordCollectionKeys) {
      if (Array.isArray(json[key])) return normalizeValues(json[key]);
    }
    return { events: [normalizeRecord(json, 1)], rejected: 0 };
  }
  if (Array.isArray(json)) return normalizeValues(json);
  if (json !== undefined) return { events: [], rejected: 1 };

  const events: LogEvent[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const cleaned = cleanLine(line);
    if (!cleaned.trim()) continue;
    const container = cleaned.match(containerPrefix);
    const content = container ? cleaned.slice(container[0].length) : cleaned;
    const previous = events.at(-1);
    const previousOriginal = previous?.raw.original;
    if (
      previous &&
      typeof previousOriginal === 'string' &&
      (/^\s+/.test(content) ||
        /^(Traceback \(most recent call last\):|Caused by:|During handling|DETAIL:|HINT:|CONTEXT:|STATEMENT:|[\w.]+(?:Error|Exception):)/.test(
          content,
        ))
    ) {
      previous.raw = { original: `${previousOriginal}\n${cleaned}` };
      continue;
    }
    const value = parseJson(content);
    events.push(
      isRecord(value)
        ? normalizeRecord(value, index + 1, container?.[1])
        : textEvent(cleaned, index + 1),
    );
  }

  return { events: sortedByTime(events), rejected: 0 };
}

export const sampleLogs = [
  'api-1 | [Nest] 24 - 09/17/2026, 09:42:11 AM LOG [RequestHandler][req-a72f] Request accepted +2ms',
  'worker-1 | 2026-09-17 09:42:11,132 - [INFO] - [12] - [MainThread] - jobs.index - Processing started requestId=req-a72f',
  JSON.stringify({
    timestamp: '2026-09-17T09:42:11.208',
    level: 'info',
    service: 'search',
    message: 'Query completed',
    traceId: 'req-a72f',
    duration_ms: 76,
  }),
  'vector-1 | 2026-09-17T09:42:11.301 INFO storage: persisted 24 vectors trace_id=req-a72f',
  'postgres-1 | 2026-09-17 09:42:11.461 [74] WARNING: checkpoint exceeded target duration',
  'api-1 | [Nest] 24 - 09/17/2026, 09:42:11 AM ERROR [RequestHandler][req-b19c] Request failed +18ms',
  '[2026-09-17 09:42:11] [31] [ERROR] Worker exited unexpectedly request_id=req-b19c',
  'redis-1 | 1:M 17 Sep 2026 09:42:15.782 * Ready to accept connections',
].join('\n');
