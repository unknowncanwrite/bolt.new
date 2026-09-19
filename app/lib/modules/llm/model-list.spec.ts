import { describe, expect, it } from 'vitest';
import {
  clampContextWindow,
  extractModelArray,
  firstNumber,
  formatContextWindow,
  parseEnvModelList,
  prettifyModelId,
  MAX_SAFE_CONTEXT_WINDOW,
} from './model-list';

describe('extractModelArray', () => {
  it('reads the OpenAI style payload', () => {
    const payload = { object: 'list', data: [{ id: 'qwen3-coder-plus', object: 'model' }] };

    expect(extractModelArray(payload)).toHaveLength(1);
  });

  it('reads a bare array', () => {
    expect(extractModelArray([{ id: 'a' }, { id: 'b' }])).toHaveLength(2);
  });

  it('reads providers that nest the list under `models`', () => {
    expect(extractModelArray({ models: [{ id: 'a' }] })).toHaveLength(1);
    expect(extractModelArray({ data: { models: [{ id: 'a' }, { id: 'b' }] } })).toHaveLength(2);
  });

  it('returns an empty list for unusable payloads', () => {
    expect(extractModelArray(undefined)).toEqual([]);
    expect(extractModelArray('nope')).toEqual([]);
    expect(extractModelArray({ html: '<html>' })).toEqual([]);
  });
});

describe('firstNumber', () => {
  it('picks the first finite, positive value', () => {
    expect(firstNumber({ context_length: 0, max_input_tokens: 32768 }, ['context_length', 'max_input_tokens'])).toBe(
      32768,
    );
    expect(firstNumber({ context_length: 131072 }, ['context_length'])).toBe(131072);
    expect(firstNumber({ context_length: '131072' }, ['context_length'])).toBeUndefined();
    expect(firstNumber(undefined, ['context_length'])).toBeUndefined();
  });
});

describe('clampContextWindow', () => {
  it('falls back to a sane default when the gateway hides the number', () => {
    expect(clampContextWindow(undefined)).toBe(128000);
    expect(clampContextWindow(-5)).toBe(128000);
  });

  it('caps absurd values', () => {
    expect(clampContextWindow(10_000_000)).toBe(MAX_SAFE_CONTEXT_WINDOW);
  });

  it('keeps advertised windows intact', () => {
    expect(clampContextWindow(1_000_000)).toBe(1_000_000);
    expect(clampContextWindow(262_144)).toBe(262_144);
  });
});

describe('formatContextWindow', () => {
  it('uses M for million token windows and k otherwise', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_048_576)).toBe('1M');
    expect(formatContextWindow(131_072)).toBe('131k');
  });
});

describe('parseEnvModelList', () => {
  it('parses id, context and completion limits', () => {
    const models = parseEnvModelList('qwen3-coder-plus:1000000:65536; deepseek-v4-pro:128000 ', 'DashScope');

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      name: 'qwen3-coder-plus',
      provider: 'DashScope',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 65536,
    });
    expect(models[1]).toMatchObject({ name: 'deepseek-v4-pro', maxTokenAllowed: 128000 });
    expect(models[1].maxCompletionTokens).toBeUndefined();
  });

  it('ignores empty input', () => {
    expect(parseEnvModelList(undefined, 'Xkiro')).toEqual([]);
    expect(parseEnvModelList(';;', 'Xkiro')).toEqual([]);
  });
});

describe('prettifyModelId', () => {
  it('shortens vendor prefixed ids', () => {
    expect(prettifyModelId('openai/gpt-5.6-sol')).toBe('Gpt 5.6 Sol');
    expect(prettifyModelId('qwen3-coder-plus')).toBe('Qwen3 Coder Plus');
  });
});
