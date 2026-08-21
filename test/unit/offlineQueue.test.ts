import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('vscode', () => ({}));

vi.mock('../../src/utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { OfflineQueue } from '../../src/transport/offlineQueue';
import type { PromptsterEvent } from '../../src/types';

class MemoryMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.store.get(key) as T) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }
}

function makeEvent(ageMs = 0): PromptsterEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    ts: new Date(Date.now() - ageMs).toISOString(),
    source: {
      channel: 'ide-extension',
      integration: 'vscode',
      emitter: 'promptster-vscode',
    },
    actor: { type: 'human', role: 'candidate' },
    provenance: {
      attribution: 'likely_human',
      confidence: 1,
      observability: 'high',
      methods: ['ide-extension'],
    },
    v: 1,
    kind: 'editor_focus',
    data: { subKind: 'file_open' },
  };
}

describe('OfflineQueue', () => {
  let memento: MemoryMemento;
  let queue: OfflineQueue;

  beforeEach(() => {
    memento = new MemoryMemento();
    queue = new OfflineQueue(memento as any);
  });

  describe('enqueue & drain', () => {
    it('persists enqueued events and returns them on drain', async () => {
      const events = [makeEvent(), makeEvent()];
      await queue.enqueue(events);
      expect(queue.size).toBe(2);

      const drained = await queue.drain();
      expect(drained).toHaveLength(2);
      expect(drained[0].id).toBe(events[0].id);
      expect(queue.size).toBe(0);
    });

    it('drain clears the queue', async () => {
      await queue.enqueue([makeEvent()]);
      await queue.drain();
      expect(queue.size).toBe(0);
      const second = await queue.drain();
      expect(second).toEqual([]);
    });

    it('appends across multiple enqueue calls', async () => {
      await queue.enqueue([makeEvent()]);
      await queue.enqueue([makeEvent(), makeEvent()]);
      expect(queue.size).toBe(3);
    });
  });

  describe('cap at 200', () => {
    it('keeps only most recent 200 when over cap', async () => {
      const batch = Array.from({ length: 250 }, () => makeEvent());
      await queue.enqueue(batch);
      expect(queue.size).toBe(200);

      const drained = await queue.drain();
      expect(drained).toHaveLength(200);
      // Should keep the last 200, dropping the first 50
      expect(drained[0].id).toBe(batch[50].id);
      expect(drained[199].id).toBe(batch[249].id);
    });

    it('caps across multiple enqueues', async () => {
      await queue.enqueue(Array.from({ length: 150 }, () => makeEvent()));
      await queue.enqueue(Array.from({ length: 100 }, () => makeEvent()));
      expect(queue.size).toBe(200);
    });
  });

  describe('1-hour TTL', () => {
    it('drops events older than 1 hour on drain', async () => {
      const fresh = makeEvent(60_000); // 1 minute old
      const expired = makeEvent(2 * 60 * 60 * 1000); // 2 hours old
      await queue.enqueue([fresh, expired]);

      const drained = await queue.drain();
      expect(drained).toHaveLength(1);
      expect(drained[0].id).toBe(fresh.id);
    });

    it('returns empty if all events are expired', async () => {
      await queue.enqueue([
        makeEvent(2 * 60 * 60 * 1000),
        makeEvent(3 * 60 * 60 * 1000),
      ]);
      const drained = await queue.drain();
      expect(drained).toEqual([]);
    });

    it('keeps event at exactly 59 minutes old', async () => {
      const event = makeEvent(59 * 60 * 1000);
      await queue.enqueue([event]);
      const drained = await queue.drain();
      expect(drained).toHaveLength(1);
    });
  });

  describe('persistence across instances', () => {
    it('events persisted by one instance are visible to another using same memento', async () => {
      const event = makeEvent();
      await queue.enqueue([event]);

      const queue2 = new OfflineQueue(memento as any);
      expect(queue2.size).toBe(1);
      const drained = await queue2.drain();
      expect(drained[0].id).toBe(event.id);
    });
  });
});
