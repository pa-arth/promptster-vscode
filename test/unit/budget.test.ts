import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('../fakes/vscode'));
import { fromJson } from '../../src/config';
import { Budget, budgetText, fetchBudget } from '../../src/ui/budget';

const session = fromJson({ apiUrl: 'https://api.example.test', sessionToken: 'PST-test', sessionId: 'session 1' }, '.promptster/session.json')!;

afterEach(() => vi.restoreAllMocks());

describe('budget', () => {
  it('formats spend against the cap', () => {
    expect(budgetText(3.214, 25)).toBe('$3.21 / $25.00');
  });

  it('reads the session budget with the session key', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ spentUsd: 1.5, budgetUsd: 25 }) } as Response);
    expect(await fetchBudget(session)).toEqual({ spentUsd: 1.5, budgetUsd: 25 });
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/v1/sessions/session%201/budget', expect.objectContaining({ headers: { 'X-API-Key': 'PST-test' } }));
  });

  it('is unreadable, not zero, on any failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    expect(await fetchBudget(session)).toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => ({ spentUsd: '1' }) } as Response);
    expect(await fetchBudget(session)).toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchBudget(session)).toBeUndefined();
  });

  it('restarts with the new key when a session is rewritten under the same id', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ spentUsd: 2, budgetUsd: 25 }) } as Response);
    const budget = new Budget();
    budget.set(session);
    budget.set({ ...session, apiKey: 'PST-new' });
    await budget.tick();
    expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ headers: { 'X-API-Key': 'PST-new' } }));
    budget.dispose();
    vi.useRealTimers();
  });

  it('keeps the newest spend when an older poll finishes last', async () => {
    const answers: Array<(r: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(r => answers.push(r)));
    const budget = new Budget();
    const item = (budget as unknown as { item: { text: string } }).item;
    budget.set(session);
    const newer = budget.tick();
    answers[1]({ ok: true, json: async () => ({ spentUsd: 5, budgetUsd: 25 }) } as Response);
    await newer;
    answers[0]({ ok: true, json: async () => ({ spentUsd: 1, budgetUsd: 25 }) } as Response);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(item.text).toContain('$5.00 / $25.00');
    budget.dispose();
  });

  it('shows the budget, then hides it when a later read fails', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ spentUsd: 2, budgetUsd: 25 }) } as Response);
    const budget = new Budget();
    const item = (budget as unknown as { item: { text: string; show: () => void; hide: () => void } }).item;
    const shown = vi.spyOn(item, 'show');
    const hidden = vi.spyOn(item, 'hide');
    budget.set(session);
    await budget.tick();
    expect(item.text).toContain('$2.00 / $25.00');
    expect(shown).toHaveBeenCalled();
    fetch.mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    await budget.tick();
    expect(hidden).toHaveBeenCalled();
    budget.set(undefined);
    budget.dispose();
    vi.useRealTimers();
  });
});
