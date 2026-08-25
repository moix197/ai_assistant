export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface CreateLoggerOptions {
  /** Minimum level to emit; lines below this are dropped. Default "info". */
  level?: LogLevel;
  /** Fields merged into every line, e.g. { service: "hermes" }. */
  fields?: LogFields;
  /** Sink for a formatted line. Default: process.stdout. Overridable for tests. */
  write?: (line: string) => void;
}

function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatLine(
  level: LogLevel,
  msg: string,
  baseFields: LogFields,
  fields?: LogFields,
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...baseFields,
    ...fields,
  });
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const minLevel = options.level ?? "info";
  const baseFields = options.fields ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  function log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!shouldLog(level, minLevel)) return;
    write(formatLine(level, msg, baseFields, fields));
  }

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}
