import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';
import type { EventAttribution } from '../events/factory';

const WATCHER_OBSERVATION: EventAttribution = {
  actor: { type: 'system', role: 'file-watcher' },
  provenance: {
    attribution: 'unknown',
    confidence: 1.0,
    observability: 'high',
    methods: ['ide-extension', 'fs-watcher'],
  },
};

/**
 * Tracks file creation, deletion, and rename within the workspace.
 *
 * A filesystem watcher sees that a file appeared, not who made it, and in an
 * assessment the agent makes most of them (its Write tool replaces files
 * atomically, which fires a create). These events are therefore stamped as a
 * system observation, never as the candidate — the candidate's authorship is
 * what the edit collector records.
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
        this.factory.create('file_create', { path: filePath }, WATCHER_OBSERVATION),
      );
    });

    watcher.onDidDelete((uri) => {
      if (uri.scheme !== 'file') return;
      const filePath = sanitizePath(uri.fsPath);
      if (!filePath) return;

      this.transport.enqueue(
        this.factory.create('file_delete', { path: filePath }, WATCHER_OBSERVATION),
      );
    });
  }
}
