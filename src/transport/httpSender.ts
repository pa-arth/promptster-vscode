import type { PromptsterConfig, PromptsterEvent } from '../types';
import { log, logError } from '../utils/logger';

const MAX_CONCURRENT = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export class HttpSender {
  /**
   * Requests in flight, counted on the INSTANCE and not per call.
   *
   * The cap exists because `/v1/hooks/ingest` is 100 req/min per API key and
   * this sender uses one request per event, sharing that bucket with the CLI's
   * hook binary on the same candidate key. A cap that reset per invocation
   * would be no cap at all the moment a second caller appears — and the fix
   * this class exists to carry is about not losing events to that bucket.
   */
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly config: PromptsterConfig) {}

  private async acquire(): Promise<void> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  /**
   * Send a batch of events, at most MAX_CONCURRENT in flight across the sender.
   *
   * Returns THE EVENTS THAT FAILED — not a count of the ones that did not.
   *
   * Sends complete out of order, so a success count says nothing about WHICH
   * events landed. The caller requeues whatever comes back from here; given a
   * count it could only requeue an arbitrary suffix, which both re-sends events
   * already delivered and drops the ones that actually needed retrying. The
   * re-send half is not harmless: `raw_events` is idempotent on the event id,
   * but `timeline_events` inserts with a fresh id and has no unique constraint
   * on the source event, so a duplicate POST writes a second row and the
   * replay's attention counts and dwell totals come out wrong.
   *
   * Failures come back in the order they were given, so a retry preserves the
   * order the candidate produced them in.
   */
  async sendBatch(events: PromptsterEvent[]): Promise<PromptsterEvent[]> {
    const failed: (PromptsterEvent | undefined)[] = new Array(events.length);

    await Promise.all(
      events.map(async (event, i) => {
        await this.acquire();
        try {
          if (!(await this.sendOne(event))) failed[i] = event;
        } finally {
          this.release();
        }
      }),
    );

    const out = failed.filter((e): e is PromptsterEvent => e !== undefined);
    if (out.length > 0) {
      log(`Sent ${events.length - out.length}/${events.length} events`);
    }
    return out;
  }

  private async sendOne(event: PromptsterEvent): Promise<boolean> {
    const url = `${this.config.apiUrl}/v1/hooks/ingest`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logError(`Ingest failed (${response.status}): ${event.kind}/${(event.data as Record<string, unknown>).subKind ?? ''}`);
        return false;
      }

      return true;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logError('Ingest request timed out', err);
      } else {
        logError('Ingest request failed', err);
      }
      return false;
    }
  }
}
