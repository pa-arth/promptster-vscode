import * as vscode from 'vscode';
import type { PromptsterEvent } from '../types';
import { log } from '../utils/logger';

const STORAGE_KEY = 'promptster.offlineQueue';
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour TTL

export class OfflineQueue {
  constructor(private readonly globalState: vscode.Memento) {}

  /** Persist events that failed to send. */
  async enqueue(events: PromptsterEvent[]): Promise<void> {
    const existing = this.read();
    const combined = [...existing, ...events];
    // Cap at 200 to avoid unbounded storage growth
    const capped = combined.slice(-200);
    await this.globalState.update(STORAGE_KEY, capped);
    log(`Offline queue: ${capped.length} events persisted`);
  }

  /** Drain all non-expired events from the queue. */
  async drain(): Promise<PromptsterEvent[]> {
    const events = this.read();
    if (events.length === 0) return [];

    const now = Date.now();
    const fresh = events.filter((e) => {
      const eventTime = new Date(e.ts).getTime();
      return now - eventTime < MAX_AGE_MS;
    });

    await this.globalState.update(STORAGE_KEY, []);
    log(`Offline queue drained: ${fresh.length} fresh, ${events.length - fresh.length} expired`);
    return fresh;
  }

  get size(): number {
    return this.read().length;
  }

  private read(): PromptsterEvent[] {
    return this.globalState.get<PromptsterEvent[]>(STORAGE_KEY, []);
  }
}
