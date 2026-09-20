/**
 * Minimal Node runtime for bolt.diy.
 *
 * The Cloudflare Pages entry point (`functions/[[path]].ts`) runs the SSR build
 * inside workerd via `wrangler pages dev`. That harness is a dev server: it boots
 * miniflare plus a workerd isolate, which measured ~850 MB of RSS before the app
 * handled a single request, so it does not fit a 512 MB container.
 *
 * This file serves the *same* `build/server` bundle from plain Node instead.
 * Measured on this repo's own build: ~140 MB idle, ~265 MB after rendering the
 * document plus a few API routes. Nothing else about the app changes:
 *
 *   - The build is byte-identical to the one Cloudflare Pages gets. No fork of
 *     the app code, no alternate vite config, no `mode`/`future` drift.
 *   - Load context matches what `@remix-run/cloudflare-pages` provides, so the
 *     8 call sites of `context.cloudflare?.env` (api.chat, api.enhancer,
 *     api.llmcall, api.models, api.configured-providers, ...) keep resolving keys
 *     from the server environment. Node gives us `process.env` directly, which
 *     is also the documented fallback in `base-provider.ts`, so *every* variable
 *     in the container env reaches the app - the `bindings.sh` allowlist that
 *     workerd deployments need is not in play here.
 *   - `AbortSignal` is wired from socket to `Request`, which is what keeps
 *     "stop generation" working: Pages aborts the request when the visitor
 *     disconnects, and without the same behaviour a cancelled chat would keep
 *     streaming from the provider and keep being billed.
 *   - Static assets are served from `build/client` (what `env.ASSETS.fetch` does
 *     on Pages), preferring the `.br`/`.gz` siblings emitted by
 *     `scripts/compress-client-assets.mjs`, so the ~16 MB of hashed JS/CSS ships
 *     as ~4 MB without spending this container's CPU on compressing per request.
 *
 * Deviations that are deliberate: `caches`, `waitUntil`, and `cf` are not
 * provided because nothing in this repo reads them (grep for `\.caches\b`,
 * `waitUntil`, `\.cf\b` in `app/` returns nothing). If a future route needs
 * them, add them here rather than switching the runtime back.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '@remix-run/cloudflare';
import { Readable } from 'node:stream';

/*
 * ---------------------------------------------------------------------------
 * react-dom/server: the SSR bundle imports `renderToReadableStream` from it.
 * That export only exists in the *browser* build, which is what workerd picks
 * (its resolve conditions are browser-like). Node picks `server.node.js`, which
 * has renderToPipeableStream instead, so linking the bundle fails with
 * "Named export 'renderToReadableStream' not found". Remapping this one
 * specifier is the entire port; `react-dom/server.browser` uses only Web Streams,
 * which Node has natively since 18.
 * ------------------------------------------------------------------------
 */
const specifierAliases = new Map([['react-dom/server', 'react-dom/server.browser']]);

try {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const alias = specifierAliases.get(specifier);
      return nextResolve(alias ?? specifier, context);
    },
  });
} catch (error) {
  if (error?.code !== 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    throw new Error(
      'server.mjs needs `module.registerHooks` (Node >= 22.15) to alias ' +
        'react-dom/server, and it is unavailable here. Either upgrade Node or ' +
        'start the server with NODE_OPTIONS=--conditions=browser.',
      { cause: error },
    );
  }
}

