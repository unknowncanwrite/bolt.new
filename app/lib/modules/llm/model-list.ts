import type { ModelInfo } from './types';

/**
 * Helpers shared by OpenAI-compatible providers (DashScope, Xkiro, ...) that need to
 * turn either a `/models` payload or an environment variable into bolt's `ModelInfo`.
 */

/** Fallback used when a gateway does not advertise a context window. */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** Fallback used when a gateway does not advertise a maximum output length. */
export const DEFAULT_COMPLETION_TOKENS = 16384;

/** Never let a provider advertise more context than the app is willing to fill. */
export const MAX_SAFE_CONTEXT_WINDOW = 1000000;

/**
 * Read the first numeric field present on a model payload.
 * Different OpenAI-compatible gateways use different names for the same thing.
 */
export function firstNumber(source: Record<string, any> | undefined, keys: string[]): number | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

export function clampContextWindow(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_WINDOW;
  }

  return Math.min(Math.floor(value), MAX_SAFE_CONTEXT_WINDOW);
}

export function formatContextWindow(value: number): string {
  if (value >= 1000000) {
    const millions = Math.round((value / 1000000) * 10) / 10;

    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions}M`;
  }

  return `${Math.max(1, Math.round(value / 1000))}k`;
}

/**
 * Look a provider variable up the way `BaseProvider` resolves keys: the request
 * environment (Cloudflare bindings in production) first, then `process.env`, which Vite
 * fills from `.env.local` / `.env` for the dev server and for `pnpm start`.
 */
export function readProviderEnv(serverEnv: Record<string, string> | undefined, key: string): string | undefined {
  const fromRequestEnv = serverEnv?.[key];

  if (fromRequestEnv) {
    return fromRequestEnv;
  }

  // The browser bundle has a stubbed `process`, so a missing value is handled quietly.
  if (typeof process !== 'undefined' && process?.env?.[key]) {
    return process.env[key];
  }

  return undefined;
}

/**
 * Extract the model array out of an OpenAI-compatible `/models` response.
 * Supported shapes: `{ data: [...] }`, `{ models: [...] }`, `{ body: { data: [...] } }` or a bare array.
 */
export function extractModelArray(payload: any): any[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  for (const container of [payload, payload.data, payload.body]) {
    if (Array.isArray(container)) {
      return container;
    }

    if (container && Array.isArray(container.models)) {
      return container.models;
    }
  }

  return [];
}

/**
 * Parse a pinned model list from an environment variable.
 *
 * Format: `model-id[:contextWindow[:maxCompletionTokens]];model-id[:contextWindow];...`
 * Example: `qwen3-coder-plus:1000000:65536;deepseek-v4-pro:128000`
 */
export function parseEnvModelList(envValue: string | undefined, providerName: string): ModelInfo[] {
  if (!envValue) {
    return [];
  }

  const models: ModelInfo[] = [];

  for (const entry of envValue.split(';')) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    const [name, context, completion] = trimmed.split(':').map((part) => part.trim());

    if (!name) {
      continue;
    }

    const maxTokenAllowed = clampContextWindow(context ? parseInt(context, 10) : undefined);
    const maxCompletionTokens = completion ? parseInt(completion, 10) : undefined;

    models.push({
      name,
      label: `${name} (${formatContextWindow(maxTokenAllowed)})`,
      provider: providerName,
      maxTokenAllowed,
      ...(maxCompletionTokens && maxCompletionTokens > 0 ? { maxCompletionTokens } : {}),
    });
  }

  return models;
}

/**
 * Human readable label for a model id, e.g. `vendor/qwen3.8-max:free` -> `Qwen3.8 Max:free`.
 * Falls back to the raw id when nothing nicer can be derived.
 */
export function prettifyModelId(modelId: string): string {
  const lastSegment = modelId.split('/').pop() ?? modelId;
  const spaced = lastSegment
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (_match, letter) => letter.toUpperCase())
    .trim();

  return spaced || modelId;
}
