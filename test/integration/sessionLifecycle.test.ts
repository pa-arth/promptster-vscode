import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => import('../fakes/vscode'));

import {
  emitters,
  makeDocument,
  makeExtensionContext,
  FakeMemento,
  resetState,
  state,
  commands,
  fireWatcher,
  setSetting,
  type FakeEditor,
} from '../fakes/vscode';
import type { PromptsterEvent } from '../../src/types';

/**
 * The session lifecycle, driven through the real extension entry point.
 *
 * Covers three tasks that are one behaviour from the candidate's side:
 *   1.1 the extension is pointed at the session's API URL, read from the file
 *       the CLI actually writes;
 *   1.2 it captures only when the session records consent, and never asks again;
 *   1.3 reattaching does not re-report what the first attach already reported.
 */

let memento: FakeMemento;

/** The extension instance the current test activated, torn down in afterEach. */
let activated: { deactivate: () => Promise<void> } | undefined;

/** Bodies POSTed to the ingest endpoint, in order. */
let posted: { url: string; headers: Record<string, string>; event: PromptsterEvent }[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posted.push({
        url,
        headers: init.headers,
        event: JSON.parse(init.body) as PromptsterEvent,
      });
      return { ok: true, status: 200 } as Response;
    }),
  );
}

function writeSessionFile(root: string, patch: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, '.promptster'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.promptster/session.json'),
    JSON.stringify({
      // Field names and shape copied from promptster-cli's Session struct.
      sessionId: 'sess_abc123',
      sessionToken: 'tok',
      key: 'PST-candidate-key',
      assessmentId: 'asmt_1',
      apiUrl: 'https://api.assessment.example/',
      consentAccepted: true,
      consentToIntegrity: false,
      // RELATIVE TO NOW, never a literal. A hard-coded expiry makes the whole
      // suite a time bomb: once the date passes, `isExpired` correctly refuses
      // the session, every "did it capture?" assertion collapses to zero, and
      // nine tests fail for a reason that has nothing to do with the code under
      // test. That is exactly what happened on 2026-08-22. Tests that DO care
      // about expiry pass their own literal through `patch`.
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ...patch,
    }),
    'utf-8',
  );
}

function editorFor(fsPath: string): FakeEditor {
  return { document: makeDocument(fsPath, 'const a = 1;\nconst b = 2;\n') };
}

function activateFile(editor: FakeEditor): void {
  state.activeEditor = editor;
  emitters.activeTextEditor.fire(editor);
}

/** Load a fresh copy of the extension module. */
async function loadExtension() {
  vi.resetModules();
  return import('../../src/extension');
}

/**
 * A reload: the old extension host is torn down, then a fresh copy of the
 * module is loaded. Deactivating first matters — without it the previous
 * instance's collectors stay subscribed and the test measures two extensions
 * running at once, which is not what a reload is.
 */
async function reloadExtension(previous: { deactivate: () => Promise<void> }) {
  const pending = previous.deactivate();
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  return loadExtension();
}

/**
 * Activate and wait for it to settle. `activate()` returns before capture is
 * running — reconcile() is async — so a test that fires editor events straight
 * after would fire them at nothing.
 */
async function activateExtension(
  ext: { activate: (ctx: never) => void },
  version?: string,
): Promise<void> {
  ext.activate(makeExtensionContext(memento, version) as never);
  activated = ext as unknown as { deactivate: () => Promise<void> };
  await vi.advanceTimersByTimeAsync(1);
}

/**
 * Tear down whatever the test activated.
 *
 * `vi.resetModules()` gives the next test a fresh copy of the module, but the
 * PREVIOUS copy's collectors are still subscribed to the fake's singleton
 * emitters — so it keeps capturing into the next test's `posted` array. That is
 * the same two-extensions-at-once problem `reloadExtension` documents, except
 * it leaks across tests rather than within one. Only an assertion that `posted`
 * is EMPTY can see it, which is why it survived until one was written.
 */
async function deactivateExtension(): Promise<void> {
  if (!activated) return;
  const pending = activated.deactivate();
  activated = undefined;
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
}

/** Run a command that awaits a transport flush, keeping fake timers moving. */
async function runCommand(id: string): Promise<void> {
  const pending = commands.execute(id);
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
}

