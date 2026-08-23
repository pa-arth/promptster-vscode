import type { PromptsterConfig, PromptsterEvent } from '../types';
import { log, logError } from '../utils/logger';

const MAX_CONCURRENT = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export class HttpSender {
  constructor(private readonly config: PromptsterConfig) {}

  /**
   * Send a batch of events, up to MAX_CONCURRENT at a time.
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
   */
  async sendBatch(events: PromptsterEvent[]): Promise<PromptsterEvent[]> {
    const queue = [...events];
    const failed: PromptsterEvent[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        const event = queue.shift();
        if (!event) return;
        if (!(await this.sendOne(event))) failed.push(event);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT, events.length) }, () => worker()),
    );

    if (failed.length > 0) {
      log(`Sent ${events.length - failed.length}/${events.length} events`);
    }
    return failed;
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
