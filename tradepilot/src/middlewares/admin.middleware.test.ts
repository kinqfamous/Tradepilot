import { describe, it, expect } from 'vitest';
import { isAdminId } from './admin.middleware';

describe('isAdminId (admin permissions)', () => {
  it('allows a Telegram ID that is in the configured admin list', () => {
    expect(isAdminId(12345, [12345, 67890])).toBe(true);
  });

  it('rejects a Telegram ID that is not in the configured admin list', () => {
    expect(isAdminId(99999, [12345, 67890])).toBe(false);
  });

  it('rejects an undefined sender (e.g. a malformed update with no from field)', () => {
    expect(isAdminId(undefined, [12345])).toBe(false);
  });

  it('rejects everyone when the admin list is empty', () => {
    expect(isAdminId(12345, [])).toBe(false);
  });

  it('does not treat a non-admin user ID as admin just because the list is non-empty', () => {
    expect(isAdminId(1, [2, 3, 4])).toBe(false);
  });
});
