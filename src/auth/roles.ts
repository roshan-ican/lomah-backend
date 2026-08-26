import type { UserRole } from '@prisma/client';

/** One typed source for role values used in application logic and tests. */
export const USER_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  SHOOTER: 'SHOOTER',
} as const satisfies Record<UserRole, UserRole>;
