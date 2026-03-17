import type { PromptsterEvent } from '../types';
import { log } from '../utils/logger';

const MAX_SIZE = 500;
const FORCE_FLUSH_AT = 400;

export class EventBuffer {
  private buffer: PromptsterEvent[] = [];
  private onForceFlush: (() => void) | undefined;

  setForceFlushCallback(cb: () => void): void {
    this.onForceFlush = cb;
  }

  push(event: PromptsterEvent): void {
    if (this.buffer.length >= MAX_SIZE) {
      log(`Buffer full (${MAX_SIZE}), dropping oldest event`);
      this.buffer.shift();
    }

    this.buffer.push(event);

    if (this.buffer.length >= FORCE_FLUSH_AT && this.onForceFlush) {
      this.onForceFlush();
    }
  }

  drain(): PromptsterEvent[] {
    const events = this.buffer;
    this.buffer = [];
    return events;
  }

  get size(): number {
    return this.buffer.length;
  }
}
