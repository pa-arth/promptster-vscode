import type { NotCapturingReason, PromptsterSession } from './types';
import { isExpired } from './config';

/**
 * Whether this session may be captured, decided from the session itself.
 *
 * The extension does NOT present a consent dialog. It used to: `ensureConsent`
 * raised a modal on activation and stored an acknowledgement in globalState.
 * That was wrong in both directions.
 *
 * A candidate who already accepted the canonical disclosure when they ran
 * `promptster start`, and is then asked again by a different component, learns
 * that the consent screen does not describe the system — which damages the one
 * part of this product that has to be believed. And a globalState flag is
 * per-machine, not per-session: consent given for one assessment silently
 * covered the next one.
 *
 * So: consent is a property of the session, recorded by the CLI, and read here.
 * When it is absent the extension captures nothing and says so in the status
 * bar. It never asks.
 *
 * The consent details webview is still reachable from the command palette
 * ("Promptster: View Captured Signals"). That is a viewer the candidate opens,
 * not a dialog we raise at them.
 */
export function captureDecision(
  session: PromptsterSession | null,
  paused: boolean,
  enabled: boolean,
  now = Date.now(),
): { capture: true } | { capture: false; reason: NotCapturingReason } {
  // `promptster.enabled` is contributed in package.json and described to the
  // candidate as "Enable or disable Promptster telemetry capture". Until now
  // nothing read it: unticking the box changed nothing and capture continued,
  // so anyone who relied on it was captured while believing they had opted out.
  // It is checked FIRST and unconditionally -- an explicit opt-out outranks a
  // session, a recorded consent and an unexpired key alike. There is no path
  // that captures while this is false.
  if (!enabled) return { capture: false, reason: 'disabled' };
  if (paused) return { capture: false, reason: 'paused' };
  if (!session) return { capture: false, reason: 'no-session' };
  if (!session.consentAccepted) return { capture: false, reason: 'consent-not-recorded' };
  if (isExpired(session, now)) return { capture: false, reason: 'session-expired' };
  return { capture: true };
}

export function reasonText(reason: NotCapturingReason): string {
  switch (reason) {
    case 'disabled':
      return 'Not capturing — telemetry is disabled in settings (promptster.enabled).';
    case 'no-session':
      return 'No Promptster session in this workspace. Run `promptster start`.';
    case 'consent-not-recorded':
      return 'Not capturing — this session has no recorded consent.';
    case 'session-expired':
      return 'Not capturing — this session has expired.';
    case 'paused':
      return 'Capture is paused — run "Promptster: Resume Capture".';
  }
}
