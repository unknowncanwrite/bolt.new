import { describe, expect, it } from 'vitest';
import type { AutoFixCandidate } from './autoFixErrors';
import {
  AUTO_FIX_COOLDOWN_MS,
  MAX_AUTO_FIX_ATTEMPTS,
  buildFixRequestMessage,
  decideAutoFix,
  errorSignature,
  isAutoFixEnabled,
} from './autoFixErrors';

const terminalError = {
  title: 'Dev Server Failed',
  description: 'npm run dev exited with code 1',
  content: 'sh: 1: vite: not found\nELIFECYCLE Command failed',
  source: 'terminal' as const,
};

const ready: AutoFixCandidate = {
  alert: terminalError,
  enabled: true,
  isStreaming: false,
  attempts: 0,
  lastSignature: null,
  lastAt: 0,
  now: AUTO_FIX_COOLDOWN_MS * 2,
};

const decide = (override: Partial<typeof ready> = {}) => decideAutoFix({ ...ready, ...override });

describe('decideAutoFix', () => {
  it('acts on its own instead of asking the user', () => {
    expect(decide()).toEqual({ action: 'auto-fix', reason: 'go' });
  });

  it.each([
    ['the user switched it off', { enabled: false }, 'disabled'],
    ['there is no error', { alert: undefined }, 'no-alert'],
    ['the model is still writing the project', { isStreaming: true }, 'streaming'],
    ['the automatic budget is spent', { attempts: MAX_AUTO_FIX_ATTEMPTS }, 'out-of-attempts'],
    ['the fix is cooling down', { lastAt: AUTO_FIX_COOLDOWN_MS * 2 }, 'cooldown'],
  ])('leaves the alert alone when %s', (_label, override, reason) => {
    expect(decide(override as any)).toEqual({ action: 'ask-user', reason });
  });

  it('never asks twice about the same error', () => {
    expect(decide({ lastSignature: errorSignature(terminalError) })).toEqual({
      action: 'ask-user',
      reason: 'repeat',
    });
  });

  it('treats a cancelled run as nobody to fix', () => {
    expect(
      decide({
        alert: { ...terminalError, content: 'AbortError: The user aborted the request.' },
      }),
    ).toEqual({ action: 'ask-user', reason: 'no-alert' });
  });

  it('falls back to the manual prompt once the ceiling is reached', () => {
    expect(decide({ attempts: MAX_AUTO_FIX_ATTEMPTS - 1 }).action).toBe('auto-fix');
    expect(decide({ attempts: MAX_AUTO_FIX_ATTEMPTS }).action).toBe('ask-user');
  });
});

describe('errorSignature', () => {
  it('is stable across line-number noise but not across different failures', () => {
    const withLines = { ...terminalError, content: 'sh: 1: vite: not found\n  at Object.<anonymous> (x.js:12:3)' };
    expect(errorSignature(withLines)).toBe(errorSignature(terminalError));
    expect(errorSignature({ ...terminalError, title: 'Build Failed' })).not.toBe(errorSignature(terminalError));
  });

  it('survives the round trip: a quoted copy of the error is still the same error', () => {
    const sent = buildFixRequestMessage(terminalError, { automatic: true });
    expect(errorSignature({ ...terminalError, content: sent })).toBe(errorSignature(terminalError));
  });
});

describe('buildFixRequestMessage', () => {
  it('hands the model the raw output, and tells it not to wait for approval', () => {
    const message = buildFixRequestMessage(terminalError, { automatic: true });
    expect(message).toContain('vite: not found');
    expect(message).toContain('Do not ask me to run commands or confirm anything first');
    expect(message).toMatch(/```sh/);
  });

  it('keeps the short form for a human pressing the button', () => {
    const message = buildFixRequestMessage(terminalError);
    expect(message).toContain('*Fix this terminal error*');
    expect(message).not.toContain('Do not ask me');
  });

  it('fences preview errors as javascript', () => {
    expect(buildFixRequestMessage({ ...terminalError, source: 'preview' })).toContain('preview error');
    expect(buildFixRequestMessage({ ...terminalError, source: 'preview' })).toMatch(/```js/);
  });
});

describe('isAutoFixEnabled', () => {
  it('is on by default, since a stack trace is not an answer', () => {
    expect(isAutoFixEnabled(null)).toBe(true);
    expect(isAutoFixEnabled('true')).toBe(true);
    expect(isAutoFixEnabled('false')).toBe(false);
  });
});
