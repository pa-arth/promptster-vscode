import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LATCH_DIR, SessionStore } from '../../src/sessionStore';

/** A memento per "browser": code-server keeps globalState in IndexedDB. */
function memento() {
  const data = new Map<string, unknown>();
  return {
    keys: () => [...data.keys()],
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => void data.set(k, v),
  } as never;
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'session-store-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('SessionStore.claim', () => {
  it('fires once per session across browsers that share nothing but the box', async () => {
    const first = new SessionStore(memento(), () => root);
    const secondBrowser = new SessionStore(memento(), () => root);
    expect(await first.claim('s1', 'agentLaunched')).toBe(true);
    expect(await first.claim('s1', 'agentLaunched')).toBe(false);
    expect(await secondBrowser.claim('s1', 'agentLaunched')).toBe(false);
    expect(secondBrowser.read('s1').agentLaunched).toBe(true);
    expect(existsSync(join(root, LATCH_DIR, 's1.agentLaunched'))).toBe(true);
  });

  it('lets exactly one of two concurrent windows through', async () => {
    const windows = Array.from({ length: 5 }, () => new SessionStore(memento(), () => root));
    const won = await Promise.all(windows.map((w) => w.claim('s1', 'sessionStartEmitted')));
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('keeps latches per session and per kind', async () => {
    const store = new SessionStore(memento(), () => root);
    expect(await store.claim('s1', 'agentLaunched')).toBe(true);
    expect(await store.claim('s1', 'sessionStartEmitted')).toBe(true);
    expect(await store.claim('s2', 'agentLaunched')).toBe(true);
  });

  it('falls back to the memento with no workspace', async () => {
    const store = new SessionStore(memento());
    expect(await store.claim('s1', 'agentLaunched')).toBe(true);
    expect(await store.claim('s1', 'agentLaunched')).toBe(false);
  });
  it('backfills the marker for a latch an older build kept in the browser only', async () => {
    const upgradedBrowser = memento();
    await new SessionStore(upgradedBrowser).update('s1', { agentLaunched: true });
    expect(await new SessionStore(upgradedBrowser, () => root).claim('s1', 'agentLaunched')).toBe(false);
    expect(await new SessionStore(memento(), () => root).claim('s1', 'agentLaunched')).toBe(false);
  });

  it('keeps a won claim when the browser-state write fails', async () => {
    const broken = { get: () => undefined, keys: () => [], update: async () => { throw new Error('quota'); } } as never;
    expect(await new SessionStore(broken, () => root).claim('s1', 'agentLaunched')).toBe(true);
    expect(await new SessionStore(memento(), () => root).claim('s1', 'agentLaunched')).toBe(false);
  });
});
