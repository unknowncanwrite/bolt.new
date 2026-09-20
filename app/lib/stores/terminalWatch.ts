import { atom } from 'nanostores';
import { stripAnsi } from '~/lib/utils/terminalSignals';
import {
  DEV_BOOT_TIMEOUT_MS,
  errorTail,
  isDevServerCommandLine,
  isReadyEvidence,
  matchErrorLine,
  terminalErrorSignature,
  type TerminalErrorMatch,
} from '~/lib/utils/terminalSignals';

/**
 * Live reading of the terminal the agent runs commands in.
 *
 * Three jobs, all of them about the gap between "a command exited with an error"
 * (which the runner already reports) and "something is wrong right now":
 *
 *  1. scan output line by line as it streams, so a dev server that prints a
 *     failure and then *stays running* is noticed instead of ignored;
 *  2. keep the tail of the transcript, so a fix request can quote real output
 *     instead of "it failed";
 *  3. put a deadline on a dev server boot, so "the preview never came up"
 *     becomes a signal with a timestamp rather than a silent dead end.
 *
 * Only output produced while a command is attached to the shell is examined.
 * That one condition is what keeps this from being annoying: without it, an idle
 * terminal whose scrollback happens to contain `Cannot find module` would keep
 * re-triggering the model forever.
 */

/** ~16 KB of decoded text: a stack trace plus its context. */
const BUFFER_LIMIT = 16_000;

export interface TerminalSignal extends TerminalErrorMatch {
  at: number;

  /** Output around the failure, for the model to reason about. */
  tail: string;
}

export interface BootOutcome {
  /** The output said the server is listening. */
  ready: boolean;

  /** Nothing said either way before the deadline. */
  timedOut: boolean;
  tail: string;
  signal?: TerminalSignal;
}

interface BootWaiter {
  resolve: (outcome: BootOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const terminalSignal = atom<TerminalSignal | undefined>(undefined);

let buffer = '';
let carry = '';
let publishedSignature: string | null = null;
let bootWaiter: BootWaiter | undefined;

function append(text: string) {
  buffer += text;

  if (buffer.length > BUFFER_LIMIT) {
    buffer = buffer.slice(-BUFFER_LIMIT);
  }
}

function settleBootWatch(ready: boolean, signal?: TerminalSignal) {
  if (!bootWaiter) {
    return;
  }

  const waiter = bootWaiter;
  bootWaiter = undefined;
  clearTimeout(waiter.timer);
  waiter.resolve({ ready, timedOut: false, tail: errorTail(buffer), signal });
}

function publish(match: TerminalErrorMatch): TerminalSignal {
  const signal: TerminalSignal = { ...match, at: Date.now(), tail: errorTail(buffer) };
  publishedSignature = terminalErrorSignature(match);
  terminalSignal.set(signal);
  settleBootWatch(false, signal);

  return signal;
}

/**
 * Put a deadline on the current dev server boot. Resolves as soon as the output
 * proves the server is listening, as soon as an error line explains why it is
 * not, or when the timeout passes.
 *
 * Arming twice is harmless and expected (the runner arms when it issues the
 * command, the line scanner arms when it sees the command echoed): the second
 * caller awaits the *same* outcome rather than replacing the first one's timer,
 * which would leave a caller waiting on a promise nobody resolves.
 */
export function armDevServerBootWatch(timeoutMs: number = DEV_BOOT_TIMEOUT_MS): Promise<BootOutcome> {
  if (bootWaiter) {
    return new Promise<BootOutcome>((resolve) => {
      const current = bootWaiter as BootWaiter;
      const chained = current.resolve;
      bootWaiter = {
        resolve: (outcome) => {
          chained(outcome);
          resolve(outcome);
        },
        timer: current.timer,
      };
    });
  }

  return new Promise<BootOutcome>((resolve) => {
    const timer = setTimeout(() => {
      if (!bootWaiter) {
        return;
      }

      bootWaiter = undefined;

      const tail = errorTail(buffer);

      /*
       * Last chance not to raise a false alarm: if anything the command printed
       * says a server is listening, then no deadline was ever missed, and
       * reporting one would have the model rebuild a working app.
       */
      const evidenceOfBoot = tail.split('\n').some((line) => isReadyEvidence(stripAnsi(line)));

      resolve({ ready: evidenceOfBoot, timedOut: !evidenceOfBoot, tail });
    }, timeoutMs);

    bootWaiter = { resolve: (outcome) => resolve(outcome), timer };
  });
}

/**
 * Push one decoded chunk from a shell. `commandActive` is the caller's answer to
 * "is a command running in this shell right now".
 */
export function ingestTerminalChunk(chunk: string, options: { commandActive?: boolean } = {}): void {
  if (!chunk) {
    return;
  }

  append(chunk);

  const serverSaysItIsUp = isReadyEvidence(chunk);

  if (serverSaysItIsUp) {
    settleBootWatch(true);
  }

  if (!options.commandActive) {
    return;
  }

  const lines = `${carry}${chunk}`.split('\n');
  carry = lines.pop() ?? '';

  let publishedHere = false;

  for (const line of lines) {
    /*
     * The echoed command itself is the earliest possible proof a dev server is
     * booting, which matters when the command was typed by hand in the terminal
     * rather than issued by the runner.
     */
    if (isDevServerCommandLine(line)) {
      void armDevServerBootWatch();
    }

    const match = matchErrorLine(line);

    if (!match) {
      continue;
    }

    if (terminalErrorSignature(match) === publishedSignature) {
      continue;
    }

    publish(match);
    publishedHere = true;

    return;
  }

  /*
   * A dev server announcing that it is listening is the best evidence there is
   * that an earlier terminal error is over. So the signal goes away by itself -
   * nobody should be left staring at an error box for a problem the last run
   * already fixed - and the same failure is allowed to be reported again if it
   * comes back later. An error in this same chunk wins: recovery is not claimed
   * while the output still ends on a failure.
   */
  if (serverSaysItIsUp && !publishedHere && publishedSignature !== null) {
    publishedSignature = null;
    terminalSignal.set(undefined);
  }
}

/**
 * Report a condition worth the model's attention that no error line announced -
 * e.g. "the dev server was killed by another command and nothing replaced it".
 * Same dedupe and same alert path as a scanned line, so there is one budget and
 * one loop guard for both.
 */
export function raiseTerminalSignal(match: TerminalErrorMatch): TerminalSignal | undefined {
  if (terminalErrorSignature(match) === publishedSignature) {
    return undefined;
  }

  return publish(match);
}

/** Last seen output, for quoting into a prompt or a log line. */
export function recentTerminalOutput(maxChars?: number): string {
  return errorTail(buffer, maxChars);
}

/** Whether a dev server boot is being watched (diagnostics, tests). */
export function isBootWatchArmed(): boolean {
  return bootWaiter !== undefined;
}

/**
 * Forget the "already reported this error" marker without touching the alert.
 * A person typing a new message is a fresh slate: if the model's fix fails and
 * the identical error comes back, that deserves to be noticed again.
 */
export function resetTerminalSignalDedupe(): void {
  publishedSignature = null;
}

/** Drop accumulated state between page views and tests. */
export function resetTerminalWatch(): void {
  buffer = '';
  carry = '';
  publishedSignature = null;
  terminalSignal.set(undefined);

  if (bootWaiter) {
    clearTimeout(bootWaiter.timer);
    bootWaiter = undefined;
  }
}
