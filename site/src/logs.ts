export const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'] as const;

export type LogLevel = (typeof levels)[number];

export interface LogEvent {
  id: string;
  line: number;
  timestamp: Date | null;
  timestampLabel: string;
  level: LogLevel;
  service: string;
  message: string;
  correlation: string | null;
  raw: Record<string, unknown>;
}

export interface ParseResult {
  events: LogEvent[];
  rejected: number;
}

const timestampKeys = ['timestamp', 'time', 'ts', '@timestamp', 'datetime', 'createdAt'];
const levelKeys = ['level', 'severity', 'log_level', 'logLevel'];
const serviceKeys = ['service', 'service_name', 'app', 'application', 'component', 'logger'];
const messageKeys = ['message', 'msg', 'event', 'description'];
const correlationKeys = [
  'correlationId',
  'correlation_id',
  'requestId',
  'request_id',
  'traceId',
  'trace_id',
];

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
  const normalized = String(value ?? 'unknown').toLowerCase();
  if (normalized === 'warning') return 'warn';
  if (normalized === 'critical') return 'fatal';
  return levels.includes(normalized as LogLevel) ? (normalized as LogLevel) : 'unknown';
}

function parseTimestamp(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRecord(record: Record<string, unknown>, line: number): LogEvent {
  const entries = Object.entries(record);
  const wrapped =
    entries.length === 1 && isRecord(entries[0][1])
      ? ([entries[0][0], entries[0][1]] as const)
      : null;
  const content = wrapped ? wrapped[1] : record;
  const timestampValue = nestedValueFor(record, timestampKeys);
  const timestamp = parseTimestamp(timestampValue);
  const correlationValue =
    nestedValueFor(record, correlationKeys) ??
    (wrapped ? valueFor(content, [`${wrapped[0]}Id`, 'id']) : valueFor(record, ['id']));
  const name = textFor(content, ['name', 'title'], '');
  return {
    id: `${line}-${JSON.stringify(record).slice(0, 48)}`,
    line,
    timestamp,
    timestampLabel: timestamp ? timestamp.toISOString() : 'time unknown',
    level: normalizeLevel(nestedValueFor(record, levelKeys)),
    service: textFor(record, serviceKeys, wrapped?.[0] ?? 'unknown service'),
    message: textFor(record, messageKeys, name || (wrapped ? `Structured ${wrapped[0]}` : 'Structured event')),
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

export function parseLogs(source: string): ParseResult {
  const trimmed = source.trim();
  if (!trimmed) return { events: [], rejected: 0 };

  try {
    const value: unknown = JSON.parse(trimmed);
    if (isRecord(value)) return { events: [normalizeRecord(value, 1)], rejected: 0 };
    if (Array.isArray(value)) {
      const values = value;
      const events = values
        .map((value, index) => (isRecord(value) ? normalizeRecord(value, index + 1) : null))
        .filter((event): event is LogEvent => event !== null);
      return { events, rejected: values.length - events.length };
    }
    return { events: [], rejected: 1 };
  } catch {
  }

  let rejected = 0;
  const events = trimmed
    .split(/\r?\n/)
    .map((line, index) => {
      if (!line.trim()) return null;
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) {
          rejected += 1;
          return null;
        }
        return normalizeRecord(value, index + 1);
      } catch {
        rejected += 1;
        return null;
      }
    })
    .filter((event): event is LogEvent => event !== null)
    .sort((a, b) => (a.timestamp?.getTime() ?? a.line) - (b.timestamp?.getTime() ?? b.line));

  return { events, rejected };
}

export const sampleLogs = [
  {
    timestamp: '2026-09-17T09:42:11.104Z',
    level: 'info',
    service: 'gateway',
    message: 'Checkout request accepted',
    correlationId: 'req-a72f',
    method: 'POST',
    path: '/checkout',
    duration_ms: 18,
  },
  {
    timestamp: '2026-09-17T09:42:11.132Z',
    level: 'debug',
    service: 'catalog',
    message: 'Inventory reservation started',
    correlationId: 'req-a72f',
    sku_count: 3,
  },
  {
    timestamp: '2026-09-17T09:42:11.189Z',
    level: 'info',
    service: 'catalog',
    message: 'Inventory reserved',
    correlationId: 'req-a72f',
    duration_ms: 57,
  },
  {
    timestamp: '2026-09-17T09:42:11.208Z',
    level: 'info',
    service: 'payments',
    message: 'Authorization requested',
    correlationId: 'req-a72f',
    provider: 'northstar',
  },
  {
    timestamp: '2026-09-17T09:42:11.461Z',
    level: 'warn',
    service: 'payments',
    message: 'Provider response exceeded target latency',
    correlationId: 'req-a72f',
    duration_ms: 253,
    target_ms: 200,
  },
  {
    timestamp: '2026-09-17T09:42:11.486Z',
    level: 'info',
    service: 'payments',
    message: 'Payment authorized',
    correlationId: 'req-a72f',
    amount: 184.5,
    currency: 'USD',
  },
  {
    timestamp: '2026-09-17T09:42:11.522Z',
    level: 'info',
    service: 'orders',
    message: 'Order committed',
    correlationId: 'req-a72f',
    order_id: 'ord-9014',
  },
  {
    timestamp: '2026-09-17T09:42:13.018Z',
    level: 'info',
    service: 'gateway',
    message: 'Checkout request accepted',
    correlationId: 'req-b19c',
    method: 'POST',
    path: '/checkout',
  },
  {
    timestamp: '2026-09-17T09:42:13.081Z',
    level: 'error',
    service: 'catalog',
    message: 'Inventory reservation rejected',
    correlationId: 'req-b19c',
    sku: 'INK-04',
    available: 0,
  },
  {
    timestamp: '2026-09-17T09:42:13.096Z',
    level: 'warn',
    service: 'gateway',
    message: 'Checkout completed with conflict',
    correlationId: 'req-b19c',
    status: 409,
    duration_ms: 78,
  },
  {
    timestamp: '2026-09-17T09:42:15.400Z',
    level: 'debug',
    service: 'worker',
    message: 'Notification batch acquired',
    correlationId: 'job-digest-88',
    batch_size: 42,
  },
  {
    timestamp: '2026-09-17T09:42:15.782Z',
    level: 'fatal',
    service: 'worker',
    message: 'Notification worker lost database connection',
    correlationId: 'job-digest-88',
    retry_in_ms: 5000,
  },
].map((entry) => JSON.stringify(entry)).join('\n');
