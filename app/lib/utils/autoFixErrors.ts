/**
 * Gate for "when the generated app throws, ask the model to fix it" - without
 * waiting for a click.
 *
 * The alert UI used to be the only way this happened: an error appeared with an
 * "Ask Bolt" button and the model never found out unless a human pressed it. A
 * person who does not write code cannot read a stack trace, so for them the
 * error was just a dead end. The gate below decides when to inject the fix
 * request on the user's behalf, and every condition is here to stop the thing
 * that would make this feature a disaster: an infinite loop where a model fix
 * produces the next error, which produces the next fix request, spending API
 * credits forever.
 *
 *  - never while the model is already streaming (its next artifact may fix it)
 *  - never for the same error signature twice (a fix that did not work is not a
 *    new error)
 *  - a hard attempt ceiling per chat, so a genuinely broken project stops after
 *    a few tries and leaves the manual alert in place
 *  - never for a user-cancelled run
 *
 * `parseErrorSignal` reads the same alert payload the alert UI renders, so there
 * is one definition of "this looks like an app error" for both paths.
 */

/** Cap on automatic fix requests, per chat, per page view. */
export const MAX_AUTO_FIX_ATTEMPTS = 3;

/** Cooldown between one fix landing and the next error being acted on. */
export const AUTO_FIX_COOLDOWN_MS = 15_000;

export interface AutoFixCandidate {
  /** The alert the workbench raised. */
  alert: { title?: string; description?: string; content?: string; source?: 'terminal' | 'preview' } | undefined;

  /** A generation is in flight. */
  isStreaming: boolean;

  /** Attempts already spent in this chat. */
  attempts: number;

  /** Signature of the last error we acted on. */
  lastSignature: string | null;

  /** When the last one was sent. */
  lastAt: number;

  /** Now (injected so this stays testable). */
  now: number;

  /** The user opted out in Settings. */
  enabled: boolean;
}

export type AutoFixReason = 'go' | 'disabled' | 'no-alert' | 'streaming' | 'out-of-attempts' | 'repeat' | 'cooldown';

export interface AutoFixDecision {
  action: 'auto-fix' | 'ask-user';
  reason: AutoFixReason;
}

/**
 * Stable identity for one error: title plus the first meaningful lines. Using
 * the whole stack would treat the same failure as "new" every time a line
 * number shifts, which is how a loop starts.
 */
export function errorSignature(alert: AutoFixCandidate['alert']): string {
  if (!alert) {
    return '';
  }

  const body = [alert.title, alert.description, firstErrorLine(alert.content)]
    .filter(Boolean)
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  /*
   * Keep the message text and the file location: those are what a repeat looks
   * like. Stack frames and line numbers are excluded, since they move when the
   * fix lands and would look like a new failure.
   */
  return body;
}

/**
 * The line that identifies an error.
 *
 * The alert's `content` is raw output, but once a fix request has been sent the
 * model's reply quotes it inside a markdown fence wrapped in prose. Reading the
 * first line of the fenced block keeps the identity of the error stable across
 * that round trip - which matters, because "same error" is exactly what the
 * repeat guard looks for.
 */
function firstErrorLine(content: string | undefined): string {
  if (!content) {
    return '';
  }

  const fenced = /```[a-z]*\n([\s\S]*?)```/i.exec(content)?.[1];
  const emphasisOnly = /^\*+.*\*+$/;

  const lines = (fenced ?? content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('at ') && !emphasisOnly.test(line));

  return lines[0] ?? '';
}

/** Errors that are not the model's to fix. */
const NOT_ACTIONABLE = [
  /user aborted|aborted by user|aborterror/i,
  /Failed to fetch dynamically imported module/i, // a cancelled load, not a code error
  /ERR_BLOCKED_BY_CLIENT/i,

  /*
   * A prompt over the model's window is not a bug in the generated code, and the
   * model cannot fix it: every retry it wrote would carry the same oversized
   * context. The app trims the request instead (see contextBudget), and the alert
   * tells the person what actually helps.
   */
  /exceed(?:ed)? the maximum length|context_length_exceeded|prompt is too long|maximum context length/i,
];

