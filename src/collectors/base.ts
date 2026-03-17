import * as vscode from 'vscode';
import type { EventFactory } from '../events/factory';
import type { TransportLayer } from '../transport';

export abstract class BaseCollector implements vscode.Disposable {
  protected disposables: vscode.Disposable[] = [];

  constructor(
    protected readonly factory: EventFactory,
    protected readonly transport: TransportLayer,
  ) {}

  abstract activate(): void;

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
