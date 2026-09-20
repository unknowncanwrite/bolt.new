# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# CI-friendly env
ENV HUSKY=0
ENV CI=true

# Use pnpm
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Ensure git is available for build and runtime scripts
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Accept (optional) build-time public URL for Remix/Vite (Coolify can pass it)
ARG VITE_PUBLIC_APP_URL
ENV VITE_PUBLIC_APP_URL=${VITE_PUBLIC_APP_URL}

# Optional build-time UI defaults (Vite inlines VITE_* at build time, so these
# can only be ARGs here, never runtime env vars).
ARG VITE_DEFAULT_PROVIDER
ARG VITE_DEFAULT_MODEL
ENV VITE_DEFAULT_PROVIDER=${VITE_DEFAULT_PROVIDER} \
    VITE_DEFAULT_MODEL=${VITE_DEFAULT_MODEL}

# Install deps efficiently
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch

# Copy source and build
COPY . .
# Install with dev deps: they are needed to build *and* to serve. The production
# stage therefore starts from this stage instead of pruning - see below.
RUN pnpm install --offline --frozen-lockfile

# Build the Remix app (SSR + client).
#
# 2560 MB is measured, not guessed: this build aborts in V8 at a 1800 MB cap and
# completes at 2560 MB (the whole build stays under ~3 GB resident here). Render
# does not document its build-machine RAM, so the smallest cap that provably
# works is the safest one - a higher cap only raises the ceiling, it never makes
# the build need less memory. Raise it if your fork grows.
RUN NODE_OPTIONS=--max-old-space-size=2560 pnpm run build

# ---- development stage ----
FROM build AS development

# Non-sensitive development arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables for development
ENV VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Note: API keys should be provided at runtime via docker run -e or docker-compose
# Example: docker run -e OPENAI_API_KEY=your_key_here ...

RUN mkdir -p /app/run
CMD ["pnpm", "run", "dev", "--host"]


# ---- production stage ----
# Two deliberate choices in this stage:
#
# 1. It is LAST. Hosting platforms that run a plain `docker build .` (Render,
#    Fly, Coolify, Railway) cannot pass --target, so whatever stage is last is
#    what they ship. With `development` last they were shipping a Vite dev
#    server to production, which OOMs on small instances within seconds and gets
#    the deploy restart-looped.
#
# 2. It starts FROM build rather than from a `pnpm prune --prod` stage. The
#    runtime command is `pnpm run dockerstart`, which shells out to the
#    `wrangler` CLI, and wrangler is a devDependency - pruning devDependencies
#    produces an image that dies at startup with `sh: 1: wrangler: not found`.
#    (`pnpm add --prod wrangler` does not rescue it either: with NODE_ENV=
#    production pnpm reports "Already up to date" and links nothing.) The image
#    is a few hundred MB larger; a container that boots is worth more than a
#    small one that does not.
#
# (It used to be the last stage. It no longer is - `node-runtime` below is, so
# that a plain `docker build .` ships the low-memory runtime. Compose files that
# say `target: bolt-ai-production` still get the wrangler/Pages simulator.)
FROM build AS bolt-ai-production
WORKDIR /app

ENV NODE_ENV=production
# Default port/host; both are overridable at runtime so platforms that assign a
# port (Render injects PORT=10000) work without a rebuild.
ENV PORT=5173
ENV HOST=0.0.0.0

# Non-sensitive build arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables
ENV WRANGLER_SEND_METRICS=false \
    VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Note: API keys should be provided at runtime via docker run -e or docker-compose
# Example: docker run -e DASHSCOPE_API_KEY=your_key_here ...

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# `bindings.sh` greps worker-configuration.d.ts for the names to forward as
# wrangler bindings when no .env.local exists (always the case in an image, as
# .env* is .dockerignore'd). Both files must be present at runtime:
#   - /app/bindings.sh
#   - /app/worker-configuration.d.ts
# and `wrangler pages dev ./build/client` has no Node server entry point of its
# own: every request is routed through the Pages Functions catch-all in
# /app/functions, which imports ../build/server. All of that is already in this
# stage; chmod only needs to survive from the source copy.
RUN chmod +x /app/bindings.sh

# Pre-configure wrangler to disable metrics
RUN mkdir -p /root/.config/.wrangler && \
    echo '{"enabled":false}' > /root/.config/.wrangler/metrics.json

# Fail the *image build* with a readable error if the runtime server is missing,
# instead of shipping an image that crash-loops on the platform.
RUN pnpm exec wrangler --version || ./node_modules/.bin/wrangler --version

EXPOSE 5173

# Healthcheck for deployment platforms. Shell form so $PORT is read at
# container start, and a long start-period because wrangler takes ~15s to bind.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=5 \
  CMD curl -fsS "http://localhost:${PORT:-5173}/" || exit 1

# Start using dockerstart script with Wrangler
CMD ["pnpm", "run", "dockerstart"]


# ---- node-runtime stage (LAST: this is what `docker build .` ships) ----
# Why this stage exists: the production image above runs the app inside
# `wrangler pages dev`, i.e. Cloudflare's workerd harness, which costs ~850 MB
# of RSS at idle. That is the only reason this repo could not fit Render's free
# 512 MB tier - the *app* needs far less. `server.mjs` serves the exact same
# `pnpm run build` output on plain Node V8 and idles at ~110-150 MB, peaking
# ~270 MB under load, with no feature missing:
#
#   - `context.cloudflare.env`  -> runtime process.env (how every /api/* route
#     resolves keys, so DASHSCOPE_API_KEY & friends work as plain env vars)
#   - `env.ASSETS.fetch`        -> served straight from build/client, including
#     the .br/.gz siblings this stage generates so a 0.1 vCPU never compresses
#   - streaming responses       -> chunked passthrough (LLM tokens arrive live)
#   - client disconnect         -> AbortController fires request.signal
#
# Nothing Cloudflare-specific is left out: no route reads `caches`, `waitUntil`
# or `cf` (only `context.cloudflare?.env`, which is always optional-chained, so
# the app degrades the same way here as it does in `pnpm run dev`).
FROM build AS node-runtime
WORKDIR /app

ENV NODE_ENV=production
# Render assigns its own PORT; 0.0.0.0 is required by every container platform.
ENV PORT=10000
ENV HOST=0.0.0.0

# Cap the V8 heap so the container stays inside a 512 MB free tier: measured
# non-heap overhead is ~90 MB, so 320 MB of heap + overhead peaks near 410 MB.
# Raise it (or clear it) on plans with more RAM.
ENV NODE_OPTIONS=--max-old-space-size=320

# Same disposable-build trick as the Pages stage, without the Pages coupling:
# precompress once at build time instead of per request at 0.1 vCPU.
RUN node scripts/compress-client-assets.mjs

EXPOSE 10000

# No curl (and no apt-get layer): node 22 has fetch built in.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
