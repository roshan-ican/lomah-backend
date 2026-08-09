import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * One line per API request: who asked, for what, what they got, how long.
 *
 * This exists because of a specific failure that could not be diagnosed
 * without it. An admin console on another device reported a session as saved;
 * after a reload the change was gone, and the backend log showed nothing about
 * the request. "Nothing in the log" was read as "the request was never sent" —
 * but Nest does not log incoming requests by default, so a request that
 * arrived and succeeded produced exactly the same silence. There was no
 * observation that could tell the two apart.
 *
 * Now there is. A save that never leaves the browser produces no line here; a
 * save that arrives produces one, with its status and the IP it came from.
 * That single distinction is the difference between debugging the client and
 * debugging the server.
 *
 * Cost control, because this sits on every request:
 *   - Only /api routes. Static assets are a different kind of traffic and
 *     would bury the useful lines.
 *   - Bodies are never logged. They carry JWTs and passwords.
 *   - Mutations (POST/PATCH/PUT/DELETE) are logged always; GETs only when they
 *     fail. A lane grid polling GET /sessions every few seconds across a dozen
 *     consoles is not information, it is noise — and console writes block on
 *     Windows, on the same event loop the UDP receive path runs on.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const { method, originalUrl } = req;

    // Log on 'finish', not up front: the status code is the whole point, and
    // it does not exist until the response is on its way out.
    res.once('finish', () => {
      const { statusCode } = res;
      const isMutation = method !== 'GET' && method !== 'HEAD';
      const failed = statusCode >= 400;

      if (!isMutation && !failed) return;

      const ms = Date.now() - startedAt;
      // The device that made the request. Decisive when two consoles disagree
      // about what was saved — it says which one actually talked to us.
      const from = this.clientIp(req);
      const line = `${method} ${originalUrl} ${statusCode} ${ms}ms from ${from}`;

      if (statusCode >= 500) this.logger.error(line);
      else if (failed) this.logger.warn(line);
      else this.logger.log(line);
    });

    next();
  }

  /** Prefer the proxy header when present, else the socket address, and strip
   *  the IPv4-mapped-IPv6 prefix so it matches what the range LAN uses. */
  private clientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded)
      ? forwarded[0]
      : (forwarded?.split(',')[0].trim() ?? req.socket.remoteAddress ?? '');
    return raw.replace(/^::ffff:/, '') || 'unknown';
  }
}
