import * as vscode from 'vscode';
import type { Integration } from '../types';

/**
 * Detect whether we're running inside Cursor or vanilla VSCode.
 * Cursor sets `appName` to "Cursor" and uses a different `appRoot`.
 */
export function detectIntegration(): Integration {
  const appName = vscode.env.appName.toLowerCase();
  if (appName.includes('cursor')) {
    return 'cursor';
  }
  return 'vscode';
}
