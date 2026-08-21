import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';

const IDLE_THRESHOLD_MS = 60_000; // 60 seconds of no activity = idle

/**
 * Tracks editor window focus/blur and idle detection.
 */
export class FocusCollector extends BaseCollector {
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private isIdle = false;
  private lastActivityAt = Date.now();
  private idleStartedAt = 0;
  private lastAction: string = 'unknown';

  activate(): void {
    // No window focus/blur events. The window-state API answers "is the
    // candidate still looking at the editor", which is focus tracking — the
    // thing the public candidate promise disclaims by name on four separate
    // pages ("No webcam, no focus tracking, no proctoring overlay"). Idle
    // detection below stays: it is derived from activity in the editor, not
    // from whether the window has the OS focus, and it is what a reviewer needs
    // to read a gap in the timeline. See openspec findings-2.md, finding P-1.

    // Activity signals that reset the idle timer
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.recordActivity('navigate');
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => {
        this.recordActivity('edit');
      }),
    );
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.recordActivity('navigate');
      }),
    );

    // Start idle timer
    this.resetIdleTimer();

    this.disposables.push({
      dispose: () => {
        if (this.idleTimer) clearTimeout(this.idleTimer);
      },
    });
  }

  private recordActivity(action: string): void {
    this.lastAction = action;
    const now = Date.now();

    if (this.isIdle) {
      const idleDurationMs = this.idleStartedAt ? now - this.idleStartedAt : 0;
      this.isIdle = false;
      this.idleStartedAt = 0;
      this.transport.enqueue(
        this.factory.create('editor_idle', {
          subKind: 'idle_end',
          idleDurationMs,
          lastActiveFile: this.getActiveFilePath(),
          lastAction: this.lastAction,
        }),
      );
    }

    this.lastActivityAt = now;
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);

    this.idleTimer = setTimeout(() => {
      this.isIdle = true;
      this.idleStartedAt = Date.now();
      this.transport.enqueue(
        this.factory.create('editor_idle', {
          subKind: 'idle_start',
          lastActiveFile: this.getActiveFilePath(),
          lastAction: this.lastAction,
        }),
      );
    }, IDLE_THRESHOLD_MS);
  }

  private getActiveFilePath(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    return sanitizePath(editor.document.uri.fsPath);
  }
}
