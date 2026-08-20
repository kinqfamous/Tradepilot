import { describe, expect, it } from 'vitest';
import { isBlockedUserStatus } from './identify.middleware';

describe('account status gate', () => {
  it.each(['SUSPENDED', 'BANNED'])('blocks %s users', (status) => {
    expect(isBlockedUserStatus(status)).toBe(true);
  });

  it.each(['ACTIVE', 'ONBOARDING'])('allows %s users', (status) => {
    expect(isBlockedUserStatus(status)).toBe(false);
  });
});
