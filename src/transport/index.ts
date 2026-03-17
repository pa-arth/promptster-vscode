import type { PromptsterConfig, PromptsterEvent } from '../types';
import { EventBuffer } from './eventBuffer';
import { HttpSender } from './httpSender';
import { OfflineQueue } from './offlineQueue';
import { log, logError } from '../utils/logger';
import * as vscode from 'vscode';

const FLUSH_INTERVAL_MS = 5_000;

export class TransportLayer {
  readonly buffer: EventBuffer;
  private readonly sender: HttpSender;
  private readonly offlineQueue: OfflineQueue;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  constructor(config: PromptsterConfig, globalState: vscode.Memento) {
    this.buffer = new EventBuffer();
    this.sender = new HttpSender(config);
    this.offlineQueue = new OfflineQueue(globalState);

    this.buffer.setForceFlushCallback(() => this.flush());
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    log('Transport started');
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Final flush on stop
    void this.flush();
    log('Transport stopped');
  }

  enqueue(event: PromptsterEvent): void {
    this.buffer.push(event);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      // Drain offline queue first
      const offlineEvents = await this.offlineQueue.drain();
      const bufferEvents = this.buffer.drain();
      const allEvents = [...offlineEvents, ...bufferEvents];

      if (allEvents.length === 0) return;

      log(`Flushing ${allEvents.length} events (${offlineEvents.length} from offline queue)`);

      const sent = await this.sender.sendBatch(allEvents);
      const failed = allEvents.length - sent;

      if (failed > 0) {
        // Put failed events into offline queue for retry
        const failedEvents = allEvents.slice(sent);
        await this.offlineQueue.enqueue(failedEvents);
        logError(`${failed} events moved to offline queue`);
      }
    } catch (err) {
      logError('Flush failed', err);
    } finally {
      this.flushing = false;
    }
  }
}