/** Drain the transport by advancing past its flush interval. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(6_000);
  await vi.advanceTimersByTimeAsync(200);
}

describe('session lifecycle', () => {
  let root: string;

  beforeEach(() => {
    resetState();
    posted = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptster-session-'));
    state.workspaceRoot = root;
    memento = new FakeMemento();
    commands.registered.clear();
    stubFetch();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await deactivateExtension();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // --- 1.1 ---------------------------------------------------------------
  describe('1.1 — the session supplies the API URL', () => {
    it('opens the hosted terminal and launches the recruiter-selected agent once', async () => {
      // Hosted ARM carries only sessionToken. A legacy duplicate `key` in this
      // fixture previously hid the production parser mismatch and prevented
      // reconcile() from ever reaching the existing auto-launch path.
      writeSessionFile(root, { key: undefined, noSelfEvict: true, tools: ['codex'] });
      const closeAgentSidebar = vi.fn();
      commands.registered.set('workbench.action.closeSecondarySideBar', closeAgentSidebar);
      const first = await loadExtension();
      await activateExtension(first);

      expect(closeAgentSidebar).toHaveBeenCalledOnce();
      expect(state.terminals).toEqual([
        { name: 'Promptster Assessment', shown: true, commands: ['promptster codex'] },
      ]);

      const second = await reloadExtension(first);
      await activateExtension(second);
      expect(closeAgentSidebar).toHaveBeenCalledOnce();
      expect(state.terminals).toHaveLength(1);
    });

    it('does not open an agent terminal for local sessions', async () => {
      writeSessionFile(root, { tools: ['claude'] });
      const ext = await loadExtension();
      await activateExtension(ext);
      expect(state.terminals).toEqual([]);
    });

    it('prefers Claude when the recruiter allows both agents', async () => {
      writeSessionFile(root, { noSelfEvict: true, tools: ['claude', 'codex'] });
      const ext = await loadExtension();
      await activateExtension(ext);
      expect(state.terminals[0]?.commands).toEqual(['claude']);
    });

    it('reads .promptster/session.json, which is the file the CLI writes', async () => {
      writeSessionFile(root);
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();

      expect(posted.length).toBeGreaterThan(0);
      for (const req of posted) {
        expect(req.url).toBe('https://api.assessment.example/v1/hooks/ingest');
        expect(req.headers['X-API-Key']).toBe('tok');
        expect(req.event.sessionId).toBe('sess_abc123');
      }
    });

    it('captures nothing when no session file exists', async () => {
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      expect(posted).toEqual([]);
    });

    it('captures nothing when the session file has no apiUrl', async () => {
      writeSessionFile(root, { apiUrl: undefined });
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      expect(posted).toEqual([]);
    });

    it('stamps the running extension version on session_start', async () => {
      writeSessionFile(root);
      const ext = await loadExtension();
      await activateExtension(ext, '9.9.9');
      await flush();
      const start = posted.find((p) => p.event.kind === 'session_start');
      // Not a hardcoded literal in the source — a literal goes stale silently.
      expect(start?.event.data.extensionVersion).toBe('9.9.9');
    });
  });

  // --- 1.2 ---------------------------------------------------------------
  describe('1.2 — consent comes from the session', () => {
    it('captures without presenting a dialog when the session recorded consent', async () => {
      const shown = vi.fn();
      const fake = await import('../fakes/vscode');
      const original = fake.window.showInformationMessage;
      (fake.window as { showInformationMessage: unknown }).showInformationMessage = shown;

      writeSessionFile(root, { consentAccepted: true });
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();

      expect(posted.length).toBeGreaterThan(0);
      expect(shown).not.toHaveBeenCalled();
      (fake.window as { showInformationMessage: unknown }).showInformationMessage = original;
    });

    it('captures nothing when the session did not record consent', async () => {
      writeSessionFile(root, { consentAccepted: false });
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      emitters.changeTextDocument.fire({
        document: editorFor(path.join(root, 'src/index.ts')).document,
        contentChanges: [
          { text: 'x', rangeLength: 0, range: { start: { line: 0 }, end: { line: 0 } } },
        ],
      });
      await flush();
      expect(posted).toEqual([]);
    });

    /**
     * `promptster.enabled` shipped as a visible control described to the
     * candidate as "Enable or disable Promptster telemetry capture" and was
     * never read — `getConfiguration` appeared nowhere in src/. Unticking it
     * changed nothing and capture continued, so anyone who opted out was still
     * captured. These drive the real extension to prove both halves: it does
     * not start when off, and unticking it STOPS a capture already running.
     */
    it('captures nothing when telemetry is disabled in settings', async () => {
      setSetting('promptster.enabled', false);
      writeSessionFile(root);
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      emitters.changeTextDocument.fire({
        document: editorFor(path.join(root, 'src/index.ts')).document,
        contentChanges: [
          { text: 'x', rangeLength: 0, range: { start: { line: 0 }, end: { line: 0 } } },
        ],
      });
      await flush();
      expect(posted).toEqual([]);
    });

    it('stops a running capture the moment telemetry is disabled', async () => {
      writeSessionFile(root);
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      // It is genuinely capturing before the opt-out — otherwise the assertion
      // below would pass for a session that never started.
      expect(posted.length).toBeGreaterThan(0);

      setSetting('promptster.enabled', false);
      await flush();
      const afterOptOut = posted.length;

      activateFile(editorFor(path.join(root, 'src/other.ts')));
      emitters.changeTextDocument.fire({
        document: editorFor(path.join(root, 'src/other.ts')).document,
        contentChanges: [
          { text: 'y', rangeLength: 0, range: { start: { line: 0 }, end: { line: 0 } } },
        ],
      });
      await flush();
      expect(posted.length).toBe(afterOptOut);
    });

    it('treats a missing consent field as absent consent', async () => {
      writeSessionFile(root, { consentAccepted: undefined });
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      expect(posted).toEqual([]);
    });

    it('captures nothing once the candidate key has expired', async () => {
      writeSessionFile(root, { expiresAt: '2020-01-01T00:00:00Z' });
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      expect(posted).toEqual([]);
    });

    it('is not confused by the Go zero time in expiresAt', async () => {
      // encoding/json marshals a zero time.Time as 0001-01-01T00:00:00Z, which
      // is in the past. Treating it as an expiry would kill every session.
      writeSessionFile(root, { expiresAt: '0001-01-01T00:00:00Z' });
      const ext = await loadExtension();
      await activateExtension(ext);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      expect(posted.length).toBeGreaterThan(0);
    });

    it('a pause survives a reload — resuming is the candidate’s call, not ours', async () => {
      writeSessionFile(root);
      const first = await loadExtension();
      await activateExtension(first);
      await runCommand('promptster.pause');
      await flush();
      posted = [];

      // Reload: fresh module, same globalState.
      const second = await reloadExtension(first);
      await activateExtension(second);
      activateFile(editorFor(path.join(root, 'src/index.ts')));
      await flush();
      expect(posted).toEqual([]);
    });
  });

  // --- 1.3 ---------------------------------------------------------------
  describe('1.3 — reattach idempotence', () => {
    it('emits session_start once across a reload, not once per attach', async () => {
      writeSessionFile(root);
      const first = await loadExtension();
      await activateExtension(first);
      await flush();
      expect(posted.filter((p) => p.event.kind === 'session_start')).toHaveLength(1);

      const second = await reloadExtension(first);
      await activateExtension(second);
      await flush();
      expect(posted.filter((p) => p.event.kind === 'session_start')).toHaveLength(1);
    });

    it('does not re-report files the previous attach already reported', async () => {
      writeSessionFile(root);
      const a = path.join(root, 'src/a.ts');
      const b = path.join(root, 'src/b.ts');

      const first = await loadExtension();
      await activateExtension(first);
      activateFile(editorFor(a));
      activateFile(editorFor(b));
      await flush();
      const opensBefore = posted.filter((p) => p.event.data.subKind === 'file_open');
      expect(opensBefore.map((p) => p.event.data.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
      posted = [];

      // Reload. VSCode restores the open editors and re-fires the active-editor
      // event for them; that is a restoration, not the candidate visiting a file.
      const second = await reloadExtension(first);
      await activateExtension(second);
      activateFile(editorFor(a));
      activateFile(editorFor(b));
      await flush();

      expect(posted.filter((p) => p.event.data.subKind === 'file_open')).toEqual([]);
    });

    it('still records a genuine visit after the reattach window closes', async () => {
      writeSessionFile(root);
      const a = path.join(root, 'src/a.ts');

      const first = await loadExtension();
      await activateExtension(first);
      activateFile(editorFor(a));
      await flush();
      posted = [];

      const second = await reloadExtension(first);
      await activateExtension(second);
      activateFile(editorFor(a)); // restoration — suppressed
      await vi.advanceTimersByTimeAsync(10_000); // window closes
      posted = [];
      activateFile(editorFor(a)); // the candidate comes back to it — recorded
      await flush();

      const opens = posted.filter((p) => p.event.data.subKind === 'file_open');
      expect(opens).toHaveLength(1);
      expect(opens[0].event.data.isNewFile).toBe(false);
    });

    it('keeps isNewFile truthful across a reload', async () => {
      writeSessionFile(root);
      const a = path.join(root, 'src/a.ts');

      const first = await loadExtension();
      await activateExtension(first);
      activateFile(editorFor(a));
      await flush();
      expect(posted.find((p) => p.event.data.subKind === 'file_open')?.event.data.isNewFile).toBe(
        true,
      );
      posted = [];

      const second = await reloadExtension(first);
      await activateExtension(second);
      await vi.advanceTimersByTimeAsync(10_000);
      activateFile(editorFor(a));
      await flush();
      expect(posted.find((p) => p.event.data.subKind === 'file_open')?.event.data.isNewFile).toBe(
        false,
      );
    });

    it('a rewrite of session.json does not restart capture', async () => {
      // The CLI rewrites session.json several times per session. Each write
      // reaches the watcher; none of them is a new session.
      writeSessionFile(root);
      const ext = await loadExtension();
      await activateExtension(ext);
      await flush();
      posted = [];

      writeSessionFile(root, { honeypotToken: 'later-write', tools: ['claude'] });
      fireWatcher('.promptster/session.json', 'change', path.join(root, '.promptster/session.json'));
      await flush();

      expect(posted.filter((p) => p.event.kind === 'session_start')).toEqual([]);
    });

    it('a new session id does start a new capture', async () => {
      writeSessionFile(root);
      const ext = await loadExtension();
      await activateExtension(ext);
      await flush();
      posted = [];

      writeSessionFile(root, { sessionId: 'sess_second' });
      fireWatcher('.promptster/session.json', 'change', path.join(root, '.promptster/session.json'));
      await flush();

      const starts = posted.filter((p) => p.event.kind === 'session_start');
      expect(starts).toHaveLength(1);
      expect(starts[0].event.sessionId).toBe('sess_second');
    });
  });
});

