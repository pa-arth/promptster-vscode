import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';
import { debounce } from '../events/debounce';

/**
 * Tracks file opens/closes, dwell time per file, and scroll depth.
 */
export class FileReadingCollector extends BaseCollector {
  /** Tracks when the current file was focused. */
  private currentFile: string | null = null;
  private currentFileOpenedAt: number = 0;

  activate(): void {
    // File open — fires when a text editor becomes visible
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.emitDwellAndSwitch(editor);
      }),
    );

    // Tab close
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const filePath = sanitizePath(doc.uri.fsPath);
        if (!filePath) return;

        const payload: Record<string, unknown> = {
          subKind: 'file_close',
          filePath,
        };

        if (filePath === this.currentFile && this.currentFileOpenedAt) {
          payload.dwellMs = Date.now() - this.currentFileOpenedAt;
          this.currentFile = null;
          this.currentFileOpenedAt = 0;
        }

        this.transport.enqueue(this.factory.create('editor_focus', payload));
      }),
    );

    // Scroll depth — debounced
    const emitScrollDepth = debounce((_editor: vscode.TextEditor, visibleRanges: readonly vscode.Range[]) => {
      const filePath = sanitizePath(_editor.document.uri.fsPath);
      if (!filePath || visibleRanges.length === 0) return;

      const totalLines = _editor.document.lineCount;
      const maxVisibleLine = Math.max(...visibleRanges.map((r) => r.end.line));
      const scrollDepthPct = totalLines > 0 ? Math.round((maxVisibleLine / totalLines) * 100) : 0;

      this.transport.enqueue(
        this.factory.create('editor_focus', {
          subKind: 'scroll_depth',
          filePath,
          maxVisibleLineReached: maxVisibleLine,
          totalLines,
          scrollDepthPct,
        }),
      );
    }, 1000);

    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        emitScrollDepth(e.textEditor, e.visibleRanges);
      }),
    );
    this.disposables.push({ dispose: () => emitScrollDepth.cancel() });
  }

  private emitDwellAndSwitch(editor: vscode.TextEditor | undefined): void {
    const now = Date.now();

    if (!editor) {
      this.currentFile = null;
      this.currentFileOpenedAt = 0;
      return;
    }

    const filePath = sanitizePath(editor.document.uri.fsPath);
    if (!filePath) {
      this.currentFile = null;
      this.currentFileOpenedAt = 0;
      return;
    }

    const fromFile = this.currentFile;
    const fromDwellMs = this.currentFileOpenedAt ? now - this.currentFileOpenedAt : 0;

    // If switching between files, emit tab_switch
    if (fromFile && fromFile !== filePath) {
      this.transport.enqueue(
        this.factory.create('editor_focus', {
          subKind: 'tab_switch',
          fromFile,
          toFile: filePath,
          fromDwellMs,
        }),
      );
    }

    // Emit file_open if this file hasn't been opened before in this session.
    // `openedFiles` is seeded from persisted state and survives an editor
    // reload, so `isNewFile` stays truthful across a reattach.
    const isNew = !this.options.openedFiles.has(filePath);
    if (isNew) {
      this.options.openedFiles.add(filePath);
      this.options.onFileOpened(filePath);
    }

    // Reattach suppression. When the editor reloads, VSCode restores the open
    // editors and re-fires onDidChangeActiveTextEditor for them. Emitting
    // file_open there manufactures attention that did not occur, and every
    // derived measure over these events is a count. Inside the reattach window,
    // a file we have already recorded is a restoration, not a visit.
    const isReattachRestore =
      !isNew && now - this.options.bootedAt < this.options.reattachWindowMs;

    if (!isReattachRestore) {
      this.transport.enqueue(
        this.factory.create('editor_focus', {
          subKind: 'file_open',
          filePath,
          fileExtension: filePath.includes('.') ? '.' + filePath.split('.').pop() : '',
          languageId: editor.document.languageId,
          lineCount: editor.document.lineCount,
          isNewFile: isNew,
        }),
      );
    }

    this.currentFile = filePath;
    this.currentFileOpenedAt = now;
  }
}
