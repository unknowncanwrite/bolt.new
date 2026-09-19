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
 * Alibaba Cloud Model Studio (formerly DashScope) speaks the OpenAI protocol on a
 * `compatible-mode` endpoint. Every region/workspace gets its own host, e.g.
 *
 *   Singapore   https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
 *   Beijing     https://dashscope.aliyuncs.com/compatible-mode/v1
 *   Virginia    https://dashscope-us.aliyuncs.com/compatible-mode/v1
 *   Shared intl https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *
 * Set `DASHSCOPE_BASE_URL` to the URL printed in your Model Studio workspace; the
 * shared international host below is only a convenience default for plain `sk-` keys.
 */
const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

interface DashScopeModelEntry {
  id?: string;
  name?: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  context_window?: number;
  max_input_tokens?: number;
  max_tokens?: number;
  max_output_tokens?: number;
}

export default class DashScopeProvider extends BaseProvider {
  name = 'DashScope';
  getApiKeyLink = 'https://modelstudio.console.alibabacloud.com/?tab=globalset#/efm/api_key';
  labelForGetApiKey = 'Get Model Studio API Key';
  icon = 'i-ph:cloud-lightning';

  config = {
    baseUrlKey: 'DASHSCOPE_BASE_URL',
    apiTokenKey: 'DASHSCOPE_API_KEY',
    modelsKey: 'DASHSCOPE_API_MODELS',
    baseUrl: DEFAULT_DASHSCOPE_BASE_URL,
  };

  /**
   * Fallback catalogue, used when the endpoint does not expose `GET /models`
   * (several dedicated/privatelink workspaces do not).
   */
  staticModels: ModelInfo[] = [
    {
      name: 'qwen3-coder-plus',
      label: 'Qwen3 Coder Plus (1M context, best for coding)',
      provider: 'DashScope',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'qwen3-coder-flash',
      label: 'Qwen3 Coder Flash (1M context, fast coding)',
      provider: 'DashScope',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'qwen3.8-max',
      label: 'Qwen3.8 Max (flagship, 1M context)',
      provider: 'DashScope',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 131072,
    },
    {
      name: 'qwen3.8-flash',
      label: 'Qwen3.8 Flash (fast, 1M context)',
      provider: 'DashScope',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 131072,
    },
    {
      name: 'qwen3.7-max',
      label: 'Qwen3.7 Max (previous flagship)',
      provider: 'DashScope',
      maxTokenAllowed: 1000000,
      maxCompletionTokens: 65536,
    },
    {
      name: 'qwen3-max',
      label: 'Qwen3 Max',
      provider: 'DashScope',
      maxTokenAllowed: 262144,
      maxCompletionTokens: 65536,
    },
    {
      name: 'qwen-plus',
      label: 'Qwen Plus (cheap general purpose)',
      provider: 'DashScope',
      maxTokenAllowed: 131072,
      maxCompletionTokens: 16384,
    },
    {
      name: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro (hosted by Model Studio)',
      provider: 'DashScope',
      maxTokenAllowed: 131072,
      maxCompletionTokens: 65536,
    },
  ];

  /**
   * Normalize the endpoint so pasting the URL straight out of the Model Studio docs
   * always works: a missing `/v1`, a trailing slash or the full `/chat/completions`
   * path are all accepted.
   */
  private _resolveBaseUrl(baseUrl?: string): string {
    let normalized = (baseUrl ?? DEFAULT_DASHSCOPE_BASE_URL).trim().replace(/\/+$/, '');

    // Tolerate a pasted operation path instead of the base URL.
    normalized = normalized.replace(/\/(chat\/completions|completions|responses|models|embeddings)$/, '');

    if (/\/compatible-mode$/.test(normalized)) {
      normalized = `${normalized}/v1`;
    }

    return normalized;
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl: rawBaseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'DASHSCOPE_BASE_URL',
      defaultApiTokenKey: 'DASHSCOPE_API_KEY',
    });

    if (!apiKey) {
      return [];
    }

    const baseUrl = this._resolveBaseUrl(rawBaseUrl);

    // An explicit catalogue in DASHSCOPE_API_MODELS always wins over discovery.
    const pinned = parseEnvModelList(readProviderEnv(serverEnv, 'DASHSCOPE_API_MODELS'), this.name);

    if (pinned.length > 0) {
      logger.info(`DashScope: using ${pinned.length} pinned models from DASHSCOPE_API_MODELS`);

      return pinned;
    }

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload = (await response.json()) as unknown;
      const models = extractModelArray(payload) as DashScopeModelEntry[];
      const chatModels = models.filter((model) => typeof model?.id === 'string' && model.id.length > 0);

      if (chatModels.length === 0) {
        logger.warn('DashScope: /models returned no usable entries, falling back to the static catalogue');

        return this.staticModels;
      }

      return chatModels.map((model) => {
        const id = model.id as string;
        const maxTokenAllowed = clampContextWindow(
          firstNumber(model, ['context_length', 'context_window', 'max_input_tokens']) ?? this._guessContextWindow(id),
        );
        const maxCompletionTokens =
          firstNumber(model, ['max_output_tokens', 'max_tokens']) ?? this._guessCompletionTokens(id, maxTokenAllowed);

        return {
          name: id,
          label: `${prettifyModelId(id)} (${formatContextWindow(maxTokenAllowed)})`,
          provider: this.name,
          maxTokenAllowed,
          maxCompletionTokens,
        };
      });
    } catch (error) {
      logger.info('DashScope: could not list models from the endpoint, using the static catalogue', error);

      return this.staticModels;
    }
  }

  private _guessContextWindow(modelId: string): number {
    const id = modelId.toLowerCase();

    if (id.includes('coder') || id.includes('1m') || id.includes('max')) {
      return 1000000;
    }

    return 131072;
  }

  private _guessCompletionTokens(modelId: string, contextWindow: number): number {
    const id = modelId.toLowerCase();

    if (id.includes('coder') || id.includes('max')) {
      return 65536;
    }

    return Math.min(DEFAULT_COMPLETION_TOKENS, Math.floor(contextWindow / 4));
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
      defaultBaseUrlKey: 'DASHSCOPE_BASE_URL',
      defaultApiTokenKey: 'DASHSCOPE_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider. Set DASHSCOPE_API_KEY in .env.local`);
    }

    return getOpenAILikeModel(this._resolveBaseUrl(baseUrl), apiKey, model);
  }
}
