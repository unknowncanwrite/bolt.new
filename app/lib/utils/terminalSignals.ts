import { isDevServerCommand } from './devServerRestart';

/**
 * Reading what the terminal *says*, not just the exit code it returns.
 *
 * The command runner can only see three things: that a command started, the
 * bytes it printed, and - eventually - an exit code. For the commands that
 * matter most here that is the wrong shape of visibility:
 *
 *   - `npm run dev` is *supposed* to never exit, so a Vite failure that prints
 *     `Internal server error` and then sits there waiting for a file change
 *     looks exactly like a healthy dev server. Nothing notices it, and the
 *     preview stays blank forever.
 *   - a dev server that is still installing/booting prints no exit code at all,
 *     so "it never came up" is invisible unless somebody times it.
 *
 * So the raw output is scanned as it streams, with these patterns, and a boot
 * gets a deadline. Deliberately conservative: every pattern is a string a tool
 * only writes when something actually broke, because a false positive here sends
 * the model chasing a problem that does not exist. Warnings, deprecation notices
 * and progress lines are not in this list on purpose.
 */

/** Same escape-sequence stripper the terminal code uses (xterm control codes). */
export const ANSI_CODES = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CODES, '');
}

export interface TerminalErrorMatch {
  /** Stable id, used for "have I already reported this exact failure" dedupe. */
  id: string;

  /** Human/model readable diagnosis, phrased as a fact about the output. */
  label: string;

  /** The offending line, already ANSI-stripped and trimmed. */
  line: string;
}

interface ErrorPattern {
  id: string;
  label: string;
  pattern: RegExp;
}

/**
 * Ordered by how specific they are: the first match on a line wins, so the more
 * precise signatures come before the broad ones.
 */
