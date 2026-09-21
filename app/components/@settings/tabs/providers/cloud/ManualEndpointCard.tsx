import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettings } from '~/lib/hooks/useSettings';
import { classNames } from '~/utils/classNames';
import { toast } from 'react-toastify';
import Cookies from 'js-cookie';
import { logStore } from '~/lib/stores/logs';
import { getApiKeysFromCookies } from '~/components/chat/APIKeyManager';
import { URL_CONFIGURABLE_PROVIDERS } from '~/lib/stores/settings';
import { PROVIDER_LIST } from '~/utils/constants';
import {
  MODEL_LIST_EDITABLE_PROVIDERS,
  checkEndpointUrl,
  modelsListToSpec,
  modelsSettingKey,
  specToModelsList,
} from '~/lib/utils/manualEndpoint';

const ENDPOINT_FIELDS = [
  {
    name: 'OpenAILike',
    envBase: 'OPENAI_LIKE_API_BASE_URL',
    envKey: 'OPENAI_LIKE_API_KEY',
    envModels: 'OPENAI_LIKE_API_MODELS',
  },
  {
    name: 'AgentRouter',
    envBase: 'AGENTROUTER_BASE_URL',
    envKey: 'AGENTROUTER_API_KEY',
    envModels: 'AGENTROUTER_API_MODELS',
  },
] as const;

const inputClass =
  'w-full px-3 py-2 rounded-lg text-sm bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary focus:outline-none focus:ring-2 focus:ring-purple-500/30 transition-all duration-200';

/**
 * Where a gateway, proxy or laptop-served model is pointed at: one URL, one key,
 * and (because the whole point of a router is that it decides what exists) an
 * optional model list. Everything here is a plain override of what .env would
 * say, stored per browser, so it works on a hosted deployment without a rebuild.
 */
