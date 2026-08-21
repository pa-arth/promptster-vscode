import * as vscode from 'vscode';
import { showConsentDetails } from './consentWebview';

export type PauseCallback = () => void | Promise<void>;
export type ResumeCallback = () => void;

export function registerCommands(
  context: vscode.ExtensionContext,
  callbacks: {
    onPause: PauseCallback;
    onResume: ResumeCallback;
    onConfigure: () => void;
  },
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('promptster.viewDetails', () => {
      showConsentDetails(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptster.pause', async () => {
      await callbacks.onPause();
      vscode.window.showInformationMessage('Promptster capture paused.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptster.resume', () => {
      callbacks.onResume();
      vscode.window.showInformationMessage('Promptster capture resumed.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptster.configure', () => {
      callbacks.onConfigure();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptster.showStatus', () => {
      showConsentDetails(context);
    }),
  );
}
