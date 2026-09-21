import { describe, expect, it } from 'vitest';

/*
 * `~/utils/constants` builds the provider registry the way the app does. Importing
 * the provider file directly would evaluate it before BaseProvider finished
 * loading, because the registry imports every provider in turn - which the app
 * never hits, since constants is loaded first there.
 */
import { PROVIDER_LIST } from '~/utils/constants';
import AgentRouterProvider, { isLocalGatewayUrl, normalizeGatewayBaseUrl } from './providers/agent-router';

describe('normalizeGatewayBaseUrl', () => {
  it('defaults to the hosted service', () => {
    expect(normalizeGatewayBaseUrl()).toBe('https://api.router.tetrate.ai/v1');
    expect(normalizeGatewayBaseUrl('   ')).toBe('https://api.router.tetrate.ai/v1');
  });

  it('adds /v1 to a bare host and strips an operation path', () => {
    expect(normalizeGatewayBaseUrl('https://api.router.tetrate.ai')).toBe('https://api.router.tetrate.ai/v1');
    expect(normalizeGatewayBaseUrl('https://api.router.tetrate.ai/v1/chat/completions')).toBe(
      'https://api.router.tetrate.ai/v1',
    );
    expect(normalizeGatewayBaseUrl('http://localhost:1975/v1/')).toBe('http://localhost:1975/v1');
  });

  it('keeps a custom prefix that the operator chose', () => {
    expect(normalizeGatewayBaseUrl('https://proxy.example.com/llm/v1')).toBe('https://proxy.example.com/llm/v1');
    expect(normalizeGatewayBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
  });
});

describe('isLocalGatewayUrl', () => {
  it('recognises a gateway on the same machine', () => {
    expect(isLocalGatewayUrl('http://localhost:1975/v1')).toBe(true);
    expect(isLocalGatewayUrl('http://127.0.0.1:1975/v1')).toBe(true);
    expect(isLocalGatewayUrl('https://api.router.tetrate.ai/v1')).toBe(false);
  });
});

describe('AgentRouterProvider', () => {
  it('is registered as its own provider with a usable fallback', () => {
    const provider = new AgentRouterProvider();

    expect(PROVIDER_LIST.map((entry) => entry.name)).toContain('AgentRouter');

    expect(provider.name).toBe('AgentRouter');
    expect(provider.staticModels.length).toBeGreaterThan(0);
    expect(provider.staticModels.every((model) => model.provider === 'AgentRouter')).toBe(true);
    expect(provider.config.baseUrlKey).toBe('AGENTROUTER_BASE_URL');
  });

  it('prefers a pinned model list and does not touch the network for it', async () => {
    const provider = new AgentRouterProvider();
    const models = await provider.getDynamicModels(undefined, undefined, {
      AGENTROUTER_API_MODELS: 'claude-sonnet-4.6:200000:32000;deepseek-v4-pro:131072',
    });

    expect(models.map((model) => model.name)).toEqual(['claude-sonnet-4.6', 'deepseek-v4-pro']);
    expect(models[0].maxCompletionTokens).toBe(32000);
  });

  it('falls back to the catalogue when the gateway will not list models', async () => {
    const provider = new AgentRouterProvider();
    const original = globalThis.fetch;

    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;

    try {
      const models = await provider.getDynamicModels({ AgentRouter: 'sk-test' }, { baseUrl: 'http://localhost:1975' });

      expect(models).toEqual(provider.staticModels);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reads a real /models response', async () => {
    const provider = new AgentRouterProvider();
    const original = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', owned_by: 'openai', context_length: 128000 },
            { id: '', object: 'model' },
            { name: 'entry-without-an-id' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const models = await provider.getDynamicModels({ AgentRouter: 'sk-test' }, {});

      expect(models.map((model) => model.name)).toEqual(['gpt-4o']);
      expect(models[0].maxTokenAllowed).toBe(128000);
      expect(models[0].label).toContain('128k');
      expect(models[0].label).toContain('Gpt 4o');
      expect(models[0].label).toContain('openai');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('demands a key for a hosted gateway and not for one on localhost', () => {
    const provider = new AgentRouterProvider();

    expect(() =>
      provider.getModelInstance({ model: 'gpt-4o', serverEnv: {} as Env, providerSettings: { AgentRouter: {} } }),
    ).toThrow(/AGENTROUTER_API_KEY/);

    expect(() =>
      provider.getModelInstance({
        model: 'qwen2.5:0.5b',
        serverEnv: {} as Env,
        apiKeys: {},
        providerSettings: { AgentRouter: { baseUrl: 'http://localhost:1975/v1' } },
      }),
    ).not.toThrow();
  });
});
