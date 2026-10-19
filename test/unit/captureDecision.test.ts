import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { captureDecision, reasonText } from '../../src/consent';
import type { PromptsterSession } from '../../src/types';

/**
 * `promptster.enabled` is contributed in package.json and shown to the candidate
 * as "Enable or disable Promptster telemetry capture". It was never read: no
 * `getConfiguration` call existed anywhere in src/, so unticking it changed
 * nothing and capture continued. We were shipping a visible control that claimed
 * to stop telemetry and did not.
 *
 * These tests exist so that can never silently regress. The first one is the
 * whole promise: enabled=false captures under no circumstances.
 */
const ok = (over: Partial<PromptsterSession> = {}): PromptsterSession => ({
  apiUrl: 'https://api.example.test',
  apiKey: 'k',
  sessionId: 's',
  consentAccepted: true,
  consentToIntegrity: true,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  tools: [],
  hosted: false,
  sourceFile: '.promptster/session.json',
  ...over,
});

describe('captureDecision', () => {
  it('never captures when promptster.enabled is false', () => {
    // Every combination that would otherwise capture, plus the ones that would
    // not. The opt-out outranks all of them — no input makes this capture.
    for (const paused of [false, true]) {
      for (const session of [ok(), ok({ consentAccepted: false }), null]) {
        const d = captureDecision(session, paused, false);
        expect(d.capture).toBe(false);
        expect(d).toEqual({ capture: false, reason: 'disabled' });
      }
    }
  });

  it('captures a healthy consented session when enabled', () => {
    expect(captureDecision(ok(), false, true)).toEqual({ capture: true });
  });

  it('still honours the other gates when enabled', () => {
    expect(captureDecision(ok(), true, true)).toEqual({ capture: false, reason: 'paused' });
    expect(captureDecision(null, false, true)).toEqual({ capture: false, reason: 'no-session' });
    expect(captureDecision(ok({ consentAccepted: false }), false, true)).toEqual({
      capture: false,
      reason: 'consent-not-recorded',
    });
    expect(
      captureDecision(ok({ expiresAt: new Date(Date.now() - 1000).toISOString() }), false, true),
    ).toEqual({ capture: false, reason: 'session-expired' });
  });

  it('explains the disabled state to the candidate', () => {
    expect(reasonText('disabled')).toMatch(/promptster\.enabled/);
  });
});
