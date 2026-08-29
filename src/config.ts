import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { PromptsterSession } from './types';
import { log } from './utils/logger';

/**
 * Session state files, in read order, relative to the workspace root.
 *
 * `session.json` is what `promptster start` actually writes (promptster-cli
 * cmd_start.go, via stateDir()). `config.json` is read second and is a
 * compatibility path only: nothing in the CLI has ever written it, so an
 * extension that waited for it waited forever. See openspec findings-2.md,
 * finding S-1.
 */
const SESSION_FILES = ['.promptster/session.json', '.promptster/config.json'];

function workspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

/**
 * Read the assessment session from the workspace.
 *
 * Everything the extension needs comes from here: the session's API URL (there
 * is no build-time default and no setting — an extension pointed at the wrong
 * backend is worse than one that does nothing), the candidate key, the session
 * id, and the consent the candidate gave the CLI.
 *
 * Returns null when there is no usable session. Callers must not capture.
 */
export function readSession(): PromptsterSession | null {
  const root = workspaceRoot();
  if (!root) return null;

  for (const relative of SESSION_FILES) {
    const full = path.join(root, relative);
    let parsed: Record<string, unknown>;
    try {
      if (!fs.existsSync(full)) continue;
      parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      log(`Failed to read ${relative}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const session = fromJson(parsed, relative);
    if (session) return session;
    log(`${relative} is missing apiUrl, key or sessionId — not usable`);
  }

  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tools(value: unknown): Array<'claude' | 'codex'> {
  if (!Array.isArray(value)) return [];
  return value.filter((tool): tool is 'claude' | 'codex' => tool === 'claude' || tool === 'codex');
}

/**
 * Map a session file onto the shape the extension needs.
 *
 * The CLI's Session struct uses `key` for the candidate API key; the
 * compatibility `config.json` shape used `apiKey`/`api_key`. Accept all of
 * them — the cost of an extra alternative here is one `??`, and the cost of
 * missing one is a session that captures nothing and says nothing.
 */
export function fromJson(
  raw: Record<string, unknown>,
  sourceFile: string,
): PromptsterSession | null {
  const apiUrl = str(raw.apiUrl) ?? str(raw.api_url);
  // Hosted ARM writes the redeemed candidate credential as `sessionToken`.
  // Keep the older names for CLI/backward compatibility, but do not require a
  // duplicate `key` field merely so the editor can recognize the same session.
  const apiKey =
    str(raw.sessionToken) ?? str(raw.key) ?? str(raw.apiKey) ?? str(raw.api_key);
  const sessionId = str(raw.sessionId) ?? str(raw.session_id);

  if (!apiUrl || !apiKey || !sessionId) return null;

  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiKey,
    sessionId,
    // Absent means absent. A session file that does not record consent is not a
    // session that consented, and the extension does not ask on its behalf.
    consentAccepted: raw.consentAccepted === true,
    consentToIntegrity: raw.consentToIntegrity === true,
    expiresAt: str(raw.expiresAt),
    tools: tools(raw.tools),
    hosted: raw.noSelfEvict === true,
    sourceFile,
  };
}

/** True once the candidate key has aged out. Capture must stop. */
export function isExpired(session: PromptsterSession, now = Date.now()): boolean {
  if (!session.expiresAt) return false;
  const expiry = new Date(session.expiresAt).getTime();
  // An unparseable or zero-value expiry is not an expiry — the Go zero time
  // marshals as 0001-01-01T00:00:00Z, which would otherwise expire everything.
  if (!Number.isFinite(expiry) || expiry <= 0) return false;
  if (new Date(session.expiresAt).getUTCFullYear() < 2000) return false;
  return expiry <= now;
}

/**
 * Watch every candidate session file for appearing, changing or being removed.
 *
 * The CLI rewrites `session.json` several times during a session (tool
 * selection, key migration, honeypot). Callers must therefore treat this as
 * "the session state may have changed", never as "a new session started" —
 * see extension.ts, which compares against the running session before acting.
 */
export function watchSession(
  callback: (session: PromptsterSession | null) => void,
): vscode.Disposable {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { dispose: () => {} };
  }

  const watchers = SESSION_FILES.map((relative) => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folders[0], relative),
    );
    const handler = () => callback(readSession());
    watcher.onDidCreate(handler);
    watcher.onDidChange(handler);
    watcher.onDidDelete(handler);
    return watcher;
  });

  return {
    dispose: () => {
      for (const w of watchers) w.dispose();
    },
  };
}
