import * as vscode from 'vscode';
import type { PromptsterSession } from '../types';

/** `$3.21 / $25.00`. */
export function budgetText(spentUsd: number, budgetUsd: number): string {
  return `$${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)}`;
}

/** The session's AI spend against its cap, or undefined when it can't be read. */
export async function fetchBudget(session: PromptsterSession): Promise<{ spentUsd: number; budgetUsd: number } | undefined> {
  try {
    const res = await fetch(`${session.apiUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/budget`, {
      headers: { 'X-API-Key': session.apiKey },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { spentUsd?: unknown; budgetUsd?: unknown };
    if (typeof body.spentUsd !== 'number' || typeof body.budgetUsd !== 'number') return undefined;
    return { spentUsd: body.spentUsd, budgetUsd: body.budgetUsd };
  } catch {
    return undefined;
  }
}

/**
 * AI budget in the status bar, beside the clock. Polled once a minute.
 * Hidden whenever it can't be read: an unreadable budget is not an unspent one.
 */
export class Budget implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  private interval: ReturnType<typeof setInterval> | undefined;
  private session: PromptsterSession | undefined;

  /** Track a session, or stop and hide. Idempotent per session id. */
  set(session: PromptsterSession | undefined): void {
    if (session?.sessionId === this.session?.sessionId) return;
    this.session = session;
    clearInterval(this.interval);
    this.interval = undefined;
    this.item.hide();
    if (!session) return;
    void this.tick();
    this.interval = setInterval(() => void this.tick(), 60_000);
  }

  async tick(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const budget = await fetchBudget(session);
    if (session !== this.session) return;
    if (!budget) {
      this.item.hide();
      return;
    }
    this.item.text = `$(credit-card) ${budgetText(budget.spentUsd, budget.budgetUsd)}`;
    this.item.tooltip = 'AI spend in this assessment against its budget. Model requests stop at the budget.';
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.interval);
    this.item.dispose();
  }
}