const ManualEndpointCard = () => {
  const settings = useSettings();
  const [provider, setProvider] = useState<string>('OpenAILike');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; warning?: string }>({});

  const providerNames = useMemo(() => PROVIDER_LIST.map((p) => p.name).sort(), []);
  const urlConfigurable = URL_CONFIGURABLE_PROVIDERS.includes(provider);

  /* Load what is already set, so opening this panel shows the truth and not an empty form. */
  useEffect(() => {
    const current = settings.providers?.[provider]?.settings ?? {};
    const keys = getApiKeysFromCookies();

    setBaseUrl(current.baseUrl ?? '');
    setApiKey(keys[provider] ?? '');
    setModels(specToModelsList((current as Record<string, string | undefined>)[modelsSettingKey(provider) ?? '']));
    setFeedback({});
  }, [provider, settings.providers]);

  const handleSave = useCallback(() => {
    const check = checkEndpointUrl(baseUrl, {
      pageIsSecureContext: typeof window !== 'undefined' ? window.isSecureContext : undefined,
    });

    if (check.error) {
      setFeedback({ error: check.error });

      return;
    }

    setFeedback({ warning: check.warning });

    const url = check.url ?? '';
    const existing = settings.providers?.[provider]?.settings ?? {};
    const nextSettings: Record<string, any> = { ...existing, baseUrl: url || undefined };

    if (MODEL_LIST_EDITABLE_PROVIDERS.includes(provider)) {
      const key = modelsSettingKey(provider);

      if (key) {
        nextSettings[key] = modelsListToSpec(models) || undefined;
      }
    }

    settings.updateProviderSettings(provider, nextSettings);

    const cookieKeys = getApiKeysFromCookies();

    if (apiKey.trim()) {
      cookieKeys[provider] = apiKey.trim();
    } else {
      delete cookieKeys[provider];
    }

    Cookies.set('apiKeys', JSON.stringify(cookieKeys));

    logStore.logProvider(`Manual endpoint saved for ${provider}`, { provider, baseUrl: url });
    toast.success(
      url
        ? `${provider} now points at ${url} - used from the next message.`
        : `${provider} will use its default endpoint from the next message.`,
    );
  }, [apiKey, baseUrl, models, provider, settings]);

  const handleClear = useCallback(() => {
    const existing = settings.providers?.[provider]?.settings ?? {};
    const nextSettings: Record<string, any> = { ...existing, baseUrl: undefined };
    const modelsKey = modelsSettingKey(provider);

    if (modelsKey) {
      nextSettings[modelsKey] = undefined;
    }

    settings.updateProviderSettings(provider, nextSettings);

    const cookieKeys = getApiKeysFromCookies();
    delete cookieKeys[provider];
    Cookies.set('apiKeys', JSON.stringify(cookieKeys));

    setBaseUrl('');
    setModels('');
    setApiKey('');
    setFeedback({});
    toast.info(`${provider}: manual endpoint and key cleared`);
  }, [provider, settings]);

  const envLines = useMemo(() => {
    const field = ENDPOINT_FIELDS.find((entry) => entry.name === provider);
    const spec = modelsListToSpec(models);

    const lines = [
      `${field?.envBase ?? 'PROVIDER_API_BASE_URL'}=${baseUrl.trim() || 'https://your-gateway.example/v1'}`,
      `${field?.envKey ?? 'PROVIDER_API_KEY'}=paste-your-key`,
    ];

    if (field?.envModels && spec) {
      lines.push(`${field.envModels}=${spec}`);
    }

    return lines.join('\n');
  }, [baseUrl, models, provider]);

  return (
    <div
      className={classNames(
        'rounded-lg border bg-bolt-elements-background-depth-2 p-4 mb-6',
        'border-bolt-elements-borderColor',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <div className="flex items-start gap-3">
          <div
            className={classNames(
              'w-8 h-8 flex items-center justify-center rounded-lg shrink-0',
              'bg-bolt-elements-background-depth-3 text-purple-500',
            )}
          >
            <div className="i-ph:plug w-5 h-5" />
          </div>
          <div>
            <h4 className="text-md font-medium text-bolt-elements-textPrimary">Manual endpoint</h4>
            <p className="text-sm text-bolt-elements-textSecondary max-w-2xl">
              Point any provider at your own OpenAI-compatible URL - an agent router, LiteLLM, vLLM, a corporate proxy -
              and paste the key here instead of editing .env and rebuilding.
            </p>
          </div>
        </div>
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          className={classNames(inputClass, 'w-auto min-w-[12rem]')}
          aria-label="Provider to configure"
        >
          {providerNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {!urlConfigurable && (
        <p className="text-xs text-amber-500 mt-2">
          {provider} builds its request through its own vendor SDK, so only the key applies here - the URL is stored but
          not read. Pick &quot;OpenAILike&quot; (any OpenAI-compatible endpoint) or &quot;AgentRouter&quot; to route it
          somewhere else.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        <label className="block">
          <span className="text-xs text-bolt-elements-textSecondary">Base URL</span>
          <input
            type="text"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.router.tetrate.ai/v1 or http://localhost:1975/v1"
            className={classNames(inputClass, 'font-mono', feedback.error && 'border-red-500')}
            spellCheck={false}
          />
        </label>

        <label className="block">
          <span className="text-xs text-bolt-elements-textSecondary">API key (kept in this browser)</span>
          <div className="flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
              className={classNames(inputClass, 'font-mono')}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              className="px-2 py-1 rounded-lg text-xs text-bolt-elements-textSecondary hover:text-purple-500 border border-bolt-elements-borderColor"
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>
      </div>

      {MODEL_LIST_EDITABLE_PROVIDERS.includes(provider) && (
        <label className="block mt-3">
          <span className="text-xs text-bolt-elements-textSecondary">
            Models (optional - comma separated, and only needed if the endpoint does not list them)
          </span>
          <input
            type="text"
            value={models}
            onChange={(event) => setModels(event.target.value)}
            placeholder="claude-sonnet-4.6:200000, deepseek-v4-pro, qwen2.5:0.5b"
            className={classNames(inputClass, 'font-mono mt-1')}
            spellCheck={false}
          />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button
          type="button"
          onClick={handleSave}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-purple-500 text-white hover:bg-purple-600 transition-colors"
        >
          Save endpoint
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="px-3 py-1.5 rounded-lg text-sm border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
        >
          Clear
        </button>

        {feedback.error && <span className="text-xs text-red-500">{feedback.error}</span>}
        {!feedback.error && feedback.warning && <span className="text-xs text-amber-500">{feedback.warning}</span>}
      </div>

      <details className="mt-3">
        <summary className="text-xs text-bolt-elements-textSecondary cursor-pointer">
          Same settings as environment variables
        </summary>
        <pre className="mt-2 p-2 rounded bg-bolt-elements-background-depth-3 text-xs font-mono whitespace-pre-wrap text-bolt-elements-textSecondary">
          {envLines}
        </pre>
        <p className="mt-1 text-xs text-bolt-elements-textTertiary">
          Useful when the deployment is shared: env vars apply for everyone, this panel applies to this browser only.
        </p>
      </details>
    </div>
  );
};

export default ManualEndpointCard;
