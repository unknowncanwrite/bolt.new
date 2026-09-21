/**
 * Logic behind Settings → Providers → "Manual endpoint".
 *
 * Pointing Bolt at a gateway (Agent Router, LiteLLM, vLLM, OpenRouter-style
 * proxies, a local `aigw run`) is normally two values: a base URL and a key. Both
 * are easy to get subtly wrong - a trailing slash, a pasted `/chat/completions`,
 * a missing `/v1`, an `http://` URL on an `https://` page - and every one of
 * those failures produces a request that looks like the provider is broken rather
 * than a typo in a settings box. So the checks live here, away from the form,
 * where they can be tested.
 */

/** The SDK appends this itself; pasting it in is the single most common mistake. */
const OPERATION_SUFFIX = /\/(chat\/completions|completions|responses|embeddings|models)\/?$/i;

export interface EndpointUrlCheck {
  /** Normalized value to store, absent when the input cannot be used. */
  url?: string;

  /** Blocks saving. */
  error?: string;

  /** Saved anyway, because it is often exactly what the user means. */
  warning?: string;
}

export function checkEndpointUrl(input: string, options: { pageIsSecureContext?: boolean } = {}): EndpointUrlCheck {
  const raw = (input ?? '').trim();

  if (!raw) {
    return { error: 'Enter the base URL your gateway listens on, for example https://api.router.tetrate.ai/v1.' };
  }

  const withoutScheme = /^\s*(?:https?|file):\/\//i.test(raw) ? raw : `https://${raw}`;
  const schemeWasMissing = withoutScheme !== raw;

  let parsed: URL;

  try {
    parsed = new URL(withoutScheme);
  } catch {
    return { error: 'That is not a URL your browser can call. Use http:// or https:// followed by a host.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Only http and https endpoints can be used (got ${parsed.protocol.replace(':', '')}).` };
  }

  const isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal'].includes(
    parsed.hostname,
  );

  if (OPERATION_SUFFIX.test(parsed.pathname)) {
    return {
      error:
        'Drop the trailing /chat/completions (or /models): Bolt calls those itself. The base URL ends where the version does, usually /v1.',
    };
  }

  let url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');

  if (parsed.search || parsed.hash) {
    url += `${parsed.search}${parsed.hash}`.replace(/(\?|&)$/, '');
  }

  const warningParts: string[] = [];

  if (schemeWasMissing) {
    warningParts.push('Assumed https:// - add the scheme if the endpoint is plain http.');
  }

  if (url === parsed.origin) {
    /*
     * Almost every OpenAI-compatible gateway is mounted at /v1, and the request
     * layer adds it too - so add it here as well, and say so, rather than
     * storing a URL that will be quietly rewritten later.
     */
    url = `${url}/v1`;
    warningParts.push('Added /v1, where OpenAI-compatible endpoints usually live - clear it if yours is at the root.');
  }

  if (parsed.protocol === 'http:' && !isLocal && options.pageIsSecureContext) {
    warningParts.push(
      'This page is https, so the browser will refuse to call an http endpoint. Use https, or open Bolt on localhost.',
    );
  }

  return { url, ...(warningParts.length ? { warning: warningParts.join(' ') } : {}) };
}

/**
 * The Models box is friendlier as a comma- or newline-separated list, but the
 * stored format (the same one the `*_API_MODELS` environment variables use) is
 * `id[:contextWindow[:completionTokens]];...`. Parse one, emit the other.
 */
export function modelsListToSpec(input: string): string {
  const entries = (input ?? '')
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.map((entry) => entry.replace(/\s+/g, '')).join(';');
}

export function specToModelsList(spec: string | undefined): string {
  if (!spec) {
    return '';
  }

  return spec
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(', ');
}

/** Providers whose model list can be typed by hand rather than discovered. */
export const MODEL_LIST_EDITABLE_PROVIDERS = ['OpenAILike', 'AgentRouter'];

/** The settings field each provider keeps its pinned model list in. */
const MODELS_SETTING_KEY: Record<string, string> = {
  OpenAILike: 'OPENAI_LIKE_API_MODELS',
  AgentRouter: 'AGENTROUTER_API_MODELS',
};

export function modelsSettingKey(provider: string): string | undefined {
  return MODELS_SETTING_KEY[provider];
}
