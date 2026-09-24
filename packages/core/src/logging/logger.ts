export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives one serialized JSON line (no trailing newline). Defaults to stdout, or stderr for warn/error. */
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function defaultWrite(line: string, level: LogLevel): void {
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

/** One JSON line per event: { ts, level, msg, ...fields }. Fields can never overwrite ts/level/msg. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (RANK[level] < threshold) return;
    write(JSON.stringify({ ts: now().toISOString(), level, msg, ...fields }, replacer), level);
  };
  // Strip same-named fields so ts/level/msg always come first and can never be overwritten.
  const ordered = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    const { ts: _ts, level: _level, msg: _msg, ...rest } = fields ?? {};
    emit(level, msg, rest);
  };
  return { debug: ordered('debug'), info: ordered('info'), warn: ordered('warn'), error: ordered('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
