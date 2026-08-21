import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { redactCommand } from '../utils/commandRedactor';

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
            const redacted = redactCommand(cmd);

            this.transport.enqueue(
              this.factory.create('command', {
                // `command` is the canonical strict-schema field; we send the
                // redacted display form so it stays useful without leaking secrets.
                command: redacted.display,
                program: redacted.program,
                subcommand: redacted.subcommand,
                tokenCount: redacted.tokenCount,
                hasFlags: redacted.hasFlags,
                hadPotentialSecret: redacted.hadPotentialSecret,
                exitCode: e.exitCode,
                durationMs,
              }),
            );
          },
        ),
      );
    }

  }
}
