import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';
import {
  clampContextWindow,
  extractModelArray,
  firstNumber,
  formatContextWindow,
  parseEnvModelList,
  prettifyModelId,
  readProviderEnv,
  DEFAULT_COMPLETION_TOKENS,
} from '~/lib/modules/llm/model-list';

/**
 * xKiro (https://xkiro.com) is a multi-vendor gateway that speaks the OpenAI Chat
 * Completions protocol: `https://api.xkiro.com/v1`. Model ids are always prefixed
 * with the vendor (`openai/gpt-5.6-sol`); the bare model name 404s, so ids are passed
 * through untouched.
 *
 * `GET /v1/models` is public and returns the live catalogue together with the
 * metadata bolt needs (context window, max output, price, access tier).
 */
const DEFAULT_XKIRO_BASE_URL = 'https://api.xkiro.com/v1';

interface XkiroModelEntry {
  id?: string;
  display_name?: string;
  owned_by?: string;
  access_tier?: 'free' | 'paid' | 'premium' | string;
  context_length?: number;
  max_output_tokens?: number;
  pricing?: {
    input?: number;
    output?: number;
  };
  capabilities?: {
    vision?: boolean;
    tools?: boolean;
    reasoning?: boolean;
  };
}

export default class XkiroProvider extends BaseProvider {
  name = 'Xkiro';
  getApiKeyLink = 'https://xkiro.com/dashboard/settings/api-keys';
  labelForGetApiKey = 'Get xKiro API Key';
  icon = 'i-ph:sparkle';

  config = {
    baseUrlKey: 'XKIRO_BASE_URL',
    apiTokenKey: 'XKIRO_API_KEY',
    modelsKey: 'XKIRO_API_MODELS',
    baseUrl: DEFAULT_XKIRO_BASE_URL,
  };

  /**
   * Fallback catalogue (snapshot of the xKiro docs). The live list from
   * `GET /models` replaces these whenever the endpoint is reachable.
   */
  staticModels: ModelInfo[] = [
    {
      name: 'openai/gpt-5.6-sol',
      label: 'GPT-5.6 Sol via xKiro (agentic coding)',
      provider: 'Xkiro',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 131072,
    },
    {
      name: 'openai/gpt-5.3-codex-spark',
      label: 'GPT-5.3 Codex Spark via xKiro (low latency coding)',
      provider: 'Xkiro',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'anthropic/claude-opus-4.8',
      label: 'Claude Opus 4.8 via xKiro',
      provider: 'Xkiro',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'z-ai/glm-5.3',
      label: 'GLM 5.3 via xKiro (200k)',
      provider: 'Xkiro',
      maxTokenAllowed: 200000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'qwen/qwen3.8-max:free',
      label: 'Qwen3.8 Max via xKiro (free tier)',
      provider: 'Xkiro',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash via xKiro (free tier)',
      provider: 'Xkiro',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 16384,
    },
  ];

  private _resolveBaseUrl(baseUrl?: string): string {
    let normalized = (baseUrl ?? DEFAULT_XKIRO_BASE_URL).trim().replace(/\/+$/, '');

    normalized = normalized.replace(/\/(chat\/completions|completions|responses|messages|models)$/, '');

    if (normalized === 'https://api.xkiro.com') {
      normalized = `${normalized}/v1`;
    }

    return normalized;
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'XKIRO_BASE_URL',
      defaultApiTokenKey: 'XKIRO_API_KEY',
    });

    // An explicit catalogue in XKIRO_API_MODELS always wins over discovery.
    const pinned = parseEnvModelList(readProviderEnv(serverEnv, 'XKIRO_API_MODELS'), this.name);

    if (pinned.length > 0) {
      logger.info(`Xkiro: using ${pinned.length} pinned models from XKIRO_API_MODELS`);

      return pinned;
    }

    const resolvedBaseUrl = this._resolveBaseUrl(baseUrl);

    try {
      const response = await fetch(`${resolvedBaseUrl}/models?modality=chat`, {
        headers: {
          Accept: 'application/json',

          /*
           * The catalogue is public, but forwarding the key keeps the call working on
           * gateways that require auth on every route.
           */
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload = (await response.json()) as unknown;
      const models = (extractModelArray(payload) as XkiroModelEntry[]).filter(
        (model) => typeof model?.id === 'string' && model.id.includes('/'),
      );

      if (models.length === 0) {
        logger.warn('Xkiro: /models returned no usable entries, falling back to the static catalogue');

        return this.staticModels;
      }

      return models.map((model) => {
        const id = model.id as string;
        const maxTokenAllowed = clampContextWindow(firstNumber(model, ['context_length', 'context_window']));
        const maxCompletionTokens = firstNumber(model, ['max_output_tokens']) ?? DEFAULT_COMPLETION_TOKENS;
        const name = model.display_name?.trim() || prettifyModelId(id);
        const details: string[] = [formatContextWindow(maxTokenAllowed)];

        if (model.access_tier) {
          details.push(model.access_tier);
        }

        if (model.capabilities?.tools) {
          details.push('tools');
        }

        const pricing = this._formatPricing(model);

        if (pricing) {
          details.push(pricing);
        }

        return {
          name: id,
          label: `${name} (${details.join(' · ')})`,
          provider: this.name,
          maxTokenAllowed,
          maxCompletionTokens,
        };
      });
    } catch (error) {
      logger.info('Xkiro: could not list models from the endpoint, using the static catalogue', error);

      return this.staticModels;
    }
  }

  private _formatPricing(model: XkiroModelEntry): string | undefined {
    const input = model.pricing?.input;
    const output = model.pricing?.output;

    if (typeof input !== 'number' || typeof output !== 'number') {
      return undefined;
    }

    if (input === 0 && output === 0) {
      return 'free';
    }

    return `$${input.toFixed(2)}/$${output.toFixed(2)} per 1M`;
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: envRecord,
      defaultBaseUrlKey: 'XKIRO_BASE_URL',
      defaultApiTokenKey: 'XKIRO_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider. Set XKIRO_API_KEY in .env.local`);
    }

    return getOpenAILikeModel(this._resolveBaseUrl(baseUrl), apiKey, model);
  }
}
