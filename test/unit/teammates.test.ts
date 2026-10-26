import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as config from '../../src/config';
import { fromJson } from '../../src/config';

vi.mock('vscode', () => import('../fakes/vscode'));
import * as fake from '../fakes/vscode';
import { CheckInsApi, TeammatesApi, TeammatesView } from '../../src/ui/teammates';

const session = fromJson({ apiUrl: 'https://api.example.test/', sessionToken: 'PST-test', sessionId: 'session 1' }, '.promptster/session.json')!;
const sent = { eventId: 'one', at: '2026-09-12T10:03:20Z', direction: 'to_persona', kind: 'message', text: 'Question' };
const away = { eventId: 'two', at: '2026-09-12T10:03:21Z', direction: 'from_persona', kind: 'away', text: 'In a meeting, back in a bit.' };

beforeEach(() => vi.restoreAllMocks());

const checkInsOff = { ok: false, status: 404, json: async () => ({ error: 'check_ins_off' }) } as Response;
/** Teammate routes from `impl`; check-ins are off for the assessment. */
const teammatesFetch = (impl: (url: unknown, init?: RequestInit) => Promise<Response>) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => String(url).includes('/check-ins') ? checkInsOff : impl(url, init));
const teammateCalls = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.filter(([url]) => String(url).includes('/teammates')).length;

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
    const fetch = teammatesFetch(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_ticket_flow' }) } as Response));
    const view = new TeammatesView({ subscriptions: [] } as never);
    await view.refresh();
    await view.refresh();
    expect(teammateCalls(fetch)).toBe(1);
    current = { ...session, sessionId: 'session-2' };
    await view.refresh();
    expect(teammateCalls(fetch)).toBe(2);
  });

  it('retries other failures for the same session', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const fetch = teammatesFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: 'teammate_unavailable' }) } as Response));
    const view = new TeammatesView({ subscriptions: [] } as never);
    await view.refresh();
    await view.refresh();
    expect(teammateCalls(fetch)).toBe(2);
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
    teammatesFetch(async (url) => {
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

describe('webview restoration', () => {
  it('restores roster and persisted history after visibility and ready refreshes', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const persona = { id: 'priya', name: 'Priya', role: 'Architect', owns: 'Prior art', avatar: null };
    teammatesFetch(async url => ({ ok: true, json: async () => String(url).endsWith('/messages') ? { messages: [sent, away] } : { personas: [persona] } }) as Response);
    const posted: any[] = [];
    let visibility!: () => void;
    let receive!: (message: unknown) => void;
    const webview = { cspSource: 'vscode-resource:', options: {}, html: '', onDidReceiveMessage: (fn: typeof receive) => { receive = fn; return { dispose() {} }; }, postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(true); } };
    const view = new TeammatesView({ subscriptions: [] } as never);
    view.resolveWebviewView({ webview, visible: true, onDidChangeVisibility: (fn: typeof visibility) => { visibility = fn; return { dispose() {} }; } } as never);
    await vi.waitFor(() => expect(posted.some(m => m.type === 'thread')).toBe(true));
    for (const restore of [() => visibility(), () => receive({ type: 'refresh' })]) {
      posted.length = 0;
      restore();
      await vi.waitFor(() => expect(posted.find(m => m.type === 'thread')?.messages).toEqual([sent, away]));
      expect(posted.find(m => m.type === 'personas')?.personas[0].id).toBe('priya');
    }
    expect(webview.html).toContain("vscode.postMessage({type:'refresh'})");
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
describe('webview reload mid-send', () => {
  it('re-sends busy so a reloaded panel does not accept a second message', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const persona = { id: 'priya', name: 'Priya Raman', role: 'Architect', owns: 'Prior art', avatar: null };
    let finishSend!: (r: Response) => void;
    teammatesFetch(async (url, init) => {
      if (init?.method === 'POST') return new Promise<Response>(r => { finishSend = r; });
      return (String(url).endsWith('/messages')
        ? { ok: true, json: async () => ({ threadId: 'priya', messages: [] }) }
        : { ok: true, json: async () => ({ personas: [persona] }) }) as Response;
    });
    const posted: Array<{ type: string; value?: boolean }> = [];
    let receive!: (request: unknown) => void;
    const view = new TeammatesView({ subscriptions: [] } as never);
    view.resolveWebviewView({ webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      onDidReceiveMessage: (l: (r: unknown) => void) => { receive = l; return { dispose() {} }; },
      postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
    } } as never);
    for (let i = 0; i < 20 && !posted.some(m => m.type === 'thread'); i++) await Promise.resolve();
    receive({ type: 'send', id: 'priya', text: 'hi', sessionId: session.sessionId });
    for (let i = 0; i < 20 && !posted.some(m => m.type === 'busy'); i++) await Promise.resolve();
    posted.length = 0;
    receive({ type: 'refresh' });
    for (let i = 0; i < 20 && !posted.some(m => m.type === 'busy'); i++) await Promise.resolve();
    expect(posted.find(m => m.type === 'busy')?.value).toBe(true);
    finishSend({ ok: true, json: async () => ({ threadId: 'priya', sent: away, reply: away }) } as Response);
  });

  it('re-reads a thread whose read started before a send finished', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const persona = { id: 'priya', name: 'Priya Raman', role: 'Architect', owns: 'Prior art', avatar: null };
    const reply = { ...away, eventId: 'three', kind: 'message', text: 'Answer' };
    let finishSend!: (r: Response) => void;
    let finishStaleRead: ((r: Response) => void) | undefined;
    let reads = 0;
    teammatesFetch(async (url, init) => {
      if (init?.method === 'POST') return new Promise<Response>(r => { finishSend = r; });
      if (!String(url).endsWith('/messages')) return { ok: true, json: async () => ({ personas: [persona] }) } as Response;
      reads++;
      // The second read (from a refresh mid-send) is slow and sees the pre-send history.
      if (reads === 2) return new Promise<Response>(r => { finishStaleRead = r; });
      return { ok: true, json: async () => ({ threadId: 'priya', messages: reads === 1 ? [] : [sent, reply] }) } as Response;
    });
    const posted: Array<{ type: string; messages?: unknown[] }> = [];
    let receive!: (request: unknown) => void;
    const view = new TeammatesView({ subscriptions: [] } as never);
    view.resolveWebviewView({ webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      onDidReceiveMessage: (l: (r: unknown) => void) => { receive = l; return { dispose() {} }; },
      postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
    } } as never);
    const settle = async (done: () => boolean) => { for (let i = 0; i < 50 && !done(); i++) await Promise.resolve(); };
    await settle(() => posted.some(m => m.type === 'thread'));
    receive({ type: 'send', id: 'priya', text: 'Question', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'busy'));
    receive({ type: 'refresh' });
    await settle(() => finishStaleRead !== undefined);
    finishSend({ ok: true, json: async () => ({ threadId: 'priya', sent, reply }) } as Response);
    await settle(() => posted.some(m => m.type === 'append'));
    posted.length = 0;
    finishStaleRead!({ ok: true, json: async () => ({ threadId: 'priya', messages: [] }) } as Response);
    await settle(() => posted.some(m => m.type === 'thread'));
    expect(posted.filter(m => m.type === 'thread').map(m => m.messages)).toEqual([[sent, reply]]);
  });

  it('does not switch back to a teammate the user left when a send spans its read', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const priya = { id: 'priya', name: 'Priya Raman', role: 'Architect', owns: 'Prior art', avatar: null };
    const dana = { ...priya, id: 'dana', name: 'Dana' };
    let finishPriyaRead: ((r: Response) => void) | undefined;
    teammatesFetch(async (url, init) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ threadId: 'dana', sent, reply: away }) } as Response;
      if (String(url).includes('/priya/messages')) return new Promise<Response>(r => { finishPriyaRead = r; });
      if (String(url).endsWith('/messages')) return { ok: true, json: async () => ({ threadId: 'dana', messages: [] }) } as Response;
      return { ok: true, json: async () => ({ personas: [priya, dana] }) } as Response;
    });
    const posted: Array<{ type: string; id?: string }> = [];
    let receive!: (request: unknown) => void;
    const view = new TeammatesView({ subscriptions: [] } as never);
    view.resolveWebviewView({ webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      onDidReceiveMessage: (l: (r: unknown) => void) => { receive = l; return { dispose() {} }; },
      postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
    } } as never);
    const settle = async (done: () => boolean) => { for (let i = 0; i < 50 && !done(); i++) await Promise.resolve(); };
    await settle(() => finishPriyaRead !== undefined);
    receive({ type: 'select', id: 'dana', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'thread' && m.id === 'dana'));
    receive({ type: 'send', id: 'dana', text: 'Question', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'append'));
    posted.length = 0;
    finishPriyaRead!({ ok: true, json: async () => ({ threadId: 'priya', messages: [] }) } as Response);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(posted.filter(m => m.type === 'selected').map(m => m.id)).toEqual([]);
  });

  it('drops appended messages the reloaded thread already has', () => {
    const source = readFileSync(resolve('src/ui/teammates.ts'), 'utf8');
    expect(source).toContain('data.messages.filter(m=>!seen.has(m.eventId))');
  });
});

