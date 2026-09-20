import { RESTART_DEBOUNCE_MS } from './devServerRestart';

/**
 * Coalescing point for "a file in the sandbox just changed".
 *
 * Two very different writers need the same follow-up - the artifact runner
 * streaming dozens of files while the model writes, and a human pressing Ctrl+S
 * in the editor - and neither should cause a dev server restart per file. So both
 * just announce a path, and one timer decides when the batch is settled.
 *
 * Deliberately a module-level Set rather than a store: there is nothing to render
 * from it, and a store would tempt someone into re-rendering on every write.
 */
type Flush = (paths: string[]) => void;

const listeners = new Set<Flush>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

export function onFileChanges(listener: Flush): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function notifyFileChange(filePath: string, flushAfterMs: number = RESTART_DEBOUNCE_MS): void {
  if (!filePath) {
    return;
  }

  pending.add(filePath);

  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(() => {
    timer = undefined;
    flushFileChanges();
  }, flushAfterMs);
}

/** Exposed for tests and for a "restart now" affordance that skips the wait. */
export function flushFileChanges(): string[] {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }

  if (pending.size === 0) {
    return [];
  }

  const batch = [...pending];
  pending.clear();
  listeners.forEach((listener) => listener(batch));

  return batch;
}

/** Test-only: drop any in-flight timer so cases do not leak into each other. */
export function __resetFileChangeBus(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }

  pending.clear();
  listeners.clear();
}
