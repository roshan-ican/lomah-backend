import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../decorators/roles.decorator';
import type { JwtPayload } from '../auth.service';

/**
 * Runs AFTER JwtAuthGuard in the guard chain (registration order in
 * auth.module.ts matters — request.user must already be populated by the
 * time this reads it). A route with no @Roles(...) is left alone here and
 * allowed for any authenticated user; only routes that explicitly restrict by
 * role are checked.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user: JwtPayload }>();
    return required.includes(request.user.role);
  }
}
