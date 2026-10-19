/**
 * 极简结构化日志。
 *
 * 不用第三方库：服务端要跑在精简镜像里，日志只需要能被 docker logs 和
 * journalctl 读懂即可，不需要颜色和传输层。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel = LEVEL_ORDER.info;

export function setLogLevel(level: LogLevel): void {
  minLevel = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
}

function emit(level: LogLevel, scope: string, message: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < minLevel) return;

  const time = new Date().toISOString();
  const head = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;

  const line =
    meta === undefined
      ? head
      : `${head} ${typeof meta === 'string' ? meta : safeJson(meta)}`;

  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('app');
