/**
 * The server's own log lines, made subscribable so the admin console can show
 * them live instead of only the handful of events the frontend generates
 * locally.
 *
 * Deliberately a module-level Subject rather than a Nest provider: the logger
 * that feeds it is constructed by main.ts BEFORE the DI container exists, so a
 * provider could never be injected into it. Anything that wants these lines
 * (currently only RealtimeGateway) imports the stream directly.
 */
import { Subject } from 'rxjs';

export type ServerLogLevel = 'log' | 'warn' | 'error';

export interface ServerLogLine {
  level: ServerLogLevel;
  /** Nest logger context — e.g. "SensorService". Null when it could not be
   *  determined (a bare console-style call with no context attached). */
  context: string | null;
  message: string;
  /** ISO-8601. The console prints local time; this stays unambiguous on the
   *  wire so a browser in another timezone renders it correctly. */
  timestamp: string;
}

export const serverLogs$ = new Subject<ServerLogLine>();

/**
 * Ring buffer of recent lines. An admin that connects mid-relay gets the
 * backlog immediately rather than an empty panel that only fills on the next
 * shot — which, on a quiet range, could be minutes.
 */
const MAX_RECENT = 200;
const recent: ServerLogLine[] = [];

export function recentServerLogs(): ServerLogLine[] {
  return [...recent];
}

export function pushServerLog(line: ServerLogLine): void {
  recent.push(line);
  if (recent.length > MAX_RECENT) recent.shift();
  serverLogs$.next(line);
}
