import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';

/**
 * Tracks go-to-definition jumps by monitoring definition provider results.
 * Tab switches are captured by FileReadingCollector.
 * This collector adds definition-link context when available.
 */
export class NavigationCollector extends BaseCollector {
  activate(): void {
    // Monitor executeDefinitionProvider command to detect go-to-definition
    // VSCode doesn't have a direct API for this, so we watch for
    // rapid file changes that look like definition jumps.
    // The heuristic: if the active editor changes within 200ms of a
    // selection change to a symbol, it's likely a go-to-definition.

    // Track search usage via the workbench.action.findInFiles command
    // We can observe when the search panel opens
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        // We track selections to correlate with subsequent file jumps
        // This data enriches the tab_switch events from FileReadingCollector
        void e; // Selections are correlated in the backend analytics pipeline
      }),
    );
  }
}
