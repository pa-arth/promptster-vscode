import * as vscode from 'vscode';
import * as path from 'path';

/** Patterns that should never be reported (relative to workspace root). */
const DEFAULT_IGNORE = [
  /^\.env/,
  /^\.promptster\//,
  /node_modules\//,
  /\.git\//,
  /credentials/i,
  /secret/i,
];

let customIgnore: RegExp[] = [];

export function loadIgnorePatterns(workspaceRoot: string): void {
  // Future: read .promptsterignore from workspaceRoot
  // For now, use defaults only
  customIgnore = [];
  void workspaceRoot;
}

/**
 * Convert an absolute file path to a workspace-relative path.
 * Returns `<external>` for files outside the workspace.
 * Returns `null` for paths matching ignore patterns.
 */
export function sanitizePath(absolutePath: string): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return '<external>';
  }

  const workspaceRoot = folders[0].uri.fsPath;
  const relative = path.relative(workspaceRoot, absolutePath);

  // Outside workspace
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return '<external>';
  }

  // Check ignore patterns
  const allPatterns = [...DEFAULT_IGNORE, ...customIgnore];
  for (const pattern of allPatterns) {
    if (pattern.test(relative)) {
      return null;
    }
  }

  return relative;
}
