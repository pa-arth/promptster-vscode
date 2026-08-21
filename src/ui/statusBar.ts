import * as vscode from 'vscode';

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'promptster.viewDetails';
  }

  /**
   * Not capturing, with the reason.
   *
   * "Not capturing" and "why" travel together on purpose: a candidate whose
   * session has no recorded consent must be able to see that the extension is
   * dormant, not silently assume it is recording them.
   */
  showNotCapturing(reason: string): void {
    this.item.text = '$(circle-slash) Promptster: Not capturing';
    this.item.tooltip = reason;
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