export const ERROR_PATTERNS: ErrorPattern[] = [
  {
    id: 'module-missing',
    label: 'a module could not be resolved',
    pattern: /Failed to resolve import .*from "([^"]+)"/i,
  },
  { id: 'module-missing', label: 'a module is not installed', pattern: /Cannot find module '([^']+)'/i },
  { id: 'module-missing', label: 'a module is not installed', pattern: /Module not found: Can't resolve '([^']+)'/i },
  { id: 'module-missing', label: 'a module is not installed', pattern: /ERR_MODULE_NOT_FOUND/ },
  {
    id: 'binary-missing',
    label: 'a command or binary is missing from node_modules',
    pattern: /^(sh|bash|\/bin\/sh): (\d+: )?.*not found/,
  },
  { id: 'port-in-use', label: 'the dev server port is already in use', pattern: /EADDRINUSE/ },
  {
    id: 'vite-internal',
    label: 'the dev server reported an internal server error',
    pattern: /\[vite\] Internal server error/i,
  },
  { id: 'vite-transform', label: 'a file failed to compile', pattern: /Transform failed with \d+ error/i },
  {
    id: 'vite-prebundle',
    label: 'dependency pre-bundling failed',
    pattern: /failed to load config|Pre-transform error|Failed to load url/i,
  },
  { id: 'vite-start', label: 'the dev server failed to start', pattern: /error when starting dev server/i },
  {
    id: 'npm-eresolve',
    label: 'package versions conflict',
    pattern: /ERESOLVE|could not resolve dependency|Conflicting peer dependency/i,
  },
  { id: 'npm-error', label: 'the package manager failed', pattern: /^npm (ERR!|error) code (\w+)/ },
  {
    id: 'script-failed',
    label: 'an npm script exited with an error',
    pattern: /^npm (ERR!|error) \S+.*(exited with a non-zero|failed)/,
  },
  { id: 'syntax-error', label: 'a file has a syntax error', pattern: /SyntaxError:(.+)/ },
  { id: 'type-error', label: 'TypeScript rejected the code', pattern: /error TS(\d+):/ },
  {
    id: 'runtime-error',
    label: 'the running app threw',
    pattern: /(ReferenceError|TypeError|RangeError):(?!.*deprecated).+/,
  },
];

/**
 * Lines that mean "a dev server is up", so a boot deadline can be cancelled.
 *
 * Deliberately wider than Vite, because the same deadline applies to whatever
 * `npm run dev` happens to run: Next says `Ready in 2.3s`, webpack says
 * `compiled successfully`, Astro says `server running at`. A list that only
 * knows one tool's phrasing turns a working app into a false alarm, and a false
 * alarm costs a model turn to "fix" nothing.
 */
const READY_PATTERNS = [
  /ready in \d+(\.\d+)?\s*(ms|s|sec|secs|seconds)?\b/i,
  /(Local|Network|Address):\s*https?:\/\//i,
  /on your (local )?network/i,
  /listening on https?:\/\//i,
  /server running at/i,
  /(is running|serving|served) at\s*https?:\/\//i,
  /started (development )?server on (localhost|0\.0\.0\.0|127\.0\.0\.1)/i,
  /(compiled|built) successfully|webpack compiled/i,
];

/** Noise that has matched a runtime-error shape without meaning a failure. */
const IGNORE_LINES = [/0 errors/, /no errors found/, /\bin progress\b/i, /^\s*$/];

export function isReadyEvidence(text: string): boolean {
  return READY_PATTERNS.some((pattern) => pattern.test(text));
}

function isIgnorable(line: string): boolean {
  return IGNORE_LINES.some((pattern) => pattern.test(line));
}

/**
 * Scan one already-complete line. Kept line-granular (rather than a regex over
 * the whole chunk) so `label`/`line` stay meaningful and so a match cannot span
 * an arbitrary chunk boundary.
 */
export function matchErrorLine(line: string): TerminalErrorMatch | undefined {
  const clean = stripAnsi(line).trim();

  if (!clean || isIgnorable(clean)) {
    return undefined;
  }

  for (const { id, label, pattern } of ERROR_PATTERNS) {
    if (pattern.test(clean)) {
      return { id, label, line: clean.slice(0, 400) };
    }
  }

  return undefined;
}

/**
 * Dedupe key. The pattern id alone is too coarse (two different missing modules
 * are two different problems) and the full line is too fine (Vite reprints the
 * same failure with a fresh stack frame after every save).
 */
export function terminalErrorSignature(match: TerminalErrorMatch): string {
  return `${match.id}|${match.line
    .replace(/:\d+:\d+/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()}`;
}

/**
 * How long to wait for a freshly started dev server to say it is ready before
 * concluding it never will. Generous on purpose: on the free tier's fractional
 * CPU, a first `npm run dev` after `npm install` routinely takes 20-30 s, and
 * crying wolf would send the model to "fix" a server that is fine.
 */
export const DEV_BOOT_TIMEOUT_MS = 75_000;

/** `sh -c "..."` style wrappers, unwrapped so the command inside can be judged. */
const SHELL_WRAPPER = /^(?:sh|bash|zsh|env)\s+(?:-\S+\s+)*(-c\s+)?/;

/**
 * Output that mentions the dev-server binary for a reason other than serving the
 * app. `vite v5.4.8 building for production...` would otherwise read as a boot
 * and start a countdown against a build that finishes in four seconds.
 */
const NOT_A_SERVER = /\b(build|building|builds|lint|test|preview|check)\b/;

/** A shell prompt as it appears in echoed output, if the terminal printed one. */
const LEADING_PROMPT = /^\s*(?:[$%#>]\s*|\S+@\S+[:~][^\s]*[$#>]\s*)/;

/**
 * What the beginning of a real command looks like. Case-sensitive on purpose:
 * nobody types `NPM RUN DEV`, and every Vite banner starts with a capital `VITE`
 * or a `[vite]` prefix, so anchoring on the lowercase verb tells an echoed
 * command apart from a line the server happened to print about itself.
 */
const COMMAND_SHAPE =
  /^(?:(?:sh|bash|zsh)\s+-c\s+)?(?:(?:npx|npm|pnpm|yarn|bun)\s+\S|vite(?:\s|$)|node\s+\S|serve(?:\s|$))/;

/**
 * Whether a line of terminal output is the *echo* of a dev server starting
 * (`npm run dev` and friends). Delegates to the same predicate the command
 * runner uses, so "a dev server is booting" means one thing in both places.
 *
 * Being strict here matters: if `VITE v5.4.8  ready in 412 ms` counted as a dev
 * command, every banner and every `[vite] hmr update` line would re-arm the boot
 * watch that has just settled, and an hour of healthy output would eventually
 * produce an alert about a server that is fine.
 */
export function isDevServerCommandLine(line: string): boolean {
  const command = stripAnsi(line).replace(LEADING_PROMPT, '').replace(/["'`]/g, '').trim().replace(SHELL_WRAPPER, '');

  if (!command || command.length > 200 || !COMMAND_SHAPE.test(command)) {
    return false;
  }

  return isDevServerCommand(command) && !NOT_A_SERVER.test(command);
}

/**
 * The output a fix request should quote: the end of the transcript, since that
 * is where the interesting failure is, and only the end because the model has a
 * context window and a per-token cost.
 */
export function errorTail(buffer: string, maxChars = 2600): string {
  const clean = stripAnsi(buffer);

  if (clean.length <= maxChars) {
    return clean.trim();
  }

  const cut = clean.slice(-maxChars);
  const firstNewline = cut.indexOf('\n');

  return (firstNewline > 0 ? cut.slice(firstNewline + 1) : cut).trim();
}