describe('mid-session check-ins', () => {
  const jordan = { id: 'checkin', name: 'Jordan', role: 'Engineering lead', owns: 'Checks in on how it is going', avatar: null };
  const question = { eventId: 'q1', at: '2026-10-26T10:20:00Z', direction: 'from_reviewer', role: 'question', checkInId: 'q1', text: 'Why the mutex in poller.go?' };
  const answer = { eventId: 'a1', at: '2026-10-26T10:21:00Z', direction: 'to_reviewer', role: 'answer', checkInId: 'q1', text: 'Two writers.' };
  const ack = { eventId: 'k1', at: '2026-10-26T10:21:01Z', direction: 'from_reviewer', role: 'ack', checkInId: 'q1', text: 'Thanks — that helps. Carry on.' };
  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
  const settle = async (done: () => boolean = () => false) => { for (let i = 0; i < 50 && !done(); i++) await Promise.resolve(); };
  const mount = (view: TeammatesView, visible = false) => {
    const posted: any[] = [];
    let receive!: (request: unknown) => void;
    const show = vi.fn();
    view.resolveWebviewView({ visible, show, webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      onDidReceiveMessage: (l: typeof receive) => { receive = l; return { dispose() {} }; },
      postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); },
    } } as never);
    return { posted, show, send: (r: unknown) => receive(r) };
  };

  it('uses the session credential and the check-in routes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ sent: answer, reply: null }));
    const result = await new CheckInsApi(session).send('Two writers.');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/v1/sessions/session%201/check-ins/messages', expect.objectContaining({
      method: 'POST', headers: { 'X-API-Key': 'PST-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Two writers.' }),
    }));
    expect(result.reply).toBeNull();
    await new CheckInsApi(session).get();
    expect(fetch).toHaveBeenLastCalledWith('https://api.example.test/v1/sessions/session%201/check-ins', expect.objectContaining({ method: 'GET' }));
  });

  it('shows Jordan alone on a non-ticket-flow session, reveals without focus, and announces once', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/check-ins')
      ? ok({ reviewer: jordan, messages: [question], pendingCheckInId: 'q1' })
      : { ok: false, status: 404, json: async () => ({ error: 'not_ticket_flow' }) } as Response);
    const context = vi.spyOn(fake.commands, 'executeCommand');
    const notify = vi.spyOn(fake.window, 'showInformationMessage');
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted, show } = mount(view);
    await settle(() => posted.some(m => m.type === 'thread'));
    expect(context).toHaveBeenCalledWith('setContext', 'promptster.ticketFlow', true);
    const roster = posted.find(m => m.type === 'personas');
    expect(roster.personas.map((p: any) => [p.id, p.unread])).toEqual([['checkin', true]]);
    expect(roster.selected).toBe('checkin');
    expect(posted.find(m => m.type === 'thread').messages).toEqual([{ eventId: 'q1', at: question.at, direction: 'from_persona', kind: 'message', text: question.text }]);
    expect(show).toHaveBeenCalledWith(true);
    expect(context).not.toHaveBeenCalledWith('promptster.teammates.focus');
    expect(notify).toHaveBeenCalledWith('Jordan checked in', 'Open');
    await view.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('opens a never-resolved view through the focus command with preserveFocus', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/check-ins')
      ? ok({ reviewer: jordan, messages: [question], pendingCheckInId: 'q1' })
      : ok({ personas: [{ id: 'priya', name: 'Priya', role: 'Architect', owns: 'Prior art', avatar: null }] }));
    const commands = vi.spyOn(fake.commands, 'executeCommand');
    const view = new TeammatesView({ subscriptions: [] } as never);
    await view.refresh();
    await settle();
    expect(commands).toHaveBeenCalledWith('promptster.teammates.focus', { preserveFocus: true });
    expect(commands.mock.calls.filter(([id, arg]) => id === 'promptster.teammates.focus' && !arg)).toEqual([]);
    view.dispose();
  });

  it('polls every 30s, announces a newly due check-in, and stops on check_ins_off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      vi.spyOn(config, 'readSession').mockReturnValue(session);
      let checkIns: Response = ok({ reviewer: jordan, messages: [], pendingCheckInId: null });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/check-ins') ? checkIns : { ok: false, status: 404, json: async () => ({ error: 'not_ticket_flow' }) } as Response);
      const notify = vi.spyOn(fake.window, 'showInformationMessage');
      const view = new TeammatesView({ subscriptions: [] } as never);
      const { posted } = mount(view, true);
      await settle(() => posted.some(m => m.type === 'thread'));
      expect(notify).not.toHaveBeenCalled();
      checkIns = ok({ reviewer: jordan, messages: [question], pendingCheckInId: 'q1' });
      posted.length = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      await settle(() => posted.some(m => m.type === 'personas'));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(posted.find(m => m.type === 'thread')?.messages).toHaveLength(1);
      // The candidate has the thread on screen, so the dot is already read.
      expect(posted.find(m => m.type === 'personas').personas[0].unread).toBe(false);
      checkIns = { ok: false, status: 404, json: async () => ({ error: 'check_ins_off' }) } as Response;
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      const calls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/check-ins')).length;
      const before = calls();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(calls()).toBe(before);
      view.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  const priya = { id: 'priya', name: 'Priya', role: 'Architect', owns: 'Prior art', avatar: null };
  const followUp = { eventId: 'f1', at: '2026-10-26T10:21:01Z', direction: 'from_reviewer', role: 'follow_up', checkInId: 'q1', text: 'What breaks if a write is dropped?' };
  /** Routes: Jordan's GET answers `state.pending`; the POST waits on `state.post` when set. Teammates: priya when `ticketFlow`. */
  const route = (state: { pending: string | null; reply?: unknown; post?: Promise<Response>; ticketFlow?: boolean; off?: Set<string> }) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const path = String(url);
      if (path.endsWith('/check-ins/messages')) return state.post ?? ok({ sent: answer, reply: state.reply ?? null });
      if (path.endsWith('/check-ins')) return [...(state.off ?? [])].some(id => path.includes(`/sessions/${id}/`))
        ? { ok: false, status: 404, json: async () => ({ error: 'check_ins_off' }) } as Response
        : ok({ reviewer: jordan, messages: [question], pendingCheckInId: state.pending });
      if (!state.ticketFlow) return { ok: false, status: 404, json: async () => ({ error: 'not_ticket_flow' }) } as Response;
      return ok(path.endsWith('/messages') ? { messages: [] } : { personas: [priya] });
    });

  it('sends Jordan replies to the check-in endpoint and does not re-announce a follow-up shown inline', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const state = { pending: 'q1' as string | null, reply: followUp as unknown };
    const fetch = route(state);
    const notify = vi.spyOn(fake.window, 'showInformationMessage');
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted, send } = mount(view, true);
    await settle(() => posted.some(m => m.type === 'thread'));
    state.pending = 'f1'; // backend: the follow-up's own eventId becomes pending
    send({ type: 'send', id: 'checkin', text: 'Two writers.', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'append'));
    await settle();
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/check-ins/messages') && init?.method === 'POST')).toBe(true);
    expect(posted.find(m => m.type === 'append').messages.map((m: any) => m.direction)).toEqual(['to_persona', 'from_persona']);
    await view.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(posted.filter(m => m.type === 'personas').at(-1).personas[0].unread).toBe(false);
    view.dispose();
  });

  it('handles a message to Jordan with no open question: stored as an answer to itself, deflected', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    const own = { ...answer, eventId: 'a9', checkInId: 'a9', text: 'Is the API v2?' };
    const deflect = { eventId: 'd9', at: own.at, direction: 'from_reviewer', role: 'deflect', checkInId: 'a9', text: 'Good question for the ticket or your teammates — I’m just checking in on your approach.' };
    const state = { pending: null as string | null, post: Promise.resolve(ok({ sent: own, reply: deflect })) };
    route(state);
    const notify = vi.spyOn(fake.window, 'showInformationMessage');
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted, send } = mount(view, true);
    await settle(() => posted.some(m => m.type === 'thread'));
    send({ type: 'send', id: 'checkin', text: 'Is the API v2?', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'append'));
    await settle();
    expect(posted.find(m => m.type === 'append').messages.map((m: any) => [m.direction, m.text])).toEqual([['to_persona', own.text], ['from_persona', deflect.text]]);
    expect(notify).not.toHaveBeenCalled();
    expect(posted.filter(m => m.type === 'personas').at(-1).personas[0].unread).toBe(false);
    view.dispose();
  });

  it('keeps a follow-up unread and announces it when the candidate left Jordan before it arrived', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    let finish!: (r: Response) => void;
    const state = { pending: null as string | null, ticketFlow: true, post: new Promise<Response>(r => { finish = r; }) };
    route(state);
    const notify = vi.spyOn(fake.window, 'showInformationMessage');
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted, send } = mount(view, true);
    await settle(() => posted.some(m => m.type === 'thread'));
    send({ type: 'send', id: 'checkin', text: 'Two writers.', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'busy' && m.value));
    send({ type: 'select', id: 'priya', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'thread' && m.id === 'priya'));
    state.pending = 'f1';
    finish(ok({ sent: answer, reply: followUp }));
    await settle(() => notify.mock.calls.length > 0);
    expect(notify).toHaveBeenCalledWith('Jordan checked in', 'Open');
    expect(posted.filter(m => m.type === 'personas').at(-1).personas[0]).toMatchObject({ id: 'checkin', unread: true });
    view.dispose();
  });

  it('ignores a check-in reply that lands after a session switch', async () => {
    let current = session;
    vi.spyOn(config, 'readSession').mockImplementation(() => current);
    let finish!: (r: Response) => void;
    const state = { pending: 'q1' as string | null, post: new Promise<Response>(r => { finish = r; }) };
    route(state);
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted, send } = mount(view); // hidden, so nothing marks session-2's question read
    await settle(() => posted.some(m => m.type === 'thread'));
    send({ type: 'send', id: 'checkin', text: 'Two writers.', sessionId: session.sessionId });
    await settle(() => posted.some(m => m.type === 'busy' && m.value));
    current = { ...session, sessionId: 'session-2' };
    state.pending = 'q2';
    await view.refresh();
    posted.length = 0;
    finish(ok({ sent: answer, reply: ack }));
    await settle();
    // The old session's ack must not clear session-2's open question (no roster re-post, no append).
    expect(posted.filter(m => m.type === 'personas' || m.type === 'append')).toEqual([]);
    send({ type: 'select', id: 'checkin', sessionId: 'session-2' });
    await settle(() => posted.some(m => m.type === 'personas'));
    expect(posted.find(m => m.type === 'personas')).toMatchObject({ sessionId: 'session-2', personas: [{ id: 'checkin', unread: true }] });
    view.dispose();
  });

  it('defers a poll announcement while a reply to Jordan is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      vi.spyOn(config, 'readSession').mockReturnValue(session);
      let finish!: (r: Response) => void;
      const state = { pending: 'q1' as string | null, post: new Promise<Response>(r => { finish = r; }) };
      route(state);
      const notify = vi.spyOn(fake.window, 'showInformationMessage');
      const view = new TeammatesView({ subscriptions: [] } as never);
      const { posted, send } = mount(view, true);
      await settle(() => posted.some(m => m.type === 'thread'));
      expect(notify).toHaveBeenCalledTimes(1);
      send({ type: 'send', id: 'checkin', text: 'Two writers.', sessionId: session.sessionId });
      await settle(() => posted.some(m => m.type === 'busy' && m.value));
      state.pending = 'f1'; // the server saved the follow-up before the POST answered
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
      finish(ok({ sent: answer, reply: followUp }));
      await settle(() => posted.some(m => m.type === 'append'));
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
      view.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('asks again when the candidate returns to a session whose check-ins were off', async () => {
    let current = session;
    vi.spyOn(config, 'readSession').mockImplementation(() => current);
    const state = { pending: null as string | null, off: new Set([encodeURIComponent(session.sessionId)]) };
    route(state);
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted } = mount(view, true);
    await settle();
    expect(posted.some(m => m.type === 'personas')).toBe(false);
    current = { ...session, sessionId: 'session-2' };
    await view.refresh();
    state.off.clear();
    current = session;
    await view.refresh();
    await settle();
    expect(posted.filter(m => m.type === 'personas').at(-1)).toMatchObject({ sessionId: session.sessionId, personas: [{ id: 'checkin' }] });
    view.dispose();
  });

  it('puts Jordan first beside ticket-flow teammates', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue(session);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/check-ins')
      ? ok({ reviewer: jordan, messages: [], pendingCheckInId: null })
      : ok(String(url).endsWith('/messages') ? { messages: [] } : { personas: [priya] }));
    const view = new TeammatesView({ subscriptions: [] } as never);
    const { posted } = mount(view, true);
    await settle(() => posted.some(m => m.type === 'thread'));
    const roster = posted.find(m => m.type === 'personas');
    expect(roster.personas.map((p: any) => p.id)).toEqual(['checkin', 'priya']);
    expect(roster.personas[0].unread).toBe(false);
    view.dispose();
  });
});
