import type * as vscode from 'vscode';

/**
 * Per-session capture state that must survive an editor reload.
 *
 * A hosted or local editor is reattached routinely — a reloaded window, a
 * reconnected remote, a resumed machine. Everything in here exists so that the
 * second attach does not re-report what the first one already reported. It is
 * keyed by session id, so a new assessment starts clean and one assessment's
 * state can never leak into the next.
 */
export interface SessionCaptureState {
  sessionStartEmitted: boolean;
  openedFiles: string[];
  paused: boolean;
  agentLaunched: boolean;
}

const PREFIX = 'promptster.capture.';

const EMPTY: SessionCaptureState = {
  sessionStartEmitted: false,
  openedFiles: [],
  paused: false,
  agentLaunched: false,
};

export class SessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  private key(sessionId: string): string {
    return `${PREFIX}${sessionId}`;
  }

  read(sessionId: string): SessionCaptureState {
    const stored = this.memento.get<Partial<SessionCaptureState>>(this.key(sessionId));
    if (!stored) return { ...EMPTY, openedFiles: [] };
    return {
      sessionStartEmitted: stored.sessionStartEmitted === true,
      openedFiles: Array.isArray(stored.openedFiles) ? stored.openedFiles : [],
      paused: stored.paused === true,
      agentLaunched: stored.agentLaunched === true,
    };
  }

  async update(sessionId: string, patch: Partial<SessionCaptureState>): Promise<void> {
    const next = { ...this.read(sessionId), ...patch };
    await this.memento.update(this.key(sessionId), next);
  }
}
