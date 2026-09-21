/**
 * Reading a bundler's syntax complaint, and deciding whether it is still true.
 *
 * A Vite dev server parses the project once at boot ("Failed to scan for
 * dependencies from entries"). If a file was mid-write at that moment - which is
 * normal, because Bolt writes a project file by file while Vite is starting - the
 * scan dies on a snapshot of the tree that no longer exists, and the failure then
 * keeps being replayed on every request out of the transform cache:
 *
 *   [vite] Internal server error: /home/project/src/components/TodoList.tsx:
 *     Unexpected token, expected "," (35:8)
 *
 * ...for a file that `cat` shows to be perfectly fine. The only reliable way to
 * tell "the code is broken" from "the bundler is looking at a stale copy" is to
 * compare the complaint against the file as it is *now*, so that is what this does.
 * It is deliberately not a parser: a bracket balance walk plus an exact match of
 * the line the tool quoted answers the one question being asked - is this error
 * still real? - without shipping Babel to the browser.
 *
 * A wrong "still real" costs one model turn, exactly as before. A wrong "stale"
 * costs a dev server restart, and the restart is capped and re-allows the same
 * error once, so a swallowed failure cannot be swallowed forever.
 */

export interface CompileErrorDetail {
  /** Project-relative path, e.g. `src/components/TodoList.tsx`. */
  file: string;

  /** The path exactly as the tool printed it (often the container's absolute one). */
  printedPath: string;
  line: number;
  column?: number;

  /** The tool's own words, e.g. `Unexpected token, expected ","`. */
  message?: string;

  /** The offending source line, quoted back by the tool. */
  quoted?: string;
}

const SOURCE_EXT = 'tsx|jsx|ts|js|mjs|cjs|vue|svelte|astro|json|jsonc|css';

/** `src/x.tsx:35:8:` (esbuild) and `/home/project/src/x.tsx:35:8` (vite). */
const PATH_LINE_COL = new RegExp(`([^\\s()'"]+\\.(?:${SOURCE_EXT})):(\\d+)(?::(\\d+))?`, 'g');

/** Vite prints `File: <path>:<line>:<col>` in its error overlay text. */
const FILE_FIELD = new RegExp(`File:\\s*([^\\s()]+\\.(?:${SOURCE_EXT})):(\\d+)(?::(\\d+))?`, 'i');

/** `[vite] Pre-transform error: /abs/src/x.tsx: Unexpected token, expected "," (35:8)` */
const PREFIXED_ERROR = new RegExp(
  `(?:Pre-transform error|Internal server error|Transform failed):\\s*([^\\s()]+\\.(?:${SOURCE_EXT})):\\s*(.+?)\\s*\\((\\d+):(\\d+)\\)`,
  'i',
);

/** esbuild's own headline, and the code-frame line it quotes (`35 │  ))}`). */
const ERROR_HEADLINE = /\[ERROR\]\s*([^\n]+)/;
const CODE_FRAME = /^\s*>?\s*(\d+)\s*[│|]\s?(.*)$/;

const NOISE_PATH = /(node_modules|\/dist\/|\/build\/|blitz\.|builtin\.|esbuild\/lib|@babel\/)/;

