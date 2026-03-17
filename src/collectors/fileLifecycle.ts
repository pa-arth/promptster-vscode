import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';

/**
 * Tracks file creation, deletion, and rename within the workspace.
 */
export class FileLifecycleCollector extends BaseCollector {
  activate(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folders[0], '**/*'),
    );

    this.disposables.push(watcher);

    watcher.onDidCreate((uri) => {
      if (uri.scheme !== 'file') return;
      const filePath = sanitizePath(uri.fsPath);
      if (!filePath) return;

      this.transport.enqueue(
        this.factory.create('file_create', {
          path: filePath,
        }),
      );
    });

    watcher.onDidDelete((uri) => {
      if (uri.scheme !== 'file') return;
      const filePath = sanitizePath(uri.fsPath);
      if (!filePath) return;

      this.transport.enqueue(
        this.factory.create('file_delete', {
          path: filePath,
        }),
      );
    });
  }
}
