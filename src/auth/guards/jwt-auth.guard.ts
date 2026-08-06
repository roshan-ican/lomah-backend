import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { JwtPayload } from '../auth.service';

/**
 * Applied GLOBALLY as an APP_GUARD (see auth.module.ts), so every route
 * requires a valid bearer token unless explicitly marked @Public(). This is
 * deliberately "secure by default, opt out" rather than "open by default, opt
 * in" — a new controller written next month is protected automatically,
 * instead of silently unauthenticated until someone remembers to guard it.
 *
 * No passport here on purpose. @nestjs/jwt already does sign/verify; a
 * passport strategy on top of it is an extra layer of indirection this
 * project doesn't need for a single bearer-token scheme.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      // Attaches the decoded payload to the request, which is what
      // @CurrentUser() and RolesGuard both read afterward.
      (request as Request & { user: JwtPayload }).user =
        await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;

    // Split on ANY run of whitespace, not a single space. `split(' ')` on
    // "Bearer     eyJ..." yields ['Bearer', '', '', '', 'eyJ...'], so the
    // token lands at index 4 and index 1 is an empty string — the request is
    // rejected as "missing" while the token is sitting right there. Pasting a
    // header out of a terminal or an API client picks up stray spaces and
    // newlines constantly, and the resulting 401 looks like an auth problem
    // rather than a whitespace one.
    const [type, token] = header.trim().split(/\s+/);

    // Scheme match is case-insensitive: RFC 7235 defines auth schemes as
    // case-insensitive tokens, and clients do send "bearer".
    if (type?.toLowerCase() !== 'bearer') return undefined;
    return token || undefined;
  }
}
