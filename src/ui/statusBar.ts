import * as vscode from 'vscode';

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'promptster.viewDetails';
  }

  showDormant(): void {
    this.item.text = '$(circle-slash) Promptster: Not configured';
    this.item.tooltip = 'No .promptster/config.json found in workspace';
    this.item.show();
  }

  showCapturing(): void {
    this.item.text = '$(eye) Promptster: Capturing';
    this.item.tooltip = 'Click to view captured signals';
    this.item.color = undefined;
    this.item.show();
  }

  showPaused(): void {
    this.item.text = '$(eye-closed) Promptster: Paused';
    this.item.tooltip = 'Capture is paused — run "Promptster: Resume Capture"';
    this.item.show();
  }

  showError(msg: string): void {
    this.item.text = '$(warning) Promptster: Error';
    this.item.tooltip = msg;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
