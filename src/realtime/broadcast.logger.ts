/**
 * The app's logger: prints to the console exactly as before, and additionally
 * tees every line onto `serverLogs$` so the admin console can render it.
 *
 * Subclassing ConsoleLogger — rather than adding an explicit "also broadcast
 * this" call at each interesting site — is what makes SensorService's per-shot
 * lines, TargetCommandService's PLAY handshake, and everything else show up
 * without touching those services at all.
 *
 * The console format is the stock one except for the timestamp (see below).
 * The broadcast copy is unaffected: `pushServerLog` sends a full ISO string and
 * the admin console formats it itself.
 */
import { ConsoleLogger } from '@nestjs/common';

import { pushServerLog, type ServerLogLevel } from './server-log.stream';

/**
 * Time only — no date, and 24-hour so the AM/PM goes too.
 *
 * Nest's default stamps every line with the full date ("10/08/2026, 11:20:16
 * AM"), which is eleven constant characters in front of the part that changes.
 * A range session is read within the day it happened, and the date is still on
 * the file itself, so it earns nothing per-line.
 *
 * Milliseconds are added rather than dropped: the timing questions these logs
 * get asked — how long a PLAY handshake took, whether two shots arrived inside
 * the resend grace window — happen well under a second, and second resolution
 * cannot answer them.
 */
const TIME_ONLY = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});

export class BroadcastLogger extends ConsoleLogger {
  protected getTimestamp(): string {
    return TIME_ONLY.format(Date.now());
  }

  log(message: unknown, ...rest: unknown[]): void {
    super.log(message as string, ...(rest as string[]));
    this.tee('log', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    super.warn(message as string, ...(rest as string[]));
    this.tee('warn', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    super.error(message as string, ...(rest as string[]));
    this.tee('error', message, rest);
  }

  /**
   * Nest appends the context as the LAST argument when a scoped `new
   * Logger(Foo.name)` forwards a call here, so the trailing string is the
   * context. error() may instead be called as (message, stack, context); the
   * same "last string wins" rule still picks the context out of that.
   */
  private tee(level: ServerLogLevel, message: unknown, rest: unknown[]): void {
    const tail = rest[rest.length - 1];
    const context = typeof tail === 'string' ? tail : (this.context ?? null);

    // A broadcast must never be able to take the process down: this runs
    // inside every single log call, including the ones error handlers make.
    try {
      pushServerLog({
        level,
        context,
        message: stringify(message),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Swallowed on purpose — logging here would recurse.
    }
  }
}

function stringify(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
