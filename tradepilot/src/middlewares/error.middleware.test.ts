import { describe, expect, it } from 'vitest';
import { sanitizeErrorText } from './error.middleware';

describe('error-detail sanitization', () => {
  it('redacts configured application secrets', () => {
    expect(sanitizeErrorText('Request failed with top-secret-value', ['top-secret-value']))
      .toBe('Request failed with [REDACTED]');
  });

  it('redacts credentials embedded in URLs', () => {
    expect(sanitizeErrorText('postgresql://tradepilot:password123@db.internal:5432/app'))
      .toBe('postgresql://[REDACTED]@db.internal:5432/app');
  });

  it('redacts bearer tokens and named secret values', () => {
    const input = 'Authorization: Bearer abc.def.ghi password=hunter2 private_key:base58-secret';
    const output = sanitizeErrorText(input);
    expect(output).not.toContain('abc.def.ghi');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('base58-secret');
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it('preserves non-sensitive diagnostic context', () => {
    expect(sanitizeErrorText('Phoenix returned HTTP 503 for SOL-PERP'))
      .toBe('Phoenix returned HTTP 503 for SOL-PERP');
  });
});
