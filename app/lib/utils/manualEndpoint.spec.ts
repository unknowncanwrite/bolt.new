import { describe, expect, it } from 'vitest';
import {
  MODEL_LIST_EDITABLE_PROVIDERS,
  checkEndpointUrl,
  modelsListToSpec,
  modelsSettingKey,
  specToModelsList,
} from './manualEndpoint';

describe('checkEndpointUrl', () => {
  it('accepts a well-formed gateway URL', () => {
    expect(checkEndpointUrl('https://api.router.tetrate.ai/v1')).toEqual({ url: 'https://api.router.tetrate.ai/v1' });
  });

  it('drops a trailing slash rather than producing a double one', () => {
    expect(checkEndpointUrl('http://localhost:1975/v1/').url).toBe('http://localhost:1975/v1');
  });

  it('refuses the operation path, which is the mistake that looks like an outage', () => {
    const result = checkEndpointUrl('https://api.router.tetrate.ai/v1/chat/completions');

    expect(result.url).toBeUndefined();
    expect(result.error).toContain('chat/completions');
  });

  it('suggests /v1 when only a host was pasted', () => {
    const result = checkEndpointUrl('https://api.router.tetrate.ai');

    expect(result.url).toBe('https://api.router.tetrate.ai/v1');
    expect(result.warning).toContain('Added /v1');
  });

  it('assumes https for a host typed without a scheme, and says so', () => {
    const result = checkEndpointUrl('gateway.internal:8080/v1');

    expect(result.url).toBe('https://gateway.internal:8080/v1');
    expect(result.warning).toContain('Assumed https');
  });

  it('keeps a non-standard path, because some gateways live under one', () => {
    expect(checkEndpointUrl('https://proxy.example.com/llm/openai/v1').url).toBe(
      'https://proxy.example.com/llm/openai/v1',
    );
  });

  it('warns about mixed content, except for a gateway on the same machine', () => {
    const remote = checkEndpointUrl('http://gateway.example.com/v1', { pageIsSecureContext: true });
    const local = checkEndpointUrl('http://localhost:1975/v1', { pageIsSecureContext: true });

    expect(remote.warning).toContain('refuse');
    expect(local.warning).toBeUndefined();
  });

  it('rejects anything a browser cannot call', () => {
    expect(checkEndpointUrl('javascript:alert(1)//').error).toContain('http');
    expect(checkEndpointUrl('   ').error).toContain('base URL');
  });
});

describe('model list field', () => {
  it('turns a friendly list into the stored spec', () => {
    expect(modelsListToSpec('claude-sonnet-4.6:200000, deepseek-v4-pro\nqwen2.5:0.5b')).toBe(
      'claude-sonnet-4.6:200000;deepseek-v4-pro;qwen2.5:0.5b',
    );
  });

  it('round-trips back into the input box', () => {
    expect(specToModelsList('a:128000;b')).toBe('a:128000, b');
    expect(specToModelsList(undefined)).toBe('');
  });

  it('only offers the list where it is read', () => {
    expect(MODEL_LIST_EDITABLE_PROVIDERS).toEqual(['OpenAILike', 'AgentRouter']);
    expect(modelsSettingKey('AgentRouter')).toBe('AGENTROUTER_API_MODELS');
    expect(modelsSettingKey('OpenAILike')).toBe('OPENAI_LIKE_API_MODELS');
    expect(modelsSettingKey('Anthropic')).toBeUndefined();
  });
});
