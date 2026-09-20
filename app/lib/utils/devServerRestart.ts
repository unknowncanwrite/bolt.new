/**
 * Deciding when a file change has to restart the dev server, and which command
 * to re-run.
 *
 * A Vite dev server hot-replaces ordinary source edits, so restarting on every
 * keystroke would be a downgrade: it throws away HMR state, costs ~1-3 s on the
 * fractional CPU a free tier gives you, and flickers the preview. What Vite *can
 * not* pick up live is anything that changes how it is configured - the module
 * graph, the plugins, the environment - so those are the writes that need a real
 * restart, and they are exactly the ones that otherwise leave a stale preview that
 * looks like "the agent did nothing".
 *
 * Pure functions, no WebContainer imports, so this can be unit tested.
 */

/** Files whose contents Vite reads once at boot, so a change needs a restart. */
const CONFIG_BASENAMES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'deno.json',
  'deno.jsonc',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'jsconfig.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.cjs',
  'postcss.config.js',
  'postcss.config.cjs',
  'proxy.config.js',
];

/** `vite.config.ts`, `vitest.config.ts`, `next.config.mjs`, `.env.local`, ... */
const CONFIG_PATTERNS = [
  /^(vite|vitest|rollup|webpack|rsbuild|astro|nuxt|nitro|svelte|solid|remix|next|gatsby|redwood|angular|nest|expo|app)\.config\.[cm]?[jt]sx?$/i,
  /^tailwind\.config\.[cm]?[jt]s$/i,
  /^tsconfig\..*\.json$/i,
  /^\.env(\..+)?$/i,
];

/** Paths that are bookkeeping, not app source. */
const IGNORED_PREFIXES = ['.bolt/', '.git/', 'node_modules/', '.npm/', '.cache/'];

const basename = (filePath: string) => filePath.split('/').filter(Boolean).pop() ?? '';

/** Should this path (relative to the project root) force a dev server restart? */
export function requiresDevServerRestart(filePath: string): boolean {
  const clean = filePath.replace(/^\.\//, '');

  if (IGNORED_PREFIXES.some((prefix) => clean.startsWith(prefix))) {
    return false;
  }

  const name = basename(clean);

  if (CONFIG_BASENAMES.includes(name)) {
    return true;
  }

  return CONFIG_PATTERNS.some((pattern) => pattern.test(name));
}

/** Any one restart-worthy path in the batch is enough. */
export function anyRequiresDevServerRestart(paths: string[]): boolean {
  return paths.some(requiresDevServerRestart);
}

/**
 * Commands that keep running to serve the preview. Matching is on the *whole*
 * command, so `npm install && npm run dev` - the shape every template uses - is
 * recognised, and so is the same command reached for by an artifact's shell
 * action rather than its `start` action.
 */
const DEV_COMMAND =
  /(^|&&|\|\||;)\s*(npx\s+)?(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|develop)\b|(^|&&|\|\||;)\s*(npx\s+)?(vite|nodemon|react-scripts\s+start|next\s+dev|nuxt\s+dev|astro\s+dev|serve)\b/i;

export function isDevServerCommand(command: string): boolean {
  return DEV_COMMAND.test(command);
}

/**
 * Debounce window: the model writes a project file by file, and Vite needs a
 * settled tree before a restart is worth paying for.
 */
export const RESTART_DEBOUNCE_MS = 1200;

/**
 * Escape hatch for people who distrust HMR: set
 * `localStorage.setItem('restart_on_every_change', 'true')` and any edit
 * restarts the dev server instead of only config edits.
 */
export const ALWAYS_RESTART_KEY = 'restart_on_every_change';

export function isAlwaysRestartEnabled(storedValue: string | null | undefined): boolean {
  return storedValue === 'true';
}

export function shouldRestartOnChanges(paths: string[], options: { alwaysRestart?: boolean } = {}): boolean {
  if (!paths.length) {
    return false;
  }

  return options.alwaysRestart ? true : anyRequiresDevServerRestart(paths);
}
