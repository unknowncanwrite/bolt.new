/**
 * Vercel token resolution for bolt's server routes.
 *
 * bolt.diy traditionally keeps the Vercel token in the browser (`VITE_VERCEL_ACCESS_TOKEN`
 * is inlined into the client bundle and then persisted in localStorage). That is fine for a
 * throwaway local token, but a token that deploys to production should stay on the server.
 *
 * These helpers let every Vercel route accept the token from either place, checked in order:
 *
 *   1. the token the caller passed explicitly (settings UI, manual deploy),
 *   2. the Cloudflare/worker env binding,
 *   3. `process.env` (populated from `.env.local` / `.env` by Vite + `bindings.sh`).
 *
 * Both `VERCEL_TOKEN` and `VITE_VERCEL_ACCESS_TOKEN` are honoured, so an existing bolt
 * setup keeps working unchanged while `VERCEL_TOKEN=vcp_...` alone is now enough.
 */

const VERCEL_TOKEN_ENV_KEYS = ['VERCEL_TOKEN', 'VITE_VERCEL_ACCESS_TOKEN', 'VERCEL_ACCESS_TOKEN', 'VERCEL_API_TOKEN'];

const isUsableToken = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('your_') && !value.includes('_here');

export function normalizeVercelToken(value: unknown): string | undefined {
  if (!isUsableToken(value)) {
    return undefined;
  }

  return value.trim();
}

function readProcessEnv(key: string): string | undefined {
  // The client bundle has no process.env (beyond the polyfilled NODE_ENV); guard for that.
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }

  return process.env[key];
}

/**
 * Resolve the token to use against the Vercel API.
 *
 * @param explicitToken token supplied by the caller (request body / query string)
 * @param cloudflareEnv `context.cloudflare?.env` of the current request
 */
export function resolveVercelToken(
  explicitToken?: string | null,
  cloudflareEnv?: Record<string, any>,
): string | undefined {
  const fromCaller = normalizeVercelToken(explicitToken);

  if (fromCaller) {
    return fromCaller;
  }

  for (const key of VERCEL_TOKEN_ENV_KEYS) {
    const fromBindings = normalizeVercelToken(cloudflareEnv?.[key]);

    if (fromBindings) {
      return fromBindings;
    }

    const fromProcess = normalizeVercelToken(readProcessEnv(key));

    if (fromProcess) {
      return fromProcess;
    }
  }

  return undefined;
}

/** Whether a token is available without the browser holding one (used to gate the deploy UI). */
export function hasServerVercelToken(cloudflareEnv?: Record<string, any>): boolean {
  return resolveVercelToken(undefined, cloudflareEnv) !== undefined;
}

export const VERCEL_TOKEN_MISSING_MESSAGE =
  'No Vercel token configured. Save one in Settings → Vercel, or set VERCEL_TOKEN in .env.local.';