export function isActionableError(alert: AutoFixCandidate['alert']): boolean {
  if (!alert) {
    return false;
  }

  const haystack = `${alert.title ?? ''} ${alert.description ?? ''} ${alert.content ?? ''}`;

  return !NOT_ACTIONABLE.some((pattern) => pattern.test(haystack));
}

/**
 * Decide what to do with an error alert. `ask-user` is not a failure: it is the
 * old behaviour, and it is what happens once the automatic budget is spent, so a
 * human is always the last resort rather than being cut out entirely.
 */
export function decideAutoFix(candidate: AutoFixCandidate): AutoFixDecision {
  if (!candidate.enabled) {
    return { action: 'ask-user', reason: 'disabled' };
  }

  if (!candidate.alert) {
    return { action: 'ask-user', reason: 'no-alert' };
  }

  if (!isActionableError(candidate.alert)) {
    return { action: 'ask-user', reason: 'no-alert' };
  }

  if (candidate.isStreaming) {
    return { action: 'ask-user', reason: 'streaming' };
  }

  if (candidate.attempts >= MAX_AUTO_FIX_ATTEMPTS) {
    return { action: 'ask-user', reason: 'out-of-attempts' };
  }

  const signature = errorSignature(candidate.alert);

  if (!signature) {
    return { action: 'ask-user', reason: 'no-alert' };
  }

  if (signature === candidate.lastSignature) {
    return { action: 'ask-user', reason: 'repeat' };
  }

  if (candidate.now - candidate.lastAt < AUTO_FIX_COOLDOWN_MS) {
    return { action: 'ask-user', reason: 'cooldown' };
  }

  return { action: 'auto-fix', reason: 'go' };
}

/**
 * The message sent to the model for a captured error. One builder for both
 * routes - the automatic one and the alert's "Ask Bolt" button - so the model
 * always sees the same shape and the transcript stays readable either way.
 *
 * The automatic version has to say more than "fix this": nobody is there to
 * answer a follow-up question, so it instructs the model to edit files directly
 * instead of replying with instructions for a human to run.
 */
export function buildFixRequestMessage(
  alert: AutoFixCandidate['alert'],
  options: { automatic?: boolean } = {},
): string {
  const isPreview = alert?.source === 'preview';
  const fence = isPreview ? 'js' : 'sh';
  const heading = `*Fix this ${isPreview ? 'preview' : 'terminal'} error${options.automatic ? ' automatically' : ''}*`;

  const guidance = options.automatic
    ? [
        '',
        'This was captured from the running app, not typed by me. Find the root cause in the',
        'output below, change the files that need changing, and restart the dev server if the',
        'fix needs it. Do not ask me to run commands or confirm anything first.',
        '',
        'The terminal is yours: run whatever the fix needs - install a missing package, free a',
        'port that is in use, delete a stale lockfile or generated file, reinstall dependencies,',
        'or start the dev server again yourself. Then read the output and keep going until the',
        'app reports that it is listening, or say what is still blocking it.',
      ]
    : [];

  return [heading, ...guidance, '', `\`\`\`${fence}`, (alert?.content ?? '').trim(), '```'].join('\n');
}

/** localStorage key for the opt-out, mirroring the other per-browser prefs. */
export const AUTO_FIX_SETTING_KEY = 'chat_error_autofix';

/**
 * On unless the user switched it off. Unlike deploying, this spends one chat turn
 * on something that is already broken, and the alternative - leaving a stack
 * trace on screen for someone who cannot read one - is worse, so the feature is
 * opt-out and the toggle in Settings is the way to turn it back into the manual
 * "Ask Bolt" alert.
 */
export function isAutoFixEnabled(storedValue: string | null | undefined): boolean {
  return storedValue !== 'false';
}
