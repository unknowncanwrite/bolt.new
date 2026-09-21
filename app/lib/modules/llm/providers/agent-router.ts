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
 * Agent Router (theagentrouter.ai, formerly Envoy AI Gateway) is not a model
 * vendor. It is an OpenAI-compatible gateway that fronts whichever providers you
 * configure - OpenAI, Anthropic, Bedrock, Vertex, vLLM, Ollama - behind one
 * endpoint and one key, so switching models is changing a name instead of
 * rewiring the app. Two ways to reach one:
 *
 *   hosted        https://api.router.tetrate.ai/v1   (Tetrate Agent Router Service)
 *   self-hosted   http://localhost:1975/v1            (`aigw run`)
 *
 * Both are accepted here, and the URL can be typed in Settings → Providers →
 * Manual endpoint, which wins over the environment. What the gateway exposes as
 * models is its operator's decision, so the list is discovered from `GET /models`
 * and can be pinned with `AGENTROUTER_API_MODELS` (`id[:context[:completion]];…`).
 */
const DEFAULT_AGENT_ROUTER_BASE_URL = 'https://api.router.tetrate.ai/v1';

/** Gateways on a laptop are often cold-starting, so listing gets more time than most. */
const LISTING_TIMEOUT_MS = 10_000;

/** An operation path pasted instead of the base URL. */
const OPERATION_PATH = /\/(chat\/completions|completions|responses|embeddings|models)\/?$/i;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal'];

interface GatewayModelEntry {
  id?: string;
  name?: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  context_window?: number;
  max_input_tokens?: number;
}

/**
 * Tolerate every shape of pasted endpoint: missing scheme, trailing slash, a
 * whole `/chat/completions` URL, or a bare host where the OpenAI paths live at
 * `/v1`. Exported so the rules can be tested without a network or a class.
 */
export function normalizeGatewayBaseUrl(input?: string): string {
  const raw = (input ?? DEFAULT_AGENT_ROUTER_BASE_URL).trim();

  if (!raw) {
    return DEFAULT_AGENT_ROUTER_BASE_URL;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url = withScheme.replace(/\/+$/, '');
  url = url.replace(OPERATION_PATH, '');

  let parsed: URL | undefined;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    url = `${url}/v1`;
  }

  return url;
}

/** Whether the gateway runs next door, where a key is often not checked at all. */
export function isLocalGatewayUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export default class AgentRouterProvider extends BaseProvider {
  name = 'AgentRouter';
  getApiKeyLink = 'https://theagentrouter.ai/docs/';
  labelForGetApiKey = 'Gateway docs';
  icon = 'i-ph:funnel';

  config = {
    baseUrlKey: 'AGENTROUTER_BASE_URL',
    apiTokenKey: 'AGENTROUTER_API_KEY',
    modelsKey: 'AGENTROUTER_API_MODELS',
    baseUrl: DEFAULT_AGENT_ROUTER_BASE_URL,
  };

  /**
   * A gateway's catalogue belongs to whoever runs it, so there is no honest list
   * to ship. These are the examples from the gateway's own quick start - enough
   * that a first run against `aigw run` has something selectable when the
   * endpoint does not implement `GET /models`. Listing the real models in
   * Settings (or in `AGENTROUTER_API_MODELS`) replaces this immediately.
   */
  staticModels: ModelInfo[] = [
    {
      name: 'qwen2.5:0.5b',
      label: 'qwen2.5:0.5b (32K, through the gateway)',
      provider: 'AgentRouter',
      maxTokenAllowed: 32768,
    },
    {
      name: 'gpt-4o',
      label: 'gpt-4o (128K, through the gateway)',
      provider: 'AgentRouter',
      maxTokenAllowed: 128000,
    },
  ];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'AGENTROUTER_BASE_URL',
      defaultApiTokenKey: 'AGENTROUTER_API_KEY',
    });

    // An explicit list always wins: it is what the operator typed, not a guess.
    const pinned = parseEnvModelList(
      readProviderEnv(serverEnv, 'AGENTROUTER_API_MODELS') ?? settings?.AGENTROUTER_API_MODELS,
      this.name,
    );

    if (pinned.length > 0) {
      logger.info(`AgentRouter: using ${pinned.length} pinned models`);

      return pinned;
    }

    const resolved = normalizeGatewayBaseUrl(baseUrl);

    try {
      const response = await fetch(`${resolved}/models`, {
        /*
         * A gateway on localhost frequently has no auth at all; sending a header
         * it does not expect is the kind of thing that makes a 400.
         */
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        signal: this.createTimeoutSignal(LISTING_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const models = extractModelArray((await response.json()) as unknown) as GatewayModelEntry[];
      const usable = models.filter((model) => typeof model?.id === 'string' && model.id.length > 0);

      if (usable.length === 0) {
        logger.warn('AgentRouter: the gateway listed no usable models, using the fallback catalogue');

        return this.staticModels;
      }

      return usable.map((model) => {
        const id = model.id as string;
        const maxTokenAllowed = clampContextWindow(
          firstNumber(model, ['context_length', 'context_window', 'max_input_tokens']) ?? 128000,
        );

        return {
          name: id,
          label: `${prettifyModelId(id)} (${formatContextWindow(maxTokenAllowed)}${
            model.owned_by ? `, ${model.owned_by}` : ''
          })`,
          provider: this.name,
          maxTokenAllowed,
          maxCompletionTokens: Math.min(DEFAULT_COMPLETION_TOKENS, Math.floor(maxTokenAllowed / 4)),
        };
      });
    } catch (error) {
      logger.info('AgentRouter: could not list models from the gateway, using the fallback catalogue', error);

      return this.staticModels;
    }
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
      defaultBaseUrlKey: 'AGENTROUTER_BASE_URL',
      defaultApiTokenKey: 'AGENTROUTER_API_KEY',
    });

    const resolved = normalizeGatewayBaseUrl(baseUrl);
    const effectiveApiKey = apiKey ?? (isLocalGatewayUrl(resolved) ? 'unused' : undefined);

    if (!effectiveApiKey) {
      throw new Error(
        `Missing API key for ${this.name}. Add it under Settings → Providers → Manual endpoint, or set AGENTROUTER_API_KEY in .env.local.`,
      );
    }

    return getOpenAILikeModel(resolved, effectiveApiKey, model);
  }
}
