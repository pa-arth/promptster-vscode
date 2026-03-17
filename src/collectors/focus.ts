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
  private lastAction: string = 'unknown';

  activate(): void {
    // Window focus/blur
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        const activeFile = this.getActiveFilePath();

        if (state.focused) {
          this.transport.enqueue(
            this.factory.create('editor_focus', {
              subKind: 'editor_gain',
              lastActiveFile: activeFile,
            }),
          );
          this.resetIdleTimer();
        } else {
          this.transport.enqueue(
            this.factory.create('editor_focus', {
              subKind: 'editor_blur',
              lastActiveFile: activeFile,
            }),
          );
        }
      }),
    );

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
    this.lastActivityAt = Date.now();

    if (this.isIdle) {
      this.isIdle = false;
      const idleDurationMs = Date.now() - this.lastActivityAt;
      this.transport.enqueue(
        this.factory.create('editor_idle', {
          subKind: 'idle_end',
          idleDurationMs,
          lastActiveFile: this.getActiveFilePath(),
          lastAction: this.lastAction,
        }),
      );
    }

    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);

    this.idleTimer = setTimeout(() => {
      this.isIdle = true;
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
