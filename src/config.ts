import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { PromptsterConfig } from './types';
import { log } from './utils/logger';

/**
 * Reads Promptster config from `.promptster/config.json` in the workspace root.
 * This file is auto-created by the CLI `promptster start` command.
 */
export function readConfig(): PromptsterConfig | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  const configPath = path.join(folders[0].uri.fsPath, '.promptster', 'config.json');

  try {
    if (!fs.existsSync(configPath)) {
      log(`No config found at ${configPath}`);
      return null;
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    const apiUrl = parsed.apiUrl || parsed.api_url;
    const apiKey = parsed.apiKey || parsed.api_key;
    const sessionId = parsed.sessionId || parsed.session_id;

    if (!apiUrl || !apiKey || !sessionId) {
      log(`Config at ${configPath} missing required fields (apiUrl, apiKey, sessionId)`);
      return null;
    }

    log(`Config loaded: apiUrl=${apiUrl}, sessionId=${sessionId}`);
    return { apiUrl, apiKey, sessionId };
  } catch (err) {
    log(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Watch for changes to the config file and invoke callback when it appears/changes.
 */
export function watchConfig(callback: (config: PromptsterConfig | null) => void): vscode.Disposable {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { dispose: () => {} };
  }

  const pattern = new vscode.RelativePattern(folders[0], '.promptster/config.json');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  const handler = () => callback(readConfig());
  watcher.onDidCreate(handler);
  watcher.onDidChange(handler);
  watcher.onDidDelete(() => callback(null));

  return watcher;
}
