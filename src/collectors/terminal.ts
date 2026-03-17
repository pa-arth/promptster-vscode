import * as vscode from 'vscode';
import { BaseCollector } from './base';

/**
 * Tracks terminal command execution in the integrated terminal.
 *
 * Uses the VSCode `window.onDidStartTerminalShellExecution` and
 * `window.onDidEndTerminalShellExecution` APIs (available in VSCode 1.93+).
 * Falls back to tracking terminal open/close on older versions.
 */
export class TerminalCollector extends BaseCollector {
  private commandStartTimes = new Map<string, number>();

  activate(): void {
    // Shell execution API (VSCode 1.93+)
    if ('onDidStartTerminalShellExecution' in vscode.window) {
      this.disposables.push(
        (vscode.window as any).onDidStartTerminalShellExecution(
          (e: { terminal: vscode.Terminal; execution: { commandLine: { value: string } } }) => {
            const cmd = e.execution.commandLine.value;
            this.commandStartTimes.set(cmd, Date.now());
          },
        ),
      );

      this.disposables.push(
        (vscode.window as any).onDidEndTerminalShellExecution(
          (e: { terminal: vscode.Terminal; execution: { commandLine: { value: string } }; exitCode: number | undefined }) => {
            const cmd = e.execution.commandLine.value;
            const startTime = this.commandStartTimes.get(cmd);
            this.commandStartTimes.delete(cmd);

            const durationMs = startTime ? Date.now() - startTime : undefined;

            this.transport.enqueue(
              this.factory.create('command', {
                command: cmd,
                exitCode: e.exitCode,
                durationMs,
                _sourceExtension: true,
              }),
            );
          },
        ),
      );
    }

    // Always track terminal open/close as a lightweight signal
    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => {
        this.transport.enqueue(
          this.factory.create('editor_focus', {
            subKind: 'terminal_open',
          }),
        );
      }),
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal(() => {
        this.transport.enqueue(
          this.factory.create('editor_focus', {
            subKind: 'terminal_close',
          }),
        );
      }),
    );
  }
}
