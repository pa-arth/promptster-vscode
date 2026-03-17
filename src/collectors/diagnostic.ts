import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sanitizePath } from '../utils/pathSanitizer';

/**
 * Tracks interaction with diagnostics: hovering on errors and applying quick fixes.
 * We observe code action executions and diagnostic changes to infer behavior.
 */
export class DiagnosticCollector extends BaseCollector {
  private diagnosticCounts = new Map<string, number>();

  activate(): void {
    // Track diagnostic changes per file — when diagnostics appear/disappear
    // we can infer the candidate is working on fixing errors
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        for (const uri of e.uris) {
          if (uri.scheme !== 'file') continue;

          const filePath = sanitizePath(uri.fsPath);
          if (!filePath) continue;

          const diagnostics = vscode.languages.getDiagnostics(uri);
          const errorCount = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
          const warningCount = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;

          const prevCount = this.diagnosticCounts.get(filePath) ?? 0;
          const currentCount = errorCount + warningCount;
          this.diagnosticCounts.set(filePath, currentCount);

          // Only emit when diagnostics are resolved (count decreases) —
          // indicates the candidate fixed something
          if (currentCount < prevCount) {
            this.transport.enqueue(
              this.factory.create('editor_edit', {
                subKind: 'quick_fix',
                filePath,
                diagnosticsResolved: prevCount - currentCount,
                remainingErrors: errorCount,
                remainingWarnings: warningCount,
              }),
            );
          }
        }
      }),
    );
  }
}