/** Stripping the container's project root so paths can be compared and looked up. */
export function toProjectPath(printedPath: string): string {
  let out = printedPath.trim().replace(/^file:\/\//, '');

  if (out.startsWith('~/')) {
    out = out.slice(2);
  }

  const withoutRoot = out
    .replace(/^\/(?:home|root|users|workspace|mnt)\/[^/]+\//i, '')
    .replace(/^\/(?:project|app|workspace|repo|home)\//i, '')
    .replace(/^(?:project|workspace|repo)\/(?=.+\/)/i, '');

  const relative = withoutRoot.startsWith('/') ? withoutRoot.slice(1) : withoutRoot;

  /*
   * If stripping produced nothing useful, keep the tail of the path: a lookup
   * against `src/...` is far more likely to hit than `/home/project/src/...`.
   */
  return relative.length > 0 ? relative : out;
}

/**
 * Pull the file, position and quoted line out of a chunk of bundler output.
 * `File:` first, because Vite writes it when it is sure; then the babel-style
 * prefixed form; then any `path:line:col` that is not library internals.
 */
export function parseCompileError(text: string): CompileErrorDetail | undefined {
  if (!text) {
    return undefined;
  }

  let printedPath: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  let message: string | undefined;

  const fileField = text.match(FILE_FIELD);
  const prefixed = text.match(PREFIXED_ERROR);

  if (fileField) {
    printedPath = fileField[1];
    line = Number(fileField[2]);
    column = fileField[3] ? Number(fileField[3]) : undefined;
  } else if (prefixed) {
    printedPath = prefixed[1];
    message = prefixed[2]?.trim();
    line = Number(prefixed[3]);
    column = Number(prefixed[4]);
  } else {
    for (const match of text.matchAll(PATH_LINE_COL)) {
      if (NOISE_PATH.test(match[1]) || !/^\.{0,2}[\/\w~]/.test(match[1])) {
        continue;
      }

      printedPath = match[1];
      line = Number(match[2]);
      column = match[3] ? Number(match[3]) : undefined;
      break;
    }
  }

  if (!printedPath || !line || !Number.isFinite(line)) {
    return undefined;
  }

  const headline = text.match(ERROR_HEADLINE)?.[1]?.trim();

  if (!message && headline) {
    message = headline;
  }

  const quoted = findQuotedLine(text, line);

  return {
    file: toProjectPath(printedPath),
    printedPath,
    line,
    column,
    message: message?.slice(0, 300),
    quoted: quoted?.text ? quoted.text.replace(/\s*\^\s*$/, '').trim() : undefined,
  };
}

/** The `> 35 |  ))}` frame for a given line, if the output carries one. */
function findQuotedLine(text: string, wanted: number): { line: number; text: string } | undefined {
  let fallback: { line: number; text: string } | undefined;

  for (const raw of text.split('\n')) {
    const frame = raw.match(CODE_FRAME);

    if (!frame || Number(frame[1]) !== wanted) {
      continue;
    }

    const entry = { line: wanted, text: frame[2] ?? '' };

    if (raw.includes('>')) {
      return entry;
    }

    fallback ??= entry;
  }

  return fallback;
}

export type StalenessVerdict = 'stale' | 'live' | 'unknown';

/**
 * Is this complaint still true of the file as it exists now?
 *
 * - the quoted line is gone from the file → the fix already landed, the bundler is
 *   replaying a cached error → `stale`;
 * - the quoted line is still there and the tool is complaining about an unclosed
 *   bracket, but the file's brackets balance exactly → the file is fine and the
 *   error is from the scan that raced the write → `stale`;
 * - anything else → `live` (or `unknown` when there is too little to compare).
 */
export function judgeCompileError(detail: CompileErrorDetail | undefined, currentContent: string): StalenessVerdict {
  if (!detail || !currentContent) {
    return 'unknown';
  }

  const quoted = detail.quoted?.trim();

  if (quoted) {
    const stillThere = currentContent
      .split('\n')
      .some((raw) => normalizeForCompare(raw) === normalizeForCompare(quoted))
      ? 'live'
      : 'stale';

    /*
     * A quoted line that is present is only conclusive when the error is about
     * that line; for bracket complaints the balance walk is the better evidence,
     * because the exact text can legitimately be repeated across a file.
     */
    if (stillThere === 'stale' || !isBracketComplaint(detail.message)) {
      return stillThere;
    }
  } else if (!isBracketComplaint(detail.message)) {
    return 'unknown';
  }

  const imbalance = findBracketImbalance(currentContent);

  if (!imbalance) {
    return 'stale';
  }

  /* The file really is unbalanced, so the complaint is current: ask the model. */
  return 'live';
}

const BRACKET_COMPLAINT =
  /(Expected\s*["')\]}]|Unexpected token,? expected|Unterminated|missing\s*\)|expected ,|Expected corresponding)/i;

export function isBracketComplaint(message?: string): boolean {
  return message !== undefined && BRACKET_COMPLAINT.test(message);
}

const normalizeForCompare = (value: string) => value.trim().replace(/\s+/g, ' ');

export interface BracketImbalance {
  line: number;
  column: number;
  kind: 'unclosed' | 'extra';
  char: string;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Walk the source tracking (), [] and {} while skipping strings, template
 * literals (including `${}` holes), comments and regex literals. Returns the
 * first bracket that does not belong, or undefined when everything pairs up.
 *
 * Not a parser, and it does not need to be: JSX, plain JS and TS all nest their
 * grouping characters the same way, and "the braces balance" is exactly the
 * property a stale `Expected ")" but found "}"` is accusing the file of losing.
 */
export function findBracketImbalance(source: string): BracketImbalance | undefined {
  const stack: { char: string; line: number; column: number; isHole?: boolean }[] = [];
  const modes: ('code' | 'template')[] = ['code'];
  let line = 1;
  let column = 0;
  let previousCode = '';

  const inTemplate = () => modes[modes.length - 1] === 'template';

  while (column < source.length) {
    const char = source[column];
    const next = source[column + 1];

    if (char === '\n') {
      line += 1;
      column += 1;
      continue;
    }

    /* inside a template literal: only ` and ${ matter */
    if (inTemplate()) {
      if (char === '\\') {
        column += 2;
        continue;
      }

      if (char === '`') {
        modes.pop();
        column += 1;
        continue;
      }

      if (char === '$' && next === '{') {
        modes.push('code');
        stack.push({ char: '{', line, column, isHole: true });
        column += 2;
        continue;
      }

      column += 1;
      continue;
    }

    /* line comment */
    if (char === '/' && next === '/') {
      while (column < source.length && source[column] !== '\n') {
        column += 1;
      }

      continue;
    }

    /* block comment */
    if (char === '/' && next === '*') {
      column += 2;

      while (column < source.length && !(source[column] === '*' && source[column + 1] === '/')) {
        if (source[column] === '\n') {
          line += 1;
        }

        column += 1;
      }

      column += 2;
      continue;
    }

    /* '...' or "..." */
    if (char === '"' || char === "'") {
      column += 1;

      while (column < source.length && source[column] !== '\n') {
        if (source[column] === '\\') {
          column += 2;
          continue;
        }

        if (source[column] === char) {
          column += 1;
          break;
        }

        column += 1;
      }

      continue;
    }

    /* `...${ ... }...` */
    if (char === '`') {
      modes.push('template');
      column += 1;
      continue;
    }

    /* the } that ends a template hole returns to the literal */
    if (char === '}') {
      const top = stack[stack.length - 1];

      if (top?.isHole) {
        stack.pop();
        modes.pop();
        column += 1;
        previousCode = '}';
        continue;
      }
    }

    /* regex literal: only where a value can start, and only if it closes on this line */
    if (char === '/' && /[([{,;:=!&|?+\-*%~^]|^$|return$|typeof$|\bin$/.test(previousCode)) {
      const start = column;
      let inClass = false;
      let closed = false;

      column += 1;

      while (column < source.length && source[column] !== '\n') {
        const inner = source[column];

        if (inner === '\\') {
          column += 2;
          continue;
        }

        if (inner === '[') {
          inClass = true;
        } else if (inner === ']') {
          inClass = false;
        } else if (inner === '/' && !inClass) {
          closed = true;
          column += 1;
          break;
        }

        column += 1;
      }

      if (!closed) {
        column = start + 1; // it was a division operator after all
        continue;
      }

      previousCode = '/';
      continue;
    }

    if (OPENERS[char]) {
      stack.push({ char, line, column });
      column += 1;
      previousCode = char;
      continue;
    }

    if (CLOSERS[char]) {
      const open = stack.pop();

      if (!open || OPENERS[open.char] !== char) {
        return { kind: 'extra', char, line, column: column + 1 };
      }

      column += 1;
      previousCode = char;
      continue;
    }

    if (/\S/.test(char)) {
      previousCode = (previousCode + char).slice(-12);
    }

    column += 1;
  }

  const leftover = stack[stack.length - 1];

  return leftover
    ? { kind: 'unclosed', char: leftover.char, line: leftover.line, column: leftover.column + 1 }
    : undefined;
}

/** One line for an alert or a prompt: where, and what the tool said. */
export function describeCompileError(detail: CompileErrorDetail | undefined): string {
  if (!detail) {
    return '';
  }

  const place = `${detail.file}:${detail.line}${detail.column ? `:${detail.column}` : ''}`;

  return detail.message ? `${place} - ${detail.message}` : place;
}

const DEV_SEGMENT =
  /(?:npx\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(dev|start|serve|develop)\b|(?:vite|next\s+dev|nuxt\s+dev|astro\s+dev|react-scripts\s+start))/i;

/**
 * The same command, told to throw its caches. `--force` is Vite's flag for
 * "re-run dependency pre-bundling", which is precisely the state that a scan
 * which raced a file write leaves behind; for an npm-style script the `--`
 * separator is what forwards it to the script.
 *
 * Returns undefined for anything whose last segment is not a dev-server command,
 * so a caller can fall back to the untouched command instead of corrupting it.
 */
export function forceRebuildCommand(command: string): string | undefined {
  const trimmed = command.trim();

  if (!trimmed) {
    return undefined;
  }

  const segments = trimmed.split(/(?:&&|\|\||;|\n)\s*/).map((segment) => segment.trim());
  const last = segments[segments.length - 1] ?? '';

  if (!DEV_SEGMENT.test(last)) {
    return undefined;
  }

  if (last.includes(' -- ')) {
    return trimmed;
  }

  const forced = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|develop)\b/i.test(last)
    ? `${last} -- --force`
    : `${last} --force`;

  if (segments.length === 1) {
    return forced;
  }

  return `${segments.slice(0, -1).join(' && ')} && ${forced}`;
}

/**
 * How many times a single reported line may be written off as a stale cache.
 * Twice is enough to clear the cache and re-scan; a third complaint about the same
 * line is treated as real, so a wrong "stale" verdict can only ever delay the
 * model, never hide the failure from it.
 */
export const MAX_STALE_CACHE_RESTARTS = 2;

export interface CompileErrorRecovery {
  /** Throw the caches and boot again, or hand the failure to the model. */
  action: 'restart' | 'ask-model';
  reason: string;
}

/**
 * Given a bundler complaint and the file as it exists right now, decide who should
 * act. Clearing a stale cache is a one-second shell flag; asking the model costs a
 * turn, a few thousand tokens and - when the file was never broken - rewrites code
 * that did not need rewriting. So the cheap deterministic fix goes first, and only
 * a complaint that still matches the file is handed on.
 */
export function decideCompileErrorRecovery(input: {
  detail?: CompileErrorDetail;
  content?: string;
  attempts: number;
  maxAttempts?: number;
  hasDevServer: boolean;
}): CompileErrorRecovery {
  const max = input.maxAttempts ?? MAX_STALE_CACHE_RESTARTS;

  if (!input.detail) {
    return { action: 'ask-model', reason: 'the error did not name a file to check' };
  }

  if (!input.hasDevServer) {
    return { action: 'ask-model', reason: 'there is no dev server here to restart' };
  }

  if (input.content === undefined) {
    return { action: 'ask-model', reason: `${input.detail.file} is not in the project tree to compare` };
  }

  if (input.attempts >= max) {
    return {
      action: 'ask-model',
      reason: `the cache was already cleared ${input.attempts} times for ${input.detail.file}:${input.detail.line}`,
    };
  }

  if (judgeCompileError(input.detail, input.content) !== 'stale') {
    return {
      action: 'ask-model',
      reason: `${input.detail.file}:${input.detail.line} still reads as broken to the same check`,
    };
  }

  return {
    action: 'restart',
    reason: `the reported line is not a problem in ${input.detail.file} any more - the bundler is replaying its startup scan`,
  };
}
