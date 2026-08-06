import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../auth.service';

/** Pulls the authenticated user off the request — populated by JwtAuthGuard
 *  after it verifies the token. Use as @CurrentUser() in a controller method,
 *  the same way @Body() or @Param() work. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    return ctx.switchToHttp().getRequest().user;
  },
);
