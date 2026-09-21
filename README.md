# bolt.diy

[![bolt.diy: AI-Powered Full-Stack Web Development in the Browser](./public/social_preview_index.jpg)](https://bolt.diy)

Welcome to bolt.diy, the official open source version of Bolt.new, which allows you to choose the LLM that you use for each prompt! Currently, you can use OpenAI, Anthropic, Ollama, OpenRouter, Gemini, LMStudio, Mistral, xAI, HuggingFace, DeepSeek, Groq, Cohere, Together, Perplexity, Moonshot (Kimi), Hyperbolic, GitHub Models, Amazon Bedrock, and OpenAI-like providers - and it is easily extended to use any other model supported by the Vercel AI SDK! See the instructions below for running this locally and extending it to include more models.

-----
Check the [bolt.diy Docs](https://stackblitz-labs.github.io/bolt.diy/) for more official installation instructions and additional information.

-----
Also [this pinned post in our community](https://thinktank.ottomator.ai/t/videos-tutorial-helpful-content/3243) has a bunch of incredible resources for running and deploying bolt.diy yourself!

We have also launched an experimental agent called the "bolt.diy Expert" that can answer common questions about bolt.diy. Find it here on the [oTTomator Live Agent Studio](https://studio.ottomator.ai/).

bolt.diy was originally started by [Cole Medin](https://www.youtube.com/@ColeMedin) but has quickly grown into a massive community effort to build the BEST open source AI coding assistant!

## Table of Contents

- [Join the Community](#join-the-community)
- [Recent Major Additions](#recent-major-additions)
- [Features](#features)
- [Setup](#setup)
- [Quick Installation](#quick-installation)
- [Manual Installation](#manual-installation)
- [Configuring API Keys and Providers](#configuring-api-keys-and-providers)
- [Setup Using Git (For Developers only)](#setup-using-git-for-developers-only)
- [Available Scripts](#available-scripts)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [FAQ](#faq)

## Join the community

[Join the bolt.diy community here, in the oTTomator Think Tank!](https://thinktank.ottomator.ai)

## Project management

Bolt.diy is a community effort! Still, the core team of contributors aims at organizing the project in way that allows
you to understand where the current areas of focus are.

If you want to know what we are working on, what we are planning to work on, or if you want to contribute to the
project, please check the [project management guide](./PROJECT.md) to get started easily.

## Recent Major Additions

### ✅ Completed Features
- **19+ AI Provider Integrations** - OpenAI, Anthropic, Google, Groq, xAI, DeepSeek, Mistral, Cohere, Together, Perplexity, HuggingFace, Ollama, LM Studio, OpenRouter, Moonshot, Hyperbolic, GitHub Models, Amazon Bedrock, OpenAI-like
- **Electron Desktop App** - Native desktop experience with full functionality
- **Advanced Deployment Options** - Netlify, Vercel, and GitHub Pages deployment
- **Autonomous preview lifecycle** - dev server restarts when a config change needs it, captured errors are auto-fixed by the model, and deploys only happen on click
- **Supabase Integration** - Database management and query capabilities
- **Data Visualization & Analysis** - Charts, graphs, and data analysis tools
- **MCP (Model Context Protocol)** - Enhanced AI tool integration
- **Search Functionality** - Codebase search and navigation
- **File Locking System** - Prevents conflicts during AI code generation
- **Diff View** - Visual representation of AI-made changes
- **Git Integration** - Clone, import, and deployment capabilities
- **Expo App Creation** - React Native development support
- **Voice Prompting** - Audio input for prompts
- **Bulk Chat Operations** - Delete multiple chats at once
- **Project Snapshot Restoration** - Restore projects from snapshots on reload

### 🔄 In Progress / Planned
- **File Locking & Diff Improvements** - Enhanced conflict prevention
- **Backend Agent Architecture** - Move from single model calls to agent-based system
- **LLM Prompt Optimization** - Better performance for smaller models
- **Project Planning Documentation** - LLM-generated project plans in markdown
- **VSCode Integration** - Git-like confirmations and workflows
- **Document Upload for Knowledge** - Reference materials and coding style guides
- **Additional Provider Integrations** - Azure OpenAI, Vertex AI, Granite

## Features

- **AI-powered full-stack web development** for **NodeJS based applications** directly in your browser.
- **Support for 19+ LLMs** with an extensible architecture to integrate additional models.
- **Attach images to prompts** for better contextual understanding.
- **Integrated terminal** to view output of LLM-run commands.
- **Revert code to earlier versions** for easier debugging and quicker changes.
- **Download projects as ZIP** for easy portability and sync to a folder on the host.
- **Integration-ready Docker support** for a hassle-free setup.
- **Deploy directly** to **Netlify**, **Vercel**, or **GitHub Pages**.
- **Electron desktop app** for native desktop experience.
- **Data visualization and analysis** with integrated charts and graphs.
- **Git integration** with clone, import, and deployment capabilities.
- **MCP (Model Context Protocol)** support for enhanced AI tool integration.
- **Search functionality** to search through your codebase.
- **File locking system** to prevent conflicts during AI code generation.
- **Diff view** to see changes made by the AI.
- **Supabase integration** for database management and queries.
- **Expo app creation** for React Native development.

### Generated-app behaviour

Three defaults are tuned for someone who is not going to read the terminal:

- **Nothing deploys on its own.** Finishing a generation publishes nothing. A
  Vercel deploy happens when you press **Deploy**. (Settings → Vercel has an
  opt-in "auto-deploy after generation" for people who want the two fused; it
  defaults to off, because shipping is a decision, not a side effect.)
- **A change restarts the app when a restart is actually needed.** Writes to
  `package.json`, a lockfile, `.env*`, `tsconfig*`, or `vite.config.*` (plus the
  Next/Nuxt/Astro/Svelte equivalents) restart the dev server, and the preview
  reloads when it reports ready again. Ordinary source edits are left to Vite's
  hot reload — restarting for those throws away component state and costs
  seconds to do what the browser already did. Want the blunt version?
  `localStorage.setItem('restart_on_every_change', 'true')`.
- **Errors go to the model without asking.** A failed command, a dev server that
  dies on boot, or an exception in the preview is handed straight to the model to
  fix, instead of parking a stack trace behind an "Ask Bolt" button. Loop
  protection is part of it: one request per distinct error, never while the model
  is already writing, three attempts per turn, and the manual alert comes back
  once the budget is spent. To restore click-to-ask:
  `localStorage.setItem('chat_error_autofix', 'false')`.
- **The terminal is read while commands run, not only when they exit.** Waiting
  for a non-zero exit code is no use for a dev server, which prints
  `[vite] Internal server error`, stays running, and looks healthy forever. So
  the output is scanned line by line as it streams: unresolvable imports, missing
  modules and binaries, a port already in use, a failed pre-bundle, an npm
  dependency conflict, a `SyntaxError`/`TypeError` from the running app. Three
  things come out of that: the error reaches the auto-fix above with the real
  output quoted (up to ~2.6 KB of the tail, not "it failed"); a dev server that
  starts and never says `ready in …` is reported after a 75-second deadline
  instead of leaving a blank preview; and an alert stands itself down once the
  server says it is listening again. Reading is limited to moments when a
  command is attached to the shell, so old scrollback containing the word
  `Cannot find module` cannot wake the model up for nothing.

The fix request also states, in as many words, that the terminal belongs to the
model: install the missing package, free the port, delete the stale lockfile,
start the dev server again — then keep reading the output until the app says it
is listening, or say what is still blocking it. There is no "run this command
yourself" step in between.

**A build that stops early continues on its own.** Some models end the message after
scaffolding - `package.json`, one `npm install`, and a clean "I'm done" - which leaves
you with one file and nothing to preview, and the provider reports no error, because
there wasn't one. So the response is judged on what it contains: an artifact left open,
or a couple of files with an install and no dev server ever started, gets one more turn
of the same model with the partial text handed back and an instruction to finish the
remaining files (never to repeat them, and never to invent features you did not ask
for). The progress line says "the build stopped early - continuing", and the loop is
capped at three continuations per reply.

Automated shells also no longer block on npm's `Need to install the following
packages: vite … Ok to proceed? (y)` prompt — the agent's shell and the preview
build run with `npm_config_yes=true`, while the terminal you type in keeps
prompting, because you may want to answer it.


## Setup

If you're new to installing software from GitHub, don't worry! If you encounter any issues, feel free to submit an "issue" using the provided links or improve this documentation by forking the repository, editing the instructions, and submitting a pull request. The following instruction will help you get the stable branch up and running on your local machine in no time.

Let's get you up and running with the stable version of Bolt.DIY!

## Quick Installation

[![Download Latest Release](https://img.shields.io/github/v/release/stackblitz-labs/bolt.diy?label=Download%20Bolt&sort=semver)](https://github.com/stackblitz-labs/bolt.diy/releases/latest) ← Click here to go to the latest release version!

- Download the binary for your platform (available for Windows, macOS, and Linux)
- **Note**: For macOS, if you get the error "This app is damaged", run:
  ```bash
  xattr -cr /path/to/Bolt.app
  ```

## Manual installation


### Option 1: Node.js

Node.js is required to run the application.

1. Visit the [Node.js Download Page](https://nodejs.org/en/download/)
2. Download the "LTS" (Long Term Support) version for your operating system
3. Run the installer, accepting the default settings
4. Verify Node.js is properly installed:
   - **For Windows Users**:
     1. Press `Windows + R`
     2. Type "sysdm.cpl" and press Enter
     3. Go to "Advanced" tab → "Environment Variables"
     4. Check if `Node.js` appears in the "Path" variable
   - **For Mac/Linux Users**:
     1. Open Terminal
     2. Type this command:
        ```bash
        echo $PATH
        ```
     3. Look for `/usr/local/bin` in the output

## Running the Application

You have two options for running Bolt.DIY: directly on your machine or using Docker.

### Option 1: Direct Installation (Recommended for Beginners)

1. **Install Package Manager (pnpm)**:

   ```bash
   npm install -g pnpm
   ```

2. **Install Project Dependencies**:

   ```bash
   pnpm install
   ```

3. **Start the Application**:

   ```bash
   pnpm run dev
   ```
   
### Option 2: Using Docker

This option requires Docker and is great when you want an isolated environment or to mirror the production image.

#### Additional Prerequisite

- Install Docker: [Download Docker](https://www.docker.com/)

#### Steps

1. **Prepare Environment Variables**

   Copy the provided examples and add your provider keys:

   ```bash
   cp .env.example .env
   cp .env.example .env.local
   ```

   The runtime scripts inside the container source `.env` and `.env.local`, so keep any API keys you need in one of those files.

2. **Build an Image**

   ```bash
   # Development image (bind-mounts your local source when run)
   pnpm run dockerbuild
   # ≈ docker build -t bolt-ai:development -t bolt-ai:latest --target development .

   # Production image (self-contained build artifacts)
   pnpm run dockerbuild:prod
   # ≈ docker build -t bolt-ai:production -t bolt-ai:latest --target bolt-ai-production .
   ```

3. **Run the Container**

   ```bash
   # Development workflow with hot reload
   docker compose --profile development up

   # Production-style container using composed services
   docker compose --profile production up

   # One-off production container (exposes the app on port 5173)
   docker run --rm -p 5173:5173 --env-file .env.local bolt-ai:latest
   ```

   When the container starts it runs `pnpm run dockerstart`, which in turn executes `bindings.sh` to pass Cloudflare bindings through Wrangler. You can override this command in `docker-compose.yaml` if you need a different startup routine.

#### Deploying bolt.diy itself (Render, Cloudflare Pages, Coolify)

Two things are worth separating: **where bolt.diy is hosted** (this section) and
**where the apps it generates are deployed** (Vercel/Netlify/Supabase, driven by
the tokens in your `.env`). Hosting needs Node 20+ *or* Docker, and nothing else:
the cross-origin isolation WebContainer requires (`Cross-Origin-Opener-Policy:
same-origin` + `Cross-Origin-Embedder-Policy: require-corp`) is set by the app
itself on every SSR response in `app/entry.server.tsx`, so there is no proxy or
hosting-console step to remember. (Cosmetic side effect of `require-corp`: the
`cdn.simpleicons.org` logos in the Deploy menu can render blank, since that CDN
sends no `Cross-Origin-Resource-Policy`.)

**Render — Docker runtime, free tier.** A plain `docker build .` cannot pass
`--target`, so whatever stage is last in `Dockerfile` is what Render ships. That
stage is now `node-runtime`: the identical `pnpm run build` output, served by
`server.mjs` on plain Node V8 instead of Cloudflare's workerd harness. The
settings:

| Field | Value |
| ----- | ----- |
| Runtime | **Docker** |
| Dockerfile Path | `./Dockerfile` |
| Region | any |
| Instance | **Free (512 MB)** is enough now; `plan: free` in `render.yaml` |
| Health check path | `/` (or `/api/health`) |

There is no Build/Start command to fill in: the Dockerfile does both (install +
`NODE_OPTIONS=… pnpm run build`, then `node server.mjs`). Environment variables
(`DASHSCOPE_API_KEY`, `XKIRO_API_KEY`, `VERCEL_TOKEN`, `DASHSCOPE_BASE_URL`, …)
go in the dashboard as **Secrets**, and with this runtime they are read at
runtime — change a key in the dashboard and the next request uses it, no rebuild.
`render.yaml` pre-declares them, so a Blueprint deploy picks up the whole
configuration from this repo.

Why it fits now, measured in this repo:

| | idle RSS | peak RSS | why |
| --- | --- | --- | --- |
| `wrangler pages dev` (older stage) | ~850 MB | >850 MB | workerd + miniflare + Node, three VMs |
| `node server.mjs` (this stage) | ~110-150 MB | ~270 MB | one Node process, heap capped at 320 MB |

The `850 MB` figure was always a property of the *simulator*, not of the app;
the app needs maybe a third of it. `NODE_OPTIONS=--max-old-space-size=320` is
set in the image so a runaway generation cannot push the container over the
512 MB ceiling — raise or unset it on bigger plans.

What the free tier still costs you, unchanged by any of this:

- **It sleeps.** A free instance spins down ~15 minutes after the last request,
  so the next visitor eats a cold start (a few seconds on 0.1 CPU, not the
  ~30 s you would get from the wrangler image). Keep-alive cron pings are the
  usual workaround; Cloudflare Pages free does not sleep at all.
- **0.1 vCPU** is real. To keep that from turning into per-request work, the
  image precompresses the ~28 MB client build to ~5.8 MB once at build time
  (`scripts/compress-client-assets.mjs`, brotli + gzip siblings), and
  `server.mjs` serves those directly with `ETag`/`immutable` caching — no
  on-the-fly compression, no CDN required.
- **Build minutes** are capped on the free plan; this project's build takes a
  few minutes of it, so avoid pushing 40 times a day.
- **The build is the last memory risk, not the runtime.** `remix vite:build` needs
  a ~2.5 GB heap, and Render does not publish how much RAM its *build* machines
  get (only the 512 MB runtime is documented). The Dockerfile caps the build at
  `--max-old-space-size=2560`, the smallest value measured to complete here, so a
  small builder has the best possible chance. If the build log ends in `Killed`
  during `remix vite:build`, two free ways around it: bump the plan to Starter,
  let it build once, then drop back to Free (the image survives the downgrade); or
  build the image in GitHub Actions - `docker build --target node-runtime .` pushed
  to GHCR - and point Render at the *Image* runtime instead of the Dockerfile
  builder. Neither changes a line of app code.
- **Free hours are per workspace, not per service**: 750 instance-hours a month,
  and one 24/7 container already spends ~720 of them. Two always-on free services
  on the same workspace will not both survive the month.

Three things `server.mjs` deliberately reproduces rather than skips, because
they are what a runtime swap usually silently breaks:

- **Server env keys.** Every `/api/*` route resolves credentials through
  `context.cloudflare?.env`, which Cloudflare injects and `server.mjs` fills
  from `process.env`. Worth knowing: the built server bundle contains **no**
  `process.env` at all (Vite replaces it with a build-time shim from
  `vite-plugin-node-polyfills`), so the load context is not a fallback, it is
  the only live path. Verified here: with only `DASHSCOPE_API_KEY` set in the
  shell, `/api/check-env-key?provider=DashScope` returns `{"isSet":true}` while
  `?provider=Anthropic` returns `{"isSet":false}`, and a streamed model call
  leaves with `Authorization: Bearer <that key>`.
- **Streaming and cancellation.** Chat responses are chunk-piped, not buffered
  (measured through a stubbed 6-token upstream: first byte at 0.34 s, stream
  complete at 1.84 s), and a client hanging up closes the request signal, which
  is threaded into `Request.signal` so "stop generation" behaves as it does on
  Pages. The app itself never passes a signal to the provider fetch, so an
  in-flight upstream call keeps running to completion on *both* runtimes — that
  is upstream behaviour, not a Node regression.
- **WebContainer isolation.** `app/entry.server.tsx` sets the COOP/COEP pair on
  SSR responses, and `server.mjs` copies response headers verbatim, so the
  headers survive without any platform config. Static assets that Pages would
  serve via `env.ASSETS.fetch` are served from `build/client` by the same
  process.

Local run without Docker, using the same code path the image uses:

```bash
pnpm run build:node     # remix vite:build + precompress build/client
DASHSCOPE_API_KEY=sk-… pnpm run start:node   # http://localhost:3000
```

`build`/`deploy`/`dockerstart` are untouched, so Cloudflare Pages keeps getting
byte-identical output and `--target bolt-ai-production` still gives you the
wrangler-based image if you ever want to compare them.

**Cloudflare Pages — the zero-maintenance option.** It is what `pnpm run deploy`
targets (`wrangler pages deploy ./build/client`), the handler already lives in
`functions/[[path]].ts`, and Pages lets you set response headers (WebContainer's
COOP/COEP) in `public/_headers` or the dashboard:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm run deploy   # project: bolt
```

Put `DASHSCOPE_API_KEY`, `XKIRO_API_KEY`, `VERCEL_TOKEN` and friends in *Pages →
Settings → Environment variables → Secrets*, and the `VITE_*` ones under *Build
& deployment → Variables* (they are compiled in at build time).

**Vercel/Netlify's adapters are still not wired up here.** There is no
`vercel.json`/`netlify.toml`, and note Netlify's free functions impose a
**60-second synchronous limit that is not configurable**, which cuts long
generations off mid-stream (Cloudflare bills CPU time, not wall clock, so
awaiting a slow model is free; Render's free tier has no request timeout). A
plain "Node.js" service type *can* now work, since `server.mjs` exists — build
command `NODE_OPTIONS=--max-old-space-size=4096 pnpm run build:node`, start
command `pnpm run start:node` — but nothing in this repo is configured for it,
so Docker or Cloudflare Pages remains the supported path.

To inspect the production container before deploying, build it locally (it
carries the full dependency tree, so give Docker a generous memory limit):

```bash
# the low-memory Node runtime (what Render deploys): ~512 MB is enough
docker build --platform=linux/amd64 -t bolt-ai:node --target node-runtime .
docker run --rm -p 10000:10000 --env-file .env.local -e VITE_PUBLIC_APP_URL=http://localhost:10000 bolt-ai:node

# the older wrangler/Pages-simulator image, for comparison
docker build --platform=linux/amd64 -t bolt-ai:production --target bolt-ai-production .
docker run --rm -p 5173:5173 --env-file .env.local -e VITE_PUBLIC_APP_URL=http://localhost:5173 bolt-ai:production
```

That older stage is the one that still depends on `bindings.sh`: it forwards only
the names it finds in `worker-configuration.d.ts` as `wrangler --binding` flags,
so a dashboard key absent from that list is silently dropped and the provider
reports "Missing API Key". `node-runtime` has no such filter — every runtime env
var is visible — and is therefore the stage to use if you are adding a provider
and do not want to touch `worker-configuration.d.ts`.


### Option 3: Desktop Application (Electron)

For users who prefer a native desktop experience, bolt.diy is also available as an Electron desktop application:

1. **Download the Desktop App**:
   - Visit the [latest release](https://github.com/stackblitz-labs/bolt.diy/releases/latest)
   - Download the appropriate binary for your operating system
   - For macOS: Extract and run the `.dmg` file
   - For Windows: Run the `.exe` installer
   - For Linux: Extract and run the AppImage or install the `.deb` package

2. **Alternative**: Build from Source:
   ```bash
   # Install dependencies
   pnpm install

   # Build the Electron app
   pnpm electron:build:dist  # For all platforms
   # OR platform-specific:
   pnpm electron:build:mac   # macOS
   pnpm electron:build:win   # Windows
   pnpm electron:build:linux # Linux
   ```

The desktop app provides the same full functionality as the web version with additional native features.

## Configuring API Keys and Providers

Bolt.diy features a modern, intuitive settings interface for managing AI providers and API keys. The settings are organized into dedicated panels for easy navigation and configuration.

### Accessing Provider Settings

1. **Open Settings**: Click the settings icon (⚙️) in the sidebar to access the settings panel
2. **Navigate to Providers**: Select the "Providers" tab from the settings menu
3. **Choose Provider Type**: Switch between "Cloud Providers" and "Local Providers" tabs

### Cloud Providers Configuration

The Cloud Providers tab displays all cloud-based AI services in an organized card layout:

#### Adding API Keys
1. **Select Provider**: Browse the grid of available cloud providers (OpenAI, Anthropic, Google, etc.)
2. **Toggle Provider**: Use the switch to enable/disable each provider
3. **Set API Key**:
   - Click the provider card to expand its configuration
   - Click on the "API Key" field to enter edit mode
   - Paste your API key and press Enter to save
   - The interface shows real-time validation with green checkmarks for valid keys

#### Advanced Features
- **Bulk Toggle**: Use "Enable All Cloud" to toggle all cloud providers at once
- **Visual Status**: Green checkmarks indicate properly configured providers
- **Provider Icons**: Each provider has a distinctive icon for easy identification
- **Descriptions**: Helpful descriptions explain each provider's capabilities

### Local Providers Configuration

The Local Providers tab manages local AI installations and custom endpoints:

#### Ollama Configuration
1. **Enable Ollama**: Toggle the Ollama provider switch
2. **Configure Endpoint**: Set the API endpoint (defaults to `http://127.0.0.1:11434`)
3. **Model Management**:
   - View all installed models with size and parameter information
   - Update models to latest versions with one click
   - Delete unused models
   - Install new models by entering model names

#### Other Local Providers
- **LM Studio**: Configure custom base URLs for LM Studio endpoints
- **OpenAI-like**: Connect to any OpenAI-compatible API endpoint
- **Auto-detection**: The system automatically detects environment variables for base URLs

### Environment Variables vs UI Configuration

Bolt.diy supports both methods for maximum flexibility:

#### Environment Variables (Recommended for Production)
Set API keys and base URLs in your `.env.local` file:
```bash
# API Keys
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here

# Custom Base URLs
OLLAMA_BASE_URL=http://127.0.0.1:11434
LMSTUDIO_BASE_URL=http://127.0.0.1:1234
```

#### UI-Based Configuration
- **Real-time Updates**: Changes take effect immediately
- **Secure Storage**: API keys are stored securely in browser cookies
- **Visual Feedback**: Clear indicators show configuration status
- **Easy Management**: Edit, view, and manage keys through the interface

### Provider-Specific Features

#### OpenRouter
- **Free Models Filter**: Toggle to show only free models when browsing
- **Pricing Information**: View input/output costs for each model
- **Model Search**: Fuzzy search through all available models

#### Ollama
- **Model Installer**: Built-in interface to install new models
- **Progress Tracking**: Real-time download progress for model updates
- **Model Details**: View model size, parameters, and quantization levels
- **Auto-refresh**: Automatically detects newly installed models

#### Search & Navigation
- **Fuzzy Search**: Type-ahead search across all providers and models
- **Keyboard Navigation**: Use arrow keys and Enter to navigate quickly
- **Clear Search**: Press `Cmd+K` (Mac) or `Ctrl+K` (Windows/Linux) to clear search

### Troubleshooting

#### Common Issues
- **API Key Not Recognized**: Ensure you're using the correct API key format for each provider
- **Base URL Issues**: Verify the endpoint URL is correct and accessible
- **Model Not Loading**: Check that the provider is enabled and properly configured
- **Environment Variables Not Working**: Restart the application after adding new environment variables

#### Status Indicators
- 🟢 **Green Checkmark**: Provider properly configured and ready to use
- 🔴 **Red X**: Configuration missing or invalid
- 🟡 **Yellow Indicator**: Provider enabled but may need additional setup
- 🔵 **Blue Pencil**: Click to edit configuration

### DashScope, xKiro & Agent Router (added in this fork)
### Pointing at a gateway without a rebuild

Settings → Providers → **Manual endpoint** takes a base URL, a key, and (optionally)
the model list for one provider. It writes the same values the environment variables
above would, so it is the quick path for an agent router, a corporate proxy, a vLLM
instance, or anything else that speaks `/v1/chat/completions`:

- the URL and model list are stored per provider in this browser and win over `.env`;
- the key goes in the same place the chat's key manager uses, so nothing is written to
  the repo or the build;
- a bare host is completed to `<host>/v1`, and a pasted `/chat/completions` is refused
  with an explanation, because that one mistake looks exactly like a broken provider;
- if the panel warns that the provider builds its own request (most vendor SDKs do),
  choose **OpenAILike** (any OpenAI-compatible endpoint) or **AgentRouter** instead.


Both are OpenAI-compatible, so they need no extra SDK - just keys in `.env.local`:

```bash
# Alibaba Cloud Model Studio (DashScope). The host is workspace/region specific:
# grab the "OpenAI compatible" base URL from the Model Studio console.
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_BASE_URL=https://<workspaceId>.<region>.maas.aliyuncs.com/compatible-mode/v1

# xKiro gateway (https://xkiro.com) - model ids are always vendor/model
XKIRO_API_KEY=sk-xt-...
XKIRO_BASE_URL=https://api.xkiro.com/v1

# Agent Router (formerly Envoy AI Gateway) - one OpenAI-compatible endpoint in front of
# whatever models your gateway serves. Hosted service, or `aigw run` on localhost:1975.
AGENTROUTER_API_KEY=sk-...                      # any value is fine for a localhost gateway
AGENTROUTER_BASE_URL=https://api.router.tetrate.ai/v1
AGENTROUTER_API_MODELS=claude-sonnet-4.6:200000:32000;deepseek-v4-pro:131072

# Optional: preselect provider + model for every new chat
VITE_DEFAULT_PROVIDER=DashScope
VITE_DEFAULT_MODEL=qwen3-coder-plus
```

Notes:

* Model lists are discovered live (`GET {base}/models`). Endpoints that do not expose a catalogue fall back to the built-in list, and `DASHSCOPE_API_MODELS` / `XKIRO_API_MODELS` let you pin one explicitly (`id[:context][:maxCompletionTokens];...`).
* DashScope base URLs are normalized: a trailing slash, a missing `/v1` or a pasted `/chat/completions` path all work.
* xKiro ids keep their `vendor/` prefix (the bare name 404s) and their labels show context, access tier and price per 1M tokens.
* Keep the keys on the **server**: the names above are read at runtime by `/api/chat`. A `VITE_`-prefixed copy (e.g. `VITE_DASHSCOPE_API_KEY`) is inlined into the public bundle, so leave those empty. Deployed containers have no `.env.local` at all - see [Deploying bolt.diy itself](#deploying-boltdiy-itself-render-cloudflare-pages-coolify).

### Deploying generated apps to Vercel

Set a single variable and the token never leaves the server:

```bash
VERCEL_TOKEN=vcp_...            # or VITE_VERCEL_ACCESS_TOKEN for the legacy browser-side flow
```

`/api/vercel-deploy` and `/api/vercel-user` resolve the token from the server environment, so once a project is generated the workbench connects automatically and **Deploy → Deploy to Vercel** is live. Use `VITE_VERCEL_ACCESS_TOKEN` only if you want the browser to hold the token as well (it is inlined into the public bundle and stored in `localStorage`).

#### Auto-deploy when generation finishes

Enabled by default: after the model stops writing and the generated app's dev server publishes a
preview (which also means `npm install` has finished), bolt runs the build and ships it to Vercel on
its own - no click. Switch it off in **Settings → Vercel → "Deploy when generation finishes"**
(persisted as `vercel_auto_deploy` in localStorage).

Guards, in `app/lib/utils/autoDeploy.ts`:

* one deployment per chat per page view, and only for a chat that actually generated in this view - reloading an old chat never redeploys;
* never mid-stream, never while another deploy is in flight, never without a reachable Vercel account;
* a cancelled/changed message cancels the pending (4s settle) timer;
* a failed auto-deploy is logged and toasted, not retried in a loop - the manual button still works.

Deploys reuse the same Vercel project per chat (`vercel-project-<chatId>`), so regenerating updates the
same deployment URL.

### Supported Providers Overview

#### Cloud Providers
- **OpenAI** - GPT-4, GPT-3.5, and other OpenAI models
- **Anthropic** - Claude 3.5 Sonnet, Claude 3 Opus, and other Claude models
- **Google (Gemini)** - Gemini 1.5 Pro, Gemini 1.5 Flash, and other Gemini models
- **Groq** - Fast inference with Llama, Mixtral, and other models
- **xAI** - Grok models including Grok-2 and Grok-2 Vision
- **DeepSeek** - DeepSeek Coder and other DeepSeek models
- **Mistral** - Mixtral, Mistral 7B, and other Mistral models
- **Cohere** - Command R, Command R+, and other Cohere models
- **Together AI** - Various open-source models
- **Perplexity** - Sonar models for search and reasoning
- **HuggingFace** - Access to HuggingFace model hub
- **OpenRouter** - Unified API for multiple model providers
- **Moonshot (Kimi)** - Kimi AI models
- **Hyperbolic** - High-performance model inference
- **GitHub Models** - Models available through GitHub
- **Amazon Bedrock** - AWS managed AI models
- **DashScope (Alibaba Cloud Model Studio)** - Qwen3 Coder / Qwen Max / Qwen Flash and every other model enabled in your workspace, over the OpenAI-compatible `compatible-mode` endpoint
- **Xkiro (xKiro)** - one key for OpenAI, Anthropic, DeepSeek, Qwen, Mistral and more behind an OpenAI-compatible gateway, with live context/pricing/tier metadata

#### Local Providers
- **Ollama** - Run open-source models locally with advanced model management
- **LM Studio** - Local model inference with LM Studio
- **OpenAI-like** - Connect to any OpenAI-compatible API endpoint
- **Agent Router** - one OpenAI-compatible endpoint in front of your own model setup (hosted Tetrate Agent Router Service or a self-run gateway), with `GET /models` discovery and a pinned list as a fallback

> **💡 Pro Tip**: Start with OpenAI or Anthropic for the best results, then explore other providers based on your specific needs and budget considerations.

## Setup Using Git (For Developers only)

This method is recommended for developers who want to:

- Contribute to the project
- Stay updated with the latest changes
- Switch between different versions
- Create custom modifications

#### Prerequisites

1. Install Git: [Download Git](https://git-scm.com/downloads)

#### Initial Setup

1. **Clone the Repository**:

   ```bash
   git clone -b stable https://github.com/stackblitz-labs/bolt.diy.git
   ```

2. **Navigate to Project Directory**:

   ```bash
   cd bolt.diy
   ```

3. **Install Dependencies**:

   ```bash
   pnpm install
   ```

4. **Start the Development Server**:
   ```bash
   pnpm run dev
   ```

5. **(OPTIONAL)** Switch to the Main Branch if you want to use pre-release/testbranch:
   ```bash
   git checkout main
   pnpm install
   pnpm run dev
   ```
  Hint: Be aware that this can have beta-features and more likely got bugs than the stable release

>**Open the WebUI to test (Default: http://localhost:5173)**
>   - Beginners: 
>     - Try to use a sophisticated Provider/Model like Anthropic with Claude Sonnet 3.x Models to get best results
>     - Explanation: The System Prompt currently implemented in bolt.diy cant cover the best performance for all providers and models out there. So it works better with some models, then other, even if the models itself are perfect for >programming
>     - Future: Planned is a Plugin/Extentions-Library so there can be different System Prompts for different Models, which will help to get better results

#### Staying Updated

To get the latest changes from the repository:

1. **Save Your Local Changes** (if any):

   ```bash
   git stash
   ```

2. **Pull Latest Updates**:

   ```bash
   git pull 
   ```

3. **Update Dependencies**:

   ```bash
   pnpm install
   ```

4. **Restore Your Local Changes** (if any):
   ```bash
   git stash pop
   ```

#### Troubleshooting Git Setup

If you encounter issues:

1. **Clean Installation**:

   ```bash
   # Remove node modules and lock files
   rm -rf node_modules pnpm-lock.yaml

   # Clear pnpm cache
   pnpm store prune

   # Reinstall dependencies
   pnpm install
   ```

2. **Reset Local Changes**:
   ```bash
   # Discard all local changes
   git reset --hard origin/main
   ```

Remember to always commit your local changes or stash them before pulling updates to avoid conflicts.

---

## Available Scripts

- **`pnpm run dev`**: Starts the development server.
- **`pnpm run build`**: Builds the project (the output Cloudflare Pages deploys).
- **`pnpm run build:node`**: Same build, plus precompressed `.br`/`.gz` copies of `build/client` for self-hosting.
- **`pnpm run start`**: Runs the built application locally using Wrangler Pages.
- **`pnpm run start:node`**: Runs the same build on plain Node via `server.mjs` (low memory; what `node-runtime`/Render runs).
- **`pnpm run preview`**: Builds and runs the production build locally.
- **`pnpm test`**: Runs the test suite using Vitest.
- **`pnpm run typecheck`**: Runs TypeScript type checking.
- **`pnpm run typegen`**: Generates TypeScript types using Wrangler.
- **`pnpm run deploy`**: Deploys the project to Cloudflare Pages.
- **`pnpm run lint`**: Runs ESLint to check for code issues.
- **`pnpm run lint:fix`**: Automatically fixes linting issues.
- **`pnpm run clean`**: Cleans build artifacts and cache.
- **`pnpm run prepare`**: Sets up husky for git hooks.
- **Docker Scripts**:
  - **`pnpm run dockerbuild`**: Builds the Docker image for development.
  - **`pnpm run dockerbuild:prod`**: Builds the Docker image for production.
  - **`pnpm run dockerrun`**: Runs the Docker container.
  - **`pnpm run dockerstart`**: Starts the Docker container with proper bindings.
- **Electron Scripts**:
  - **`pnpm electron:build:deps`**: Builds Electron main and preload scripts.
  - **`pnpm electron:build:main`**: Builds the Electron main process.
  - **`pnpm electron:build:preload`**: Builds the Electron preload script.
  - **`pnpm electron:build:renderer`**: Builds the Electron renderer.
  - **`pnpm electron:build:unpack`**: Creates an unpacked Electron build.
  - **`pnpm electron:build:mac`**: Builds for macOS.
  - **`pnpm electron:build:win`**: Builds for Windows.
  - **`pnpm electron:build:linux`**: Builds for Linux.
  - **`pnpm electron:build:dist`**: Builds for all platforms.

---

## Contributing

We welcome contributions! Check out our [Contributing Guide](CONTRIBUTING.md) to get started.

---

## Roadmap

Explore upcoming features and priorities on our [Roadmap](https://roadmap.sh/r/ottodev-roadmap-2ovzo).

---

## FAQ

For answers to common questions, issues, and to see a list of recommended models, visit our [FAQ Page](FAQ.md).


# Licensing
**Who needs a commercial WebContainer API license?**

bolt.diy source code is distributed as MIT, but it uses WebContainers API that [requires licensing](https://webcontainers.io/enterprise) for production usage in a commercial, for-profit setting. (Prototypes or POCs do not require a commercial license.) If you're using the API to meet the needs of your customers, prospective customers, and/or employees, you need a license to ensure compliance with our Terms of Service. Usage of the API in violation of these terms may result in your access being revoked.
# Test commit to trigger Security Analysis workflow