const clientBuild = fileURLToPath(new URL('./build/client', import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Vite fingerprints everything under /assets/, so those can never go stale.
const isHashedAsset = (pathname) => pathname.startsWith('/assets/');

/**
 * Pick the smallest encoding the client accepts. Files are precompressed at
 * build time; the original stays on disk for clients that accept nothing.
 */
async function pickEncoding(file, acceptEncoding = '') {
  const accepts = (token) => acceptEncoding.toLowerCase().includes(token);

  for (const [token, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ]) {
    if (!accepts(token)) {
      continue;
    }

    try {
      const info = await stat(`${file}${suffix}`);

      if (info.isFile()) {
        return { encoding: token, file: `${file}${suffix}`, size: info.size };
      }
    } catch {
      // no precompressed sibling, fall through
    }
  }

  return { encoding: null, file, size: null };
}

function toRequestHeaders(req) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  /*
   * Render terminates TLS at its proxy, so the forwarded proto/host are the
   * ones that belong in absolute URLs the app builds from `request.url`.
   */
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];

  return { headers, forwardedProto, forwardedHost };
}

async function serveStatic(req, res, pathname) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(clientBuild, safePath);

  if (!file.startsWith(clientBuild)) {
    return false;
  }

  let info;

  try {
    info = await stat(file);
  } catch {
    return false;
  }

  if (!info.isFile()) {
    return false;
  }

  const { encoding, file: servedFile, size } = await pickEncoding(file, req.headers['accept-encoding'] ?? '');
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const etag = `"${(size ?? info.size).toString(16)}-${info.mtimeMs.toString(16)}${encoding ?? ''}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, vary: 'Accept-Encoding' });
    res.end();

    return true;
  }

  res.writeHead(200, {
    'content-type': type,
    'cache-control': isHashedAsset(pathname) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'accept-ranges': 'bytes',
    vary: 'Accept-Encoding',
    etag,
    ...(encoding ? { 'content-encoding': encoding } : {}),
    'content-length': String(size ?? info.size),
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  createReadStream(servedFile).pipe(res);

  return true;
}

function requestOrigin(req, forwardedProto, forwardedHost) {
  const proto = forwardedProto ?? (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${forwardedHost ?? req.headers.host}`;
}

let handler;

async function loadServerBuild() {
  const build = await import('./build/server/index.js');
  handler = createRequestHandler(build, build.mode ?? 'production');
}

async function onRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { headers, forwardedProto, forwardedHost } = toRequestHeaders(req);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (await serveStatic(req, res, url.pathname)) {
      return;
    }
  }

  /*
   * Aborting the controller is what propagates "the visitor hung up" into the
   * provider stream; see the note at the top of this file.
   */
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('client disconnected'));
  res.on('close', () => {
    if (!res.writableEnded) {
      abort();
    }
  });
  req.on('error', abort);

  try {
    const request = new Request(
      new URL(`${url.pathname}${url.search}`, requestOrigin(req, forwardedProto, forwardedHost)),
      {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: req.method === 'GET' || req.method === 'HEAD' ? undefined : 'half',
        signal: controller.signal,
      },
    );

    const response = await handler(request, {
      cloudflare: {
        env: process.env,
        request,
        cf: undefined,
        ctx: { waitUntil() {}, passThroughOnException() {} },
        caches: undefined,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
    });

    const outHeaders = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });

    res.writeHead(response.status, outHeaders);

    if (response.body) {
      await new Promise((resolve, reject) => {
        const source = Readable.fromWeb(response.body);
        source.on('error', reject);
        res.on('error', reject);
        res.on('finish', resolve);
        source.pipe(res);
      });
    }

    res.end();
  } catch (error) {
    // A client that hangs up mid-stream is expected, not an incident.
    if (controller.signal.aborted) {
      res.end();
      return;
    }

    console.error('request failed:', url.pathname, error?.message ?? error);

    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'internal', message: String(error?.message ?? error) }));
    } else {
      res.end();
    }
  }
}

async function main() {
  await loadServerBuild();

  const server = createServer(onRequest);

  // Long-lived chat streams must not be cut by Node's defaults.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 65_000;

  server.listen(port, host, () => {
    console.log(`bolt.diy listening on http://${host}:${port}`);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));

      // Render kills hard after a grace period; don't outlive a close hang.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch((error) => {
  console.error('failed to start server:', error);
  process.exit(1);
});
