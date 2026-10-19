import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { crossed, timeLeftText } from '../../src/ui/timeLeft';
import { fromJson } from '../../src/config';

const MIN = 60_000;

describe('time left', () => {
  it('formats minutes and hours', () => {
    expect(timeLeftText(42 * MIN + 13_000)).toBe('42:13');
    expect(timeLeftText(62 * MIN + 7_000)).toBe('1:02:07');
    expect(timeLeftText(-5_000)).toBe('0:00');
  });

  it('warns once per mark, including a late tick, and never for a mark already past', () => {
    expect(crossed(10 * MIN + 500, 10 * MIN - 500)).toEqual([10]);
    expect(crossed(10 * MIN - 500, 10 * MIN - 1500)).toEqual([]);
    expect(crossed(6 * MIN, 30_000)).toEqual([5, 1]);
    expect(crossed(1_000, 0)).toEqual([0]);
    expect(crossed(-1_000, -2_000)).toEqual([]);
  });

  it('reads the deadline the CLI uses: startedAt + timeLimitMinutes', () => {
    const base = { apiUrl: 'https://api.test', key: 'k', sessionId: 's' };
    const s = fromJson({ ...base, startedAt: '2026-10-17T19:50:00Z', timeLimitMinutes: 60 }, 'f');
    expect(s?.deadlineAt).toBe(Date.parse('2026-10-17T20:50:00Z'));
    expect(fromJson({ ...base, startedAt: '0001-01-01T00:00:00Z', timeLimitMinutes: 60 }, 'f')?.deadlineAt).toBeUndefined();
    expect(fromJson({ ...base, startedAt: '2026-10-17T19:50:00Z', timeLimitMinutes: 0 }, 'f')?.deadlineAt).toBeUndefined();
  });
});
