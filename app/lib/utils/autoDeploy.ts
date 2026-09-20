/**
 * Pure decision logic for "deploy to Vercel as soon as generation finishes".
 *
 * Kept free of React/store imports so the gate can be unit tested, and so the hook that
 * owns it (`useVercelAutoDeploy`) only has to collect signals.
 */

export interface AutoDeployGate {
  // User has explicitly switched auto-deploy on (Settings -> Vercel). Off by default.
  enabled: boolean;

  // A Vercel account is reachable, either client-side or through the server token.
  connected: boolean;

  // The model is still writing the project.
  isStreaming: boolean;

  // The generated app is running, i.e. its dev server published a preview.
  hasPreview: boolean;

  /*
   * A generation actually happened in this page view, which keeps a reload of an old chat from
   * firing a fresh deployment.
   */
  sawGeneration: boolean;

  // A deployment is already running.
  inFlight: boolean;

  // This chat was already auto-deployed in this page view.
  alreadyDeployed: boolean;
}

/**
 * Every condition has to hold: no preview yet means dependencies may still be installing,
 * and deploying mid-stream would ship a half-written artifact.
 */
export function shouldTriggerAutoDeploy(gate: AutoDeployGate): boolean {
  return (
    gate.enabled &&
    gate.connected &&
    gate.hasPreview &&
    gate.sawGeneration &&
    !gate.isStreaming &&
    !gate.inFlight &&
    !gate.alreadyDeployed
  );
}

/**
 * Give the preview a moment to settle after the stream ends: the runner still has to finish
 * `npm install` and boot the dev server before `npm run build` is worth running.
 */
export const AUTO_DEPLOY_SETTLE_MS = 4000;

/** localStorage key holding the user preference. */
export const AUTO_DEPLOY_SETTING_KEY = 'vercel_auto_deploy';

/**
 * Whether the preference is on. Absent means **off**: shipping a project to the
 * internet is a decision, not a side effect of generation finishing, so it happens
 * when the user clicks Deploy (or opts in under Settings -> Vercel for the people
 * who want generation and publish fused). An old opt-out value of 'true' keeps
 * working, and 'false' still means off.
 */
export function isAutoDeployEnabled(storedValue: string | null | undefined): boolean {
  return storedValue === 'true';
}

/** Identity of "this chat" for the once-per-page-view guard. */
export function autoDeployChatKey(chatId: string | null | undefined): string {
  return `chat:${chatId ?? 'unpersisted'}`;
}
