import * as fs from 'fs';
import * as path from 'path';
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

/** A latch that must fire once per session, however many windows attach. */
export type SessionLatch = 'sessionStartEmitted' | 'agentLaunched';

/** Where latch markers live under the workspace; `.promptster/` never reaches the bundle. */
export const LATCH_DIR = '.promptster/editor-latches';

export class SessionStore {
  /**
   * `workspaceRoot` backs the once-per-session latches with files on the box.
   * globalState alone is not enough there: in code-server it lives in the
   * BROWSER (IndexedDB), so a second browser, an incognito window or a cleared
   * profile starts with no latches, and every one of them launched another
   * agent terminal and re-sent session_start (4 of each on session d35c34cc).
   */
  constructor(
    private readonly memento: vscode.Memento,
    private readonly workspaceRoot: () => string | undefined = () => undefined,
  ) {}

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

  /**
   * True for exactly one caller per session, across reloads, browsers and
   * concurrent windows (each window gets its own extension host, so a
   * read-then-write check would let two of them through). The claim is an
   * exclusive create of a marker file; without a workspace it falls back to
   * the memento.
   */
  async claim(sessionId: string, latch: SessionLatch): Promise<boolean> {
    const root = this.workspaceRoot();
    const marker = root ? path.join(root, LATCH_DIR, `${sessionId}.${latch}`) : undefined;
    if (this.read(sessionId)[latch]) {
      // Set by a build that kept latches in the browser only: write the marker
      // now, or the next browser to attach finds nothing and fires again.
      if (marker) createMarker(marker);
      return false;
    }
    if (marker && createMarker(marker) === 'exists') {
      await this.remember(sessionId, latch);
      return false;
    }
    // The claim is won. Remembering it in the browser too is best-effort: a
    // failed write must not cancel the action the marker already reserved.
    await this.remember(sessionId, latch);
    return true;
  }

  private async remember(sessionId: string, latch: SessionLatch): Promise<void> {
    try {
      await this.update(sessionId, { [latch]: true });
    } catch {
      // The marker on disk is the record that matters across browsers.
    }
  }

  async update(sessionId: string, patch: Partial<SessionCaptureState>): Promise<void> {
    const next = { ...this.read(sessionId), ...patch };
    await this.memento.update(this.key(sessionId), next);
  }
}

/**
 * Exclusive create. 'error' (an unwritable workspace) counts as a win for the
 * caller: losing the candidate's agent is worse than a possible duplicate.
 */
function createMarker(marker: string): 'created' | 'exists' | 'error' {
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' });
    return 'created';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'error';
  }
}
