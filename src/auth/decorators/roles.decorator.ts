import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to one or more roles, e.g. @Roles('SUPER_ADMIN').
 * A route with no @Roles(...) at all is open to any authenticated user —
 * see RolesGuard, which treats "no metadata" as "no restriction".
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
