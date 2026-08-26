import { describe, expect, it } from 'vitest';

import { USER_ROLES } from '@/auth/roles';
import { resolveFaceVerificationRequirement } from './face-verification-policy';

describe('resolveFaceVerificationRequirement', () => {
  it('requires verification when an admin enables it', () => {
    expect(resolveFaceVerificationRequirement(USER_ROLES.ADMIN, true)).toBe(
      true,
    );
  });

  it('skips verification when an admin disables it', () => {
    expect(resolveFaceVerificationRequirement(USER_ROLES.ADMIN, false)).toBe(
      false,
    );
  });

  it.each([undefined, null])(
    'fails safely when the admin preference is %s',
    (preference) => {
      expect(
        resolveFaceVerificationRequirement(USER_ROLES.ADMIN, preference),
      ).toBe(true);
    },
  );

  it('does not let the ADMIN preference change SUPER_ADMIN behaviour', () => {
    expect(
      resolveFaceVerificationRequirement(USER_ROLES.SUPER_ADMIN, false),
    ).toBe(true);
  });
});
