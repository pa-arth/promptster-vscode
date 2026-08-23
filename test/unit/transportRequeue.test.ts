import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('vscode', () => import('../fakes/vscode'));

import { FakeMemento } from '../fakes/vscode';
import { HttpSender } from '../../src/transport/httpSender';
import { TransportLayer } from '../../src/transport';
import type { PromptsterEvent } from '../../src/types';

/**
 * Requeue attribution.
 *
 * Sends run three-at-a-time and complete out of order, so "how many landed"
 * cannot tell you "which ones landed". The transport used to requeue
 * `allEvents.slice(sent)` — an arbitrary suffix — which re-sent events already
 * delivered and dropped the ones that had actually failed. A re-sent event is
 * not free: `timeline_events` inserts with a fresh id and has no unique
 * constraint on the source event, so the duplicate becomes a second row and the
 * replay's attention counts and dwell totals come out wrong.
 */

const OFFLINE_KEY = 'promptster.offlineQueue';

const config = {
  apiUrl: 'https://api.assessment.example',
  apiKey: 'PST-test-key',
  sessionId: 'sess_test',
};

function makeEvent(id: string): PromptsterEvent {
  return {
    id,
    sessionId: 'sess_test',
    ts: new Date().toISOString(),
    source: { channel: 'ide-extension', integration: 'vscode', emitter: 'promptster-vscode' },
    actor: { type: 'human', role: 'candidate' },
    provenance: { attribution: 'likely_human', confidence: 1, observability: 'high', methods: ['ide-extension'] },
    v: 1,
    kind: 'editor_focus',
    data: { subKind: 'file_open', filePath: `src/${id}.ts` },
  } as unknown as PromptsterEvent;
}

/** Fail exactly the named event ids; everything else succeeds. */
function stubFetchFailing(failIds: string[]): { attempts: string[] } {
  const attempts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const event = JSON.parse(init.body) as PromptsterEvent;
      attempts.push(event.id);
      if (failIds.includes(event.id)) return { ok: false, status: 429 } as Response;
      return { ok: true, status: 200 } as Response;
    }),
  );
  return { attempts };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HttpSender.sendBatch', () => {
  it('returns the events that failed, not a suffix of the batch', async () => {
    stubFetchFailing(['e2']);
    const sender = new HttpSender(config);

    const failed = await sender.sendBatch(['e1', 'e2', 'e3', 'e4'].map(makeEvent));

    expect(failed.map((e) => e.id)).toEqual(['e2']);
  });

  it('returns every event when nothing lands', async () => {
    stubFetchFailing(['e1', 'e2', 'e3']);
    const sender = new HttpSender(config);

    const failed = await sender.sendBatch(['e1', 'e2', 'e3'].map(makeEvent));

    expect(failed.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('returns nothing when the whole batch lands', async () => {
    stubFetchFailing([]);
    const sender = new HttpSender(config);

    const failed = await sender.sendBatch(['e1', 'e2'].map(makeEvent));

    expect(failed).toEqual([]);
  });

  it('treats a thrown request as a failure of that event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const event = JSON.parse(init.body) as PromptsterEvent;
        if (event.id === 'e2') throw new Error('socket hang up');
        return { ok: true, status: 200 } as Response;
      }),
    );

    const failed = await new HttpSender(config).sendBatch(['e1', 'e2', 'e3'].map(makeEvent));

    expect(failed.map((e) => e.id)).toEqual(['e2']);
  });

  it('returns failures in the order they were given, not completion order', async () => {
    stubFetchFailing(['e1', 'e3']);
    const sender = new HttpSender(config);

    const failed = await sender.sendBatch(['e1', 'e2', 'e3', 'e4'].map(makeEvent));

    expect(failed.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('holds MAX_CONCURRENT across concurrent callers, not per call', async () => {
    // The cap is why this class exists in its current shape: ingest is 100
    // req/min per API key and this sender spends one request per event. A cap
    // that reset per invocation would stop being a cap the moment a second
    // caller appeared.
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { ok: true, status: 200 } as Response;
      }),
    );

    const sender = new HttpSender(config);
    await Promise.all([
      sender.sendBatch(['a1', 'a2', 'a3', 'a4', 'a5'].map(makeEvent)),
      sender.sendBatch(['b1', 'b2', 'b3', 'b4', 'b5'].map(makeEvent)),
    ]);

    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('TransportLayer flush', () => {
  it('requeues only the failed event, and never one already delivered', async () => {
    stubFetchFailing(['e2']);
    const memento = new FakeMemento();
    const transport = new TransportLayer(config, memento as never);

    for (const id of ['e1', 'e2', 'e3', 'e4']) transport.enqueue(makeEvent(id));
    await transport.stop(); // stop() performs a final flush

    const queued = memento.get<PromptsterEvent[]>(OFFLINE_KEY, []) ?? [];
    expect(queued.map((e) => e.id)).toEqual(['e2']);
  });

  it('retries only what failed, so a delivered event is never sent twice', async () => {
    const { attempts } = stubFetchFailing(['e2']);
    const memento = new FakeMemento();
    const transport = new TransportLayer(config, memento as never);

    for (const id of ['e1', 'e2', 'e3', 'e4']) transport.enqueue(makeEvent(id));
    await transport.stop();

    // Second pass: the endpoint recovers. Only the failed event should go again.
    stubFetchFailing([]);
    const retry = new TransportLayer(config, memento as never);
    await retry.stop();

    expect(attempts.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    const queued = memento.get<PromptsterEvent[]>(OFFLINE_KEY, []) ?? [];
    expect(queued).toEqual([]);
  });

  it('leaves the queue empty when everything lands', async () => {
    stubFetchFailing([]);
    const memento = new FakeMemento();
    const transport = new TransportLayer(config, memento as never);

    transport.enqueue(makeEvent('e1'));
    await transport.stop();

    expect(memento.get<PromptsterEvent[]>(OFFLINE_KEY, []) ?? []).toEqual([]);
  });
});
