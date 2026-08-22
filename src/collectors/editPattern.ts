import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';

const BURST_SILENCE_MS = 2000;

/**
 * Tracks typing bursts, paste events, and undo/redo.
 * Keystrokes are aggregated into bursts — individual characters are never sent.
 */
export class EditPatternCollector extends BaseCollector {
  // Typing burst state
  private burstFile: string | null = null;
  private burstStartTime = 0;
  private burstCharCount = 0;
  private burstStartLine = Infinity;
  private burstEndLine = 0;
  private burstKeystrokeTimestamps: number[] = [];
  private burstTimer: ReturnType<typeof setTimeout> | undefined;

  activate(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;

        const filePath = sanitizePath(e.document.uri.fsPath);
        if (!filePath) return;

        for (const change of e.contentChanges) {
          const isLargeInsert = change.text.length > 1 && change.text.includes('\n');
          const isReplace = change.rangeLength > 0 && change.text.length > 0;

          // Heuristic: paste = multi-line insert or large single insert (>50 chars)
          if (change.text.length > 50 || (isLargeInsert && !isReplace)) {
            this.flushBurst();
            this.emitPaste(filePath, change);
            continue;
          }

          // Heuristic: undo/redo — deletion with no new text, or replacement
          // VSCode doesn't expose undo/redo events directly.
          // We detect them as changes where rangeLength > 0 and text is empty (deletion)
          // Undo detection is imperfect — we skip it for now and add in Phase 2
          // when we can intercept the undo/redo commands.

          // Normal typing — aggregate into burst
          this.addToBurst(filePath, change);
        }
      }),
    );

    this.disposables.push({ dispose: () => this.flushBurst() });
  }

  private addToBurst(filePath: string, change: vscode.TextDocumentContentChangeEvent): void {
    const now = Date.now();

    // If file changed, flush old burst
    if (this.burstFile && this.burstFile !== filePath) {
      this.flushBurst();
    }

    if (!this.burstFile) {
      this.burstFile = filePath;
      this.burstStartTime = now;
      this.burstStartLine = change.range.start.line;
      this.burstEndLine = change.range.end.line;
      this.burstCharCount = 0;
      this.burstKeystrokeTimestamps = [];
    }

    this.burstCharCount += change.text.length;
    this.burstStartLine = Math.min(this.burstStartLine, change.range.start.line);
    this.burstEndLine = Math.max(this.burstEndLine, change.range.end.line);
    this.burstKeystrokeTimestamps.push(now);

    // Reset the silence timer
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => this.flushBurst(), BURST_SILENCE_MS);
  }

  private flushBurst(): void {
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = undefined;
    }

    if (!this.burstFile || this.burstCharCount === 0) {
      this.resetBurst();
      return;
    }

    const now = Date.now();
    const burstDurationMs = now - this.burstStartTime;

    const payload: Record<string, unknown> = {
      subKind: 'typing_burst',
      filePath: this.burstFile,
      burstDurationMs,
      charCount: this.burstCharCount,
      lineRange: { start: this.burstStartLine, end: this.burstEndLine },
    };

    // Average inter-keystroke interval is keystroke-cadence timing. The
    // canonical consent disclosure covers timing signals ONLY under the cadence
    // opt-in ("Timing between prompts and commands (only if you enable cadence
    // checks)"), so it ships only when the session recorded that opt-in. The
    // burst itself — how much was typed, over how long, where — is covered by
    // "Code changes and file edits in the assessment workspace" and always
    // ships. See openspec findings-2.md, finding P-2.
    if (this.options.captureKeystrokeCadence && this.burstKeystrokeTimestamps.length > 1) {
      const intervals: number[] = [];
      for (let i = 1; i < this.burstKeystrokeTimestamps.length; i++) {
        intervals.push(this.burstKeystrokeTimestamps[i] - this.burstKeystrokeTimestamps[i - 1]);
      }
      payload.avgInterKeystrokeMs = Math.round(
        intervals.reduce((a, b) => a + b, 0) / intervals.length,
      );
    }

    this.transport.enqueue(this.factory.create('editor_edit', payload));

    this.resetBurst();
  }

  private resetBurst(): void {
    this.burstFile = null;
    this.burstStartTime = 0;
    this.burstCharCount = 0;
    this.burstStartLine = Infinity;
    this.burstEndLine = 0;
    this.burstKeystrokeTimestamps = [];
  }

  private emitPaste(filePath: string, change: vscode.TextDocumentContentChangeEvent): void {
    const lineCount = change.text.split('\n').length;

    this.transport.enqueue(
      this.factory.create('editor_edit', {
        subKind: 'paste',
        filePath,
        charCount: change.text.length,
        lineCount,
      }),
    );
  }
}
