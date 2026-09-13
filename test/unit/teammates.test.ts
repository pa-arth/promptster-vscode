import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as config from '../../src/config';
import { fromJson } from '../../src/config';

vi.mock('vscode', () => import('../fakes/vscode'));
import { TeammatesApi, TeammatesView } from '../../src/ui/teammates';

const session = fromJson({ apiUrl: 'https://api.example.test/', sessionToken: 'PST-test', sessionId: 'session 1' }, '.promptster/session.json')!;
const sent = { eventId: 'one', at: '2026-09-12T10:03:20Z', direction: 'to_persona', kind: 'message', text: 'Question' };
const away = { eventId: 'two', at: '2026-09-12T10:03:21Z', direction: 'from_persona', kind: 'away', text: 'In a meeting, back in a bit.' };

beforeEach(() => vi.restoreAllMocks());

describe('Teammates API', () => {
  it('uses the session credential and exact candidate routes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ threadId: 'priya', sent, reply: away }) } as Response);
    const result = await new TeammatesApi(session).send('priya', ' Question ');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/v1/sessions/session%201/teammates/priya/messages', expect.objectContaining({
      method: 'POST', headers: { 'X-API-Key': 'PST-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ' Question ' }),
    }));
    expect(result.reply.kind).toBe('away');
    expect(result.reply.text).toBe(away.text);
  });

  it('reads the persisted thread without manufacturing an answer', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ threadId: 'priya', messages: [sent, away] }) } as Response);
    const result = await new TeammatesApi(session).messages('priya');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/v1/sessions/session%201/teammates/priya/messages', expect.objectContaining({ method: 'GET', headers: { 'X-API-Key': 'PST-test' } }));
    expect(result.messages).toEqual([sent, away]);
  });
});

describe('ticket-flow visibility', () => {
  it('remembers not_ticket_flow for a session, then probes a new session', async () => {
    let current = session;
    vi.spyOn(config, 'readSession').mockImplementation(() => current);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not_ticket_flow' }) } as Response);
    const view = new TeammatesView({ subscriptions: [] } as never);
    await view.refresh();
    await view.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    current = { ...session, sessionId: 'session-2' };
    await view.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries other failures for the same session', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'teammate_unavailable' }) } as Response);
    const view = new TeammatesView({ subscriptions: [] } as never);
    await view.refresh();
    await view.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('session thread boundary', () => {
  it('ignores an old session thread response after a session switch', async () => {
    let current = session;
    vi.spyOn(config, 'readSession').mockImplementation(() => current);
    const posted: Array<{ type: string; sessionId: string; messages?: unknown[] }> = [];
    let resolveOld!: (response: Response) => void;
    const oldThread = new Promise<Response>(resolve => { resolveOld = resolve; });
    const persona = { id: 'priya', name: 'Priya Raman', role: 'Architect', owns: 'Prior art', avatar: null };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/messages') && path.includes('session%201')) return oldThread;
      if (path.endsWith('/messages')) return { ok: true, json: async () => ({ threadId: 'priya', messages: [{ ...away, text: 'New session answer' }] }) } as Response;
      return { ok: true, json: async () => ({ personas: [persona] }) } as Response;
    });
    const view = new TeammatesView({ subscriptions: [] } as never);
    view.resolveWebviewView({ webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (message: { type: string; sessionId: string; messages?: unknown[] }) => { posted.push(message); return Promise.resolve(true); },
    } } as never);
    for (let i = 0; i < 10 && !posted.some(message => message.type === 'selected'); i++) await Promise.resolve();
    current = { ...session, sessionId: 'session-2' };
    await view.refresh();
    resolveOld({ ok: true, json: async () => ({ threadId: 'priya', messages: [{ ...away, text: 'Old session answer' }] }) } as Response);
    await Promise.resolve();
    await Promise.resolve();
    const threads = posted.filter(message => message.type === 'thread');
    expect(threads).toHaveLength(1);
    expect(threads[0].sessionId).toBe('session-2');
    expect(threads[0].messages).toEqual([{ ...away, text: 'New session answer' }]);
    expect(posted.filter(message => message.type === 'reset').map(message => message.sessionId)).toEqual(['session 1', 'session-2']);
  });
});

describe('thread isolation', () => {
  it('contributes no command or language-model tool that returns thread contents', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(manifest.contributes.commands.every((command: { command: string }) => !/teammate|thread|message/i.test(command.command))).toBe(true);
    expect(manifest.contributes.languageModelTools).toBeUndefined();
    const source = readFileSync(resolve('src/ui/teammates.ts'), 'utf8');
    expect(source).not.toMatch(/registerCommand|writeFile|process\.env|createTerminal|registerTool/);
  });
});
