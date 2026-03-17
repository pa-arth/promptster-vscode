import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Promptster');
  }
  return channel;
}

export function log(msg: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const suffix = err instanceof Error ? `: ${err.message}` : '';
  log(`ERROR ${msg}${suffix}`);
}
