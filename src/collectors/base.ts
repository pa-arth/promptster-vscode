import * as vscode from 'vscode';
import type { EventFactory } from '../events/factory';
import type { TransportLayer } from '../transport';

/**
 * Cross-collector capture settings, derived from the session.
 */
export interface CaptureOptions {
  /**
   * Files already reported as opened in this session. Survives an editor
   * reload, so a reattach does not re-report files already recorded.
   */
  openedFiles: Set<string>;
  /** Called when a file is reported for the first time, so it can be persisted. */
  onFileOpened: (filePath: string) => void;
  /** ms after activation during which a repeat `file_open` is a reattach artifact. */
  reattachWindowMs: number;
  /** Date.now() at activation. */
  bootedAt: number;
  /**
   * The candidate opted in to cadence-based integrity checks. Only then may
   * keystroke-interval timing be emitted — the canonical disclosure covers it
   * under that opt-in and nowhere else.
   */
  captureKeystrokeCadence: boolean;
}

export function defaultCaptureOptions(): CaptureOptions {
  return {
    openedFiles: new Set(),
    onFileOpened: () => {},
    reattachWindowMs: 5_000,
    bootedAt: Date.now(),
    captureKeystrokeCadence: false,
  };
}

export abstract class BaseCollector implements vscode.Disposable {
  protected disposables: vscode.Disposable[] = [];

  constructor(
    protected readonly factory: EventFactory,
    protected readonly transport: TransportLayer,
    protected readonly options: CaptureOptions = defaultCaptureOptions(),
  ) {}

  abstract activate(): void;

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
