import * as vscode from 'vscode';
import { readSession } from '../config';
import { log } from '../utils/logger';
import type { PromptsterSession } from '../types';

export interface Persona { id: string; name: string; role: string; owns: string; avatar: string | null }
export interface Message { eventId: string; at: string; direction: 'to_persona' | 'from_persona'; kind: 'message' | 'away'; text: string }
export interface CheckInMessage { eventId: string; at: string; direction: 'from_reviewer' | 'to_reviewer'; role: 'question' | 'follow_up' | 'answer' | 'ack' | 'deflect'; checkInId: string; text: string }
export interface CheckIns { reviewer: Persona; messages: CheckInMessage[]; pendingCheckInId: string | null }

class TeammatesError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function request<T>(session: PromptsterSession, path: string, text?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${session.apiUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}${path}`, {
      method: text === undefined ? 'GET' : 'POST',
      headers: { 'X-API-Key': session.apiKey, ...(text === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: text === undefined ? undefined : JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new TeammatesError(response.status, body.error ?? 'request_failed');
    }
    return await response.json() as T;
  } finally { clearTimeout(timeout); }
}

export class TeammatesApi {
  constructor(private readonly session: PromptsterSession) {}
  list(): Promise<{ personas: Persona[] }> { return request(this.session, '/teammates'); }
  messages(id: string): Promise<{ threadId: string; messages: Message[] }> {
    return request(this.session, `/teammates/${encodeURIComponent(id)}/messages`);
  }
  send(id: string, text: string): Promise<{ threadId: string; sent: Message; reply: Message }> {
    return request(this.session, `/teammates/${encodeURIComponent(id)}/messages`, text);
  }
}

/** Mid-session check-ins (openspec mid-session-check-ins §3). A GET may materialize a due question. */
export class CheckInsApi {
  constructor(private readonly session: PromptsterSession) {}
  get(): Promise<CheckIns> { return request(this.session, '/check-ins'); }
  send(text: string): Promise<{ sent: CheckInMessage; reply: CheckInMessage | null }> { return request(this.session, '/check-ins/messages', text); }
}

/** Jordan's slot in the roster. Fixed, so it can never collide with a ticket-flow persona's thread. */
const CHECK_IN = 'checkin';
const POLL_MS = 30_000;
const asMessage = (m: CheckInMessage): Message => ({ eventId: m.eventId, at: m.at, direction: m.direction === 'to_reviewer' ? 'to_persona' : 'from_persona', kind: 'message', text: m.text });
/** Check-ins are off for the assessment, or the key is dead: stop asking until the session changes. */
const checkInsStopped = (error: unknown) => error instanceof TeammatesError && (error.code === 'check_ins_off' || error.status === 401);
type Settled<T> = { ok: T } | { error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(ok => ({ ok }), (error: unknown) => ({ error }));

type UiRequest = { type: 'select'; id: string; sessionId: string } | { type: 'send'; id: string; text: string; sessionId: string } | { type: 'refresh' };

export class TeammatesView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private personas: Persona[] = [];
  private selected?: string;
  private generation = 0;
  private busy = false;
  /** Sends answered so far; a thread read that spans one may predate its messages. */
  private sendsDone = 0;
  private nonTicketFlowSessionId?: string;
  private checkInsOffSessionId?: string;
  private currentSessionId?: string;
  /** The open check-in question, and the ones the candidate has already had on screen (the unread dot). */
  private pending?: string;
  private readonly read = new Set<string>();
  /** Check-ins already announced, so repeat polls and a follow-up received inline do not announce again. */
  private readonly announced = new Set<string>();
  /** A reply to Jordan is in flight: announcements wait for it, then a poll reconciles (its follow-up may be the new question). */
  private checkInSending = false;
  private readonly timer = setInterval(() => void this.poll(), POLL_MS);

  constructor(private readonly context: vscode.ExtensionContext) { context.subscriptions.push(this); }

  dispose(): void { clearInterval(this.timer); }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview.cspSource);
    this.context.subscriptions.push(view.webview.onDidReceiveMessage((request: UiRequest) => void this.handle(request)));
    if (view.onDidChangeVisibility) this.context.subscriptions.push(view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    }));
    if (view.onDidDispose) this.context.subscriptions.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const session = readSession();
    const switched = session?.sessionId !== this.currentSessionId;
    if (switched) {
      this.currentSessionId = session?.sessionId;
      this.personas = [];
      this.selected = undefined;
      this.busy = false;
      this.pending = undefined;
      // Stopped means stopped for that session only; returning to it asks again.
      this.checkInsOffSessionId = undefined;
      this.post({ type: 'reset', sessionId: session?.sessionId ?? null });
      await vscode.commands.executeCommand('setContext', 'promptster.ticketFlow', false);
    }
    if (!session) return;
    const id = session.sessionId;
    const [team, checkIns] = await Promise.all([
      id === this.nonTicketFlowSessionId ? undefined : settle(new TeammatesApi(session).list()),
      id === this.checkInsOffSessionId ? undefined : settle(new CheckInsApi(session).get()),
    ]);
    if (generation !== this.generation || !this.isCurrent(id)) return;
    // A transient failure on either side keeps what that side last showed.
    let failure: unknown;
    let teammates = this.personas.filter(p => p.id !== CHECK_IN);
    let reviewer = this.personas.find(p => p.id === CHECK_IN);
    if (!team || ('error' in team && team.error instanceof TeammatesError && team.error.code === 'not_ticket_flow')) {
      this.nonTicketFlowSessionId = id;
      teammates = [];
    } else if ('error' in team) failure = team.error;
    else { this.nonTicketFlowSessionId = undefined; teammates = team.ok.personas; }
    if (!checkIns || ('error' in checkIns && checkInsStopped(checkIns.error))) {
      this.checkInsOffSessionId = id;
      reviewer = undefined;
      this.pending = undefined;
      if (checkIns && 'error' in checkIns && (checkIns.error as TeammatesError).status === 401) failure ??= checkIns.error;
    } else if ('error' in checkIns) failure ??= checkIns.error;
    else { reviewer = { ...checkIns.ok.reviewer, id: CHECK_IN }; this.pending = checkIns.ok.pendingCheckInId ?? undefined; }
    this.personas = reviewer ? [reviewer, ...teammates] : teammates;
    if (!this.personas.length) {
      this.selected = undefined;
      if (failure) {
        if (switched) this.post({ type: 'reset', sessionId: id });
        this.post({ type: 'error', sessionId: id, text: errorText(failure) });
        return;
      }
      this.post({ type: 'reset', sessionId: id });
      await vscode.commands.executeCommand('setContext', 'promptster.ticketFlow', false);
      return;
    }
    this.selected = this.personas.some(p => p.id === this.selected) ? this.selected : this.personas[0].id;
    // The view's `when` clause: ticket-flow teammates, check-ins, or both.
    await vscode.commands.executeCommand('setContext', 'promptster.ticketFlow', true);
    if (!this.isCurrent(id)) return;
    if (checkIns && 'ok' in checkIns) this.announce(id, checkIns.ok);
    this.postPersonas(id);
    // A reloaded webview starts idle; tell it a send is still in flight.
    if (this.busy) this.post({ type: 'busy', sessionId: id, value: true });
    this.post({ type: 'busy', sessionId: id, value: this.busy });
    if (failure) this.post({ type: 'error', sessionId: id, text: errorText(failure) });
    if (this.selected) await this.load(this.selected);
  }

  /** Every 30s: materializes a due check-in server-side and announces it. Only the check-in endpoint is polled. */
  private async poll(): Promise<void> {
    const session = readSession();
    if (!session) return;
    if (session.sessionId !== this.currentSessionId) return this.refresh();
    if (session.sessionId === this.checkInsOffSessionId) return;
    if (!this.personas.some(p => p.id === CHECK_IN)) return this.refresh();
    const sendsBefore = this.sendsDone;
    try {
      const data = await new CheckInsApi(session).get();
      if (!this.isCurrent(session.sessionId) || !this.personas.some(p => p.id === CHECK_IN)) return;
      this.pending = data.pendingCheckInId ?? undefined;
      this.personas = this.personas.map(p => p.id === CHECK_IN ? { ...data.reviewer, id: CHECK_IN } : p);
      this.announce(session.sessionId, data);
      if (this.selected === CHECK_IN && this.sendsDone === sendsBefore) {
        this.markRead();
        this.post({ type: 'thread', sessionId: session.sessionId, id: CHECK_IN, messages: data.messages.map(asMessage) });
      }
      this.postPersonas(session.sessionId);
    } catch (error) {
      if (!this.isCurrent(session.sessionId) || !checkInsStopped(error)) return;
      this.checkInsOffSessionId = session.sessionId;
      void this.refresh(); // drops Jordan from the roster
    }
  }

  /** A new open question: put the view on screen without moving keyboard focus, and say so once. */
  private announce(sessionId: string, data: CheckIns): void {
    const pending = data.pendingCheckInId;
    if (!pending || this.announced.has(pending) || this.checkInSending) return;
    this.announced.add(pending);
    // Never yank the thread out from under a candidate who is already in the panel; they will see the dot.
    if (!this.view?.visible && !this.busy) this.selected = CHECK_IN;
    void this.reveal();
    void Promise.resolve(vscode.window.showInformationMessage(`${data.reviewer.name} checked in`, 'Open')).then(choice => {
      if (choice === 'Open' && this.isCurrent(sessionId)) void this.open();
    });
  }

  private async reveal(): Promise<void> {
    try {
      // show(true) = preserveFocus. The candidate may be typing in the terminal.
      if (this.view) this.view.show(true);
      // Never resolved (sidebar closed, or another container showing): the workbench's generated `<view>.focus`
      // command takes { preserveFocus } and opens the container around the view without focusing it.
      else await vscode.commands.executeCommand('promptster.teammates.focus', { preserveFocus: true });
    } catch (error) { log(`Could not reveal the Teammates view: ${String(error)}`); }
  }

  /** The notification's Open: the candidate asked, so focus is theirs to move. */
  private async open(): Promise<void> {
    if (!this.busy) this.selected = CHECK_IN;
    try { await vscode.commands.executeCommand('promptster.teammates.focus'); } catch (error) { log(`Could not open the Teammates view: ${String(error)}`); }
    if (this.selected === CHECK_IN) await this.load(CHECK_IN);
  }

  private markRead(): void {
    if (this.pending && this.view?.visible) this.read.add(this.pending);
  }

  private postPersonas(sessionId: string): void {
    const unread = !!this.pending && !this.read.has(this.pending);
    this.post({ type: 'personas', sessionId, personas: this.personas.map(p => ({ ...p, avatarUrl: this.avatarUrl(p.avatar), checkIn: p.id === CHECK_IN, unread: p.id === CHECK_IN && unread })), selected: this.selected });
  }

  private isCurrent(sessionId: string): boolean {
    return this.currentSessionId === sessionId && readSession()?.sessionId === sessionId;
  }

  private async load(id: string): Promise<void> {
    const session = readSession();
    if (!session || !this.isCurrent(session.sessionId) || !this.personas.some(p => p.id === id)) return;
    this.selected = id;
    this.post({ type: 'selected', sessionId: session.sessionId, id });
    try {
      const sendsBefore = this.sendsDone;
      const messages = id === CHECK_IN ? (await new CheckInsApi(session).get()).messages.map(asMessage) : (await new TeammatesApi(session).messages(id)).messages;
      if (!this.isCurrent(session.sessionId) || this.selected !== id) return;
      if (this.sendsDone !== sendsBefore) return this.load(id);
      this.post({ type: 'thread', sessionId: session.sessionId, id, messages });
      if (id === CHECK_IN && this.pending && !this.read.has(this.pending)) {
        this.markRead();
        this.postPersonas(session.sessionId);
      }
    } catch (error) {
      if (this.isCurrent(session.sessionId)) this.post({ type: 'error', sessionId: session.sessionId, text: errorText(error) });
    }
  }

  private async handle(request: UiRequest): Promise<void> {
    if (request.type === 'refresh') return this.refresh();
    if (!this.isCurrent(request.sessionId)) return;
    if (request.type === 'select') return this.load(request.id);
    if (this.busy || request.id !== this.selected || !this.personas.some(p => p.id === request.id)) return;
    const text = request.text?.trim();
    if (!text || text.length > 4000) return;
    const session = readSession();
    if (!session || session.sessionId !== request.sessionId) return;
    this.busy = true;
    this.post({ type: 'busy', sessionId: session.sessionId, value: true });
    try {
      let messages: Message[];
      if (request.id === CHECK_IN) {
        this.checkInSending = true;
        const { sent, reply } = await new CheckInsApi(session).send(text).finally(() => { this.checkInSending = false; });
        if (!this.isCurrent(session.sessionId)) return;
        // A follow-up's eventId is the new pendingCheckInId. Shown inline in the thread the candidate is in: seen, never
        // announced. If they left Jordan's thread before it arrived, it stays unread and the poll below announces it.
        // An ack or a deflect (a message with no open question) leaves nothing pending.
        this.pending = reply?.role === 'follow_up' ? reply.eventId : undefined;
        if (reply?.role === 'follow_up' && this.selected === CHECK_IN && this.view?.visible) { this.read.add(reply.eventId); this.announced.add(reply.eventId); }
        messages = [sent, ...(reply ? [reply] : [])].map(asMessage);
      } else {
        const result = await new TeammatesApi(session).send(request.id, text);
        messages = [result.sent, result.reply];
      }
      this.sendsDone++;
      if (this.isCurrent(session.sessionId) && request.id === CHECK_IN) this.postPersonas(session.sessionId);
      if (this.isCurrent(session.sessionId) && this.selected === request.id) this.post({ type: 'append', sessionId: session.sessionId, id: request.id, messages });
    } catch (error) {
      if (!this.isCurrent(session.sessionId)) return;
      if (error instanceof TeammatesError && error.status === 503) {
        await this.load(request.id); // The server recorded the sent message before the model failed.
        if (this.isCurrent(session.sessionId)) this.post({ type: 'error', sessionId: session.sessionId, text: 'Your message was sent but not answered. Try again.' });
      } else this.post({ type: 'error', sessionId: session.sessionId, text: errorText(error) });
    } finally {
      if (this.isCurrent(session.sessionId)) {
        this.busy = false;
        this.post({ type: 'busy', sessionId: session.sessionId, value: false });
        if (request.id === CHECK_IN) void this.poll();
      }
    }
  }

  private avatarUrl(avatar: string | null): string | null {
    // ponytail: every new problem avatar needs an extension release; upgrade to server-served avatar URLs.
    if (!this.view || !avatar || !['dana.svg', 'priya.svg'].includes(avatar)) return null;
    return this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'teammates', avatar)).toString();
  }

  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
}

function errorText(error: unknown): string {
  if (error instanceof TeammatesError) {
    if (error.status === 401) return 'Session expired. Reopen the assessment to continue.';
    if (error.status === 429) return 'Too many messages. Wait a moment and try again.';
  }
  return 'Could not reach teammates. Try again.';
}

function html(cspSource: string): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;"><style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px var(--vscode-font-family)}button,textarea{font:inherit}button{cursor:pointer}.people{border-bottom:1px solid var(--vscode-panel-border)}.person{display:flex;width:100%;gap:10px;text-align:left;border:0;border-bottom:1px solid var(--vscode-panel-border);background:transparent;color:inherit;padding:12px 14px}.person:hover,.person.active{background:var(--vscode-list-hoverBackground)}.person.active{box-shadow:inset 2px 0 var(--vscode-focusBorder)}.face{width:28px;height:28px;flex:none;border-radius:5px;display:grid;place-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:10px;font-weight:700}.person strong{display:block;font-weight:600}.person small{display:block;color:var(--vscode-descriptionForeground);line-height:1.45;margin-top:2px}.thread-head{padding:12px 14px;border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.messages{padding:16px 14px;overflow:auto;min-height:110px;max-height:calc(100vh - 280px)}.message{display:flex;gap:9px;margin:0 0 17px}.message .body{min-width:0;flex:1}.meta{display:flex;gap:7px;align-items:baseline;margin-bottom:4px}.meta time{color:var(--vscode-descriptionForeground);font-size:11px}.text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}.mine .text{background:var(--vscode-editor-inactiveSelectionBackground);border-radius:5px;padding:8px}.away .text{font-style:italic;color:var(--vscode-descriptionForeground)}.away-tag{color:var(--vscode-editorWarning-foreground);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.composer{padding:12px 14px;border-top:1px solid var(--vscode-panel-border)}textarea{display:block;width:100%;min-height:56px;resize:vertical;border:1px solid var(--vscode-input-border);border-radius:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:9px}.actions{display:flex;justify-content:space-between;align-items:center;margin-top:8px;color:var(--vscode-descriptionForeground);font-size:11px}.actions button{border:0;border-radius:3px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:6px 13px}.actions button:disabled{opacity:.5;cursor:default}.notice{padding:10px 14px;color:var(--vscode-errorForeground)}.empty{color:var(--vscode-descriptionForeground);line-height:1.5}.dot{width:8px;height:8px;flex:none;align-self:center;margin-left:auto;border-radius:50%;background:var(--vscode-notificationsInfoIcon-foreground,var(--vscode-focusBorder))}
  </style></head><body><div id="people" class="people"></div><div id="head" class="thread-head"></div><div id="messages" class="messages"><p class="empty">Choose a teammate to start a conversation.</p></div><div class="composer"><textarea id="draft" aria-label="Message teammate" placeholder="Ask a question…" maxlength="4000"></textarea><div class="actions"><span id="status">Enter to send · Shift+Enter for newline</span><button id="send" type="button">Send</button></div></div><div id="notice" class="notice" role="status"></div><script nonce="${nonce}">
  const vscode=acquireVsCodeApi();let personas=[],selected=null,busy=false,sessionId=null;const el=id=>document.getElementById(id);const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node};const person=()=>personas.find(p=>p.id===selected);function relative(at){const seconds=Math.max(0,Math.floor((Date.now()-new Date(at).getTime())/1000));if(seconds<60)return 'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';return new Date(at).toLocaleDateString()}
  function face(p){if(p?.avatarUrl){const img=document.createElement('img');img.src=p.avatarUrl;img.alt=p.name;img.className='face';return img}return text('span',p?.name.split(/\\s+/).map(x=>x[0]).slice(0,2).join('')||'?','face')}function renderPeople(){el('people').replaceChildren();for(const p of personas){const button=text('button','','person'+(p.id===selected?' active':''));button.type='button';button.append(face(p));const info=document.createElement('span');info.append(text('strong',p.name),text('small',p.role+' · '+p.owns));button.append(info);if(p.unread){const dot=text('span','','dot');dot.title='New check-in';dot.setAttribute('aria-label','New check-in');button.append(dot)}button.onclick=()=>vscode.postMessage({type:'select',id:p.id,sessionId});el('people').append(button)}}
  function heading(){el('head').textContent=person()?.name||'Teammates';el('draft').placeholder=person()?.checkIn?'Reply to '+person().name+'…':'Ask a question…'}function renderMessages(messages){el('messages').replaceChildren();if(!messages.length)el('messages').append(text('p',person()?.checkIn?person().name+' will check in here during the session.':'Ask '+(person()?.name||'your teammate')+' about the ticket.','empty'));for(const m of messages){const mine=m.direction==='to_persona';const row=text('article','','message'+(mine?' mine':'')+(m.kind==='away'?' away':''));row.append(mine?text('span','YOU','face'):face(person()));const body=text('div','','body'),meta=text('div','','meta');meta.append(text('strong',mine?'You':person()?.name||'Teammate'),text('time',relative(m.at)));if(m.kind==='away')meta.append(text('span','Away','away-tag'));body.append(meta,text('div',m.text,'text'));row.append(body);el('messages').append(row)}el('messages').scrollTop=el('messages').scrollHeight}
  let threads={};function clear(nextSessionId){sessionId=nextSessionId;personas=[];selected=null;busy=false;threads={};el('draft').value='';el('notice').textContent='';el('people').replaceChildren();el('head').textContent='';el('send').disabled=false;el('status').textContent='Enter to send · Shift+Enter for newline';renderMessages([])}function send(){const value=el('draft').value.trim();if(!selected||busy||!value)return;vscode.postMessage({type:'send',id:selected,text:value,sessionId});el('draft').value='';el('notice').textContent=''}el('send').onclick=send;el('draft').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};window.addEventListener('message',({data})=>{if(data.type==='reset'){clear(data.sessionId);return}if(data.sessionId!==sessionId)clear(data.sessionId);if(data.type==='personas'){personas=data.personas;selected=data.selected;renderPeople();heading();renderMessages(threads[selected]||[])}if(data.type==='selected'){selected=data.id;renderPeople();heading();renderMessages(threads[selected]||[])}if(data.type==='thread'){threads[data.id]=data.messages;if(selected===data.id)renderMessages(data.messages)}if(data.type==='append'){const seen=new Set((threads[data.id]||[]).map(m=>m.eventId));threads[data.id]=[...(threads[data.id]||[]),...data.messages.filter(m=>!seen.has(m.eventId))];if(selected===data.id)renderMessages(threads[data.id])}if(data.type==='busy'){busy=data.value;el('send').disabled=busy;el('status').textContent=busy?'Waiting for reply…':'Enter to send · Shift+Enter for newline'}if(data.type==='error')el('notice').textContent=data.text});
  vscode.postMessage({type:'refresh'});
  </script></body></html>`;
}
