import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route OUT of the global JwtAuthGuard. Everything requires a token by
 * default (see JwtAuthGuard) — a handful of routes (login, health) have to
 * explicitly say "no auth needed" rather than every new route silently being
 * unauthenticated until someone remembers to guard it.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
