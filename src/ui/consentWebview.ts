import * as vscode from 'vscode';

export function showConsentDetails(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    'promptsterConsent',
    'Promptster — Captured Signals',
    vscode.ViewColumn.One,
    { enableScripts: false },
  );

  panel.webview.html = getConsentHtml();
}

function getConsentHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Promptster — What We Capture</title>
  <style>
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
      line-height: 1.6;
    }
    h1 { font-size: 1.5em; margin-bottom: 8px; }
    h2 { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; color: var(--vscode-textLink-foreground); }
    .signal {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .signal strong { display: block; margin-bottom: 4px; }
    .signal em { opacity: 0.7; font-size: 0.9em; }
    .not-captured {
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .not-captured strong { display: block; margin-bottom: 4px; }
  </style>
</head>
<body>
  <h1>Promptster Assessment — Captured Signals</h1>
  <p>This extension captures metadata about your development process for assessment evaluation. Here's exactly what is and isn't captured:</p>

  <h2>What IS captured</h2>

  <div class="signal">
    <strong>File navigation</strong>
    <em>Which files you open and how long you view them. File paths (relative to workspace), language, line count.</em>
  </div>

  <div class="signal">
    <strong>Scroll depth</strong>
    <em>How far you scroll through a file (as a percentage). Not which specific lines you read.</em>
  </div>

  <div class="signal">
    <strong>Edit patterns</strong>
    <em>Typing speed (characters per burst), paste frequency (character/line counts only), undo/redo usage.</em>
  </div>

  <div class="signal">
    <strong>Focus &amp; attention</strong>
    <em>When the editor is focused/blurred, idle periods (after 60s of no activity).</em>
  </div>

  <div class="signal">
    <strong>Diagnostics</strong>
    <em>When you resolve errors/warnings (count only). Not the error messages themselves.</em>
  </div>

  <div class="signal">
    <strong>Terminal commands</strong>
    <em>Commands you run in the integrated terminal and their exit codes. Not command output.</em>
  </div>

  <div class="signal">
    <strong>File lifecycle</strong>
    <em>When files are created or deleted in the workspace. File path only.</em>
  </div>

  <h2>What is NOT captured</h2>

  <div class="not-captured">
    <strong>Never captured:</strong>
    <em>File contents, source code, diffs, clipboard text, terminal output, AI prompt text, diagnostic messages, URLs, screenshots, or anything outside your workspace.</em>
  </div>

</body>
</html>`;
}
