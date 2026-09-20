import { describe, expect, it } from 'vitest';
import { autoDeployChatKey, isAutoDeployEnabled, shouldTriggerAutoDeploy, type AutoDeployGate } from './autoDeploy';

const ready: AutoDeployGate = {
  enabled: true,
  connected: true,
  isStreaming: false,
  hasPreview: true,
  sawGeneration: true,
  inFlight: false,
  alreadyDeployed: false,
};

describe('shouldTriggerAutoDeploy', () => {
  it('fires when every condition is met', () => {
    expect(shouldTriggerAutoDeploy(ready)).toBe(true);
  });

  it.each([
    ['the preference is off', { enabled: false }],
    ['Vercel is not connected', { connected: false }],
    ['the model is still writing', { isStreaming: true }],
    ['the preview is not up yet (deps still installing)', { hasPreview: false }],
    ['this page view only loaded an old chat', { sawGeneration: false }],
    ['a deploy is already running', { inFlight: true }],
    ['this chat was already shipped', { alreadyDeployed: true }],
  ])('stays out of the way when %s', (_label, override) => {
    expect(shouldTriggerAutoDeploy({ ...ready, ...override })).toBe(false);
  });
});

describe('isAutoDeployEnabled', () => {
  it('is off unless the user asked for it, so finishing a build never publishes', () => {
    expect(isAutoDeployEnabled(null)).toBe(false);
    expect(isAutoDeployEnabled(undefined)).toBe(false);
    expect(isAutoDeployEnabled('false')).toBe(false);
  });

  it('stays on for an explicit opt-in', () => {
    expect(isAutoDeployEnabled('true')).toBe(true);
  });
});

describe('autoDeployChatKey', () => {
  it('separates chats and tolerates an unpersisted one', () => {
    expect(autoDeployChatKey('abc')).toBe('chat:abc');
    expect(autoDeployChatKey(undefined)).toBe('chat:unpersisted');
    expect(autoDeployChatKey('abc')).not.toBe(autoDeployChatKey('def'));
  });
});
