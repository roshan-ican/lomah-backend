import type { UserRole } from '@prisma/client';

import { USER_ROLES } from '@/auth/roles';

/**
 * Decide whether a newly-created session snapshots face verification as
 * required. Only ADMIN owns this preference; every other role keeps today's
 * face-verification behaviour.
 *
 * A missing preference must fail safely to `true`, because older databases or
 * incomplete callers must not silently bypass an identity check.
 */
export function resolveFaceVerificationRequirement(
  actorRole: UserRole,
  adminPreference: boolean | null | undefined,
): boolean {
  if (actorRole !== USER_ROLES.ADMIN) {
    return true;
  }
  return adminPreference !== false;
}