/**
 * `.promptster/editor-capture.json` — what `promptster doctor` reads.
 *
 * An installed-but-dormant extension is the failure mode that matters: it
 * produces a session with no attention events, which reads exactly like a
 * candidate who opened no files. "Present" is not a sufficient check, so the
 * extension has to report its own state.
 */
describe('capture state file (promptster doctor, §2.2)', () => {
  let root: string;

  beforeEach(() => {
    resetState();
    posted = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptster-state-'));
    state.workspaceRoot = root;
    memento = new FakeMemento();
    commands.registered.clear();
    stubFetch();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await deactivateExtension();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readState(): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(root, '.promptster/editor-capture.json'), 'utf-8'),
    ) as Record<string, unknown>;
  }

  it('reports capturing, with the session and version, when it is', async () => {
    writeSessionFile(root);
    const ext = await loadExtension();
    await activateExtension(ext, '0.3.0');
    const s = readState();
    expect(s.capturing).toBe(true);
    expect(s.sessionId).toBe('sess_abc123');
    expect(s.extensionVersion).toBe('0.3.0');
    expect(s.editor).toBe('vscode');
    expect(typeof s.updatedAt).toBe('string');
    expect(s.reason).toBeUndefined();
  });

  it('reports why it is not capturing when consent is absent', async () => {
    writeSessionFile(root, { consentAccepted: false });
    const ext = await loadExtension();
    await activateExtension(ext);
    const s = readState();
    expect(s.capturing).toBe(false);
    expect(s.reason).toBe('consent-not-recorded');
    // Present, activated, and saying it is dormant — the state doctor must be
    // able to tell apart from "not installed".
    expect(s.sessionId).toBe('sess_abc123');
  });

  it('reports no-session when there is nothing to capture for', async () => {
    fs.mkdirSync(path.join(root, '.promptster'), { recursive: true });
    const ext = await loadExtension();
    await activateExtension(ext);
    const s = readState();
    expect(s.capturing).toBe(false);
    expect(s.reason).toBe('no-session');
  });

  it('reports paused, and keeps reporting it across a reload', async () => {
    writeSessionFile(root);
    const first = await loadExtension();
    await activateExtension(first);
    await runCommand('promptster.pause');
    expect(readState()).toMatchObject({ capturing: false, reason: 'paused' });

    const second = await reloadExtension(first);
    await activateExtension(second);
    expect(readState()).toMatchObject({ capturing: false, reason: 'paused' });
  });

  it('is written where the CLI looks and the sanitizer refuses to report', async () => {
    writeSessionFile(root);
    const ext = await loadExtension();
    await activateExtension(ext);
    expect(fs.existsSync(path.join(root, '.promptster/editor-capture.json'))).toBe(true);
    // It lives under .promptster/, which pathSanitizer drops, so writing it can
    // never itself become a captured event.
    activateFile({ document: makeDocument(path.join(root, '.promptster/editor-capture.json'), '{}') });
    await flush();
    expect(posted.filter((p) => p.event.data.subKind === 'file_open')).toEqual([]);
  });
});
