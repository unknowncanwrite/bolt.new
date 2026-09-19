import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasServerVercelToken, normalizeVercelToken, resolveVercelToken } from './vercel-token';

describe('normalizeVercelToken', () => {
  it('trims usable tokens', () => {
    expect(normalizeVercelToken('  vcp_abc123  ')).toBe('vcp_abc123');
  });

  it('rejects empty values and untouched .env placeholders', () => {
    expect(normalizeVercelToken('')).toBeUndefined();
    expect(normalizeVercelToken(undefined)).toBeUndefined();
    expect(normalizeVercelToken(null)).toBeUndefined();
    expect(normalizeVercelToken('your_vercel_access_token_here')).toBeUndefined();
    expect(normalizeVercelToken(42 as any)).toBeUndefined();
  });
});

describe('resolveVercelToken', () => {
  const keys = ['VERCEL_TOKEN', 'VITE_VERCEL_ACCESS_TOKEN', 'VERCEL_ACCESS_TOKEN', 'VERCEL_API_TOKEN'];
  let backup: Record<string, string | undefined>;

  beforeEach(() => {
    backup = {};

    for (const key of keys) {
      backup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    }
  });

  it('prefers the token the caller passed in', () => {
    process.env.VERCEL_TOKEN = 'vcp_from_env';

    expect(resolveVercelToken('vcp_from_browser')).toBe('vcp_from_browser');
  });

  it('falls back to Cloudflare/worker bindings', () => {
    expect(resolveVercelToken('', { VERCEL_TOKEN: 'vcp_from_bindings' })).toBe('vcp_from_bindings');
    expect(resolveVercelToken(undefined, { VITE_VERCEL_ACCESS_TOKEN: 'vcp_from_legacy_binding' })).toBe(
      'vcp_from_legacy_binding',
    );
  });

  it('falls back to process.env, so VERCEL_TOKEN alone is enough', () => {
    process.env.VERCEL_TOKEN = 'vcp_from_process';

    expect(resolveVercelToken(undefined)).toBe('vcp_from_process');
    expect(hasServerVercelToken()).toBe(true);
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveVercelToken(undefined, {})).toBeUndefined();
    expect(hasServerVercelToken({})).toBe(false);
  });
});
