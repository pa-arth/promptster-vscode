import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { NotCapturingReason } from './types';
import { detectIntegration } from './utils/editorDetector';
import { log } from './utils/logger';

/**
 * The extension's capture state, written to `.promptster/editor-capture.json`.
 *
 * `promptster doctor` has to be able to answer "is the extension installed, did
 * it activate, and is it capturing" without asking the candidate to read a
 * status bar. An installed-but-dormant extension is the failure mode that
 * matters — it produces a session with no attention events, which reads exactly
 * like a candidate who opened no files — so "present" is not a sufficient check.
 * The extension has to say so itself.
 *
 * Written into `.promptster/`, which the CLI already creates and gitignores, and
 * which `pathSanitizer` already refuses to report. This file is local
 * diagnostics; nothing here is sent anywhere.
 */
export interface EditorCaptureState {
  extensionVersion: string;
  /** 'vscode' | 'cursor' */
  editor: string;
  editorVersion: string;
  /** The session this state is about. Absent when there is no session. */
  sessionId?: string;
  capturing: boolean;
  /** Why not, when not capturing. */
  reason?: NotCapturingReason;
  /** ISO timestamp. Staleness is how doctor tells "activated" from "was, once". */
  updatedAt: string;
}

export const CAPTURE_STATE_FILE = '.promptster/editor-capture.json';

export function writeCaptureState(
  extensionVersion: string,
  state: { capturing: boolean; sessionId?: string; reason?: NotCapturingReason },
): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;

  const payload: EditorCaptureState = {
    extensionVersion,
    editor: detectIntegration(),
    editorVersion: vscode.version,
    sessionId: state.sessionId,
    capturing: state.capturing,
    reason: state.reason,
    updatedAt: new Date().toISOString(),
  };

  const target = path.join(folders[0].uri.fsPath, CAPTURE_STATE_FILE);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write-then-rename so `doctor` never reads a half-written file.
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // Diagnostics must never be able to break capture.
    log(`Could not write capture state: ${err instanceof Error ? err.message : String(err)}`);
  }
}
