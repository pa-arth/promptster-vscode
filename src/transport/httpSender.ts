import type { PromptsterConfig, PromptsterEvent } from '../types';
import { log, logError } from '../utils/logger';

const MAX_CONCURRENT = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export class HttpSender {
  private inFlight = 0;

  constructor(private readonly config: PromptsterConfig) {}

  /**
   * Send a batch of events sequentially with concurrency limit.
   * Returns the number of successfully sent events.
   */
  async sendBatch(events: PromptsterEvent[]): Promise<number> {
    let sent = 0;
    const queue = [...events];

    while (queue.length > 0) {
      // Wait if at concurrency limit
      while (this.inFlight >= MAX_CONCURRENT) {
        await sleep(50);
      }

      const event = queue.shift()!;
      this.inFlight++;

      this.sendOne(event)
        .then((ok) => {
          if (ok) sent++;
        })
        .finally(() => {
          this.inFlight--;
        });
    }

    // Wait for all in-flight to complete
    while (this.inFlight > 0) {
      await sleep(50);
    }

    return sent;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
