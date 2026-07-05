// Lightweight structured logger. Emits one JSON line per call so logs flow
// straight into Supabase log explorer / external aggregators without parsing.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  fn?: string;
  correlationId?: string;
  leadId?: string;
  conversationId?: string;
  providerMessageId?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  console.log(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, f?: LogFields) => emit('debug', msg, f),
  info: (msg: string, f?: LogFields) => emit('info', msg, f),
  warn: (msg: string, f?: LogFields) => emit('warn', msg, f),
  error: (msg: string, f?: LogFields) => emit('error', msg, f),
};

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function correlationFromRequest(req: Request): string {
  return req.headers.get('x-correlation-id') || newCorrelationId();
}
