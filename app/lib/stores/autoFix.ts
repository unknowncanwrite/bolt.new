import { atom } from 'nanostores';
import { AUTO_FIX_SETTING_KEY, isAutoFixEnabled } from '~/lib/utils/autoFixErrors';

/**
 * Client-side state for automatic error fixing: the preference (persisted, like
 * the other per-browser settings) plus the anti-loop bookkeeping that lives in
 * memory for the page view.
 *
 * Kept out of the workbench store so the workbench does not grow a dependency on
 * chat concerns, and out of the component so a remount cannot silently reset the
 * attempt counter and hand the loop back.
 */
const readInitialEnabled = () =>
  isAutoFixEnabled(typeof window === 'undefined' ? null : window.localStorage.getItem(AUTO_FIX_SETTING_KEY));

export const autoFixEnabled = atom<boolean>(readInitialEnabled());

export interface AutoFixTracker {
  attempts: number;
  lastSignature: string | null;
  lastAt: number;
}

export const autoFixTracker = atom<AutoFixTracker>({ attempts: 0, lastSignature: null, lastAt: 0 });

export function setAutoFixEnabled(enabled: boolean) {
  autoFixEnabled.set(enabled);

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AUTO_FIX_SETTING_KEY, enabled ? 'true' : 'false');
  }
}

/** Call this the moment a fix request is injected, before anything async runs. */
export function recordAutoFixAttempt(signature: string) {
  const current = autoFixTracker.get();
  autoFixTracker.set({ attempts: current.attempts + 1, lastSignature: signature, lastAt: Date.now() });
}

/** A new user turn means the old failures are no longer the newest word. */
export function resetAutoFixAttempts() {
  autoFixTracker.set({ attempts: 0, lastSignature: null, lastAt: 0 });
}
