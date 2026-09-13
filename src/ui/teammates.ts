import * as vscode from 'vscode';
import { readSession } from '../config';
import type { PromptsterSession } from '../types';

export interface Persona { id: string; name: string; role: string; owns: string; avatar: string | null }
export interface Message { eventId: string; at: string; direction: 'to_persona' | 'from_persona'; kind: 'message' | 'away'; text: string }

class TeammatesError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export class TeammatesApi {
  constructor(private readonly session: PromptsterSession) {}

  private async request<T>(path: string, text?: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.session.apiUrl}/v1/sessions/${encodeURIComponent(this.session.sessionId)}/teammates${path}`, {
        method: text === undefined ? 'GET' : 'POST',
        headers: { 'X-API-Key': this.session.apiKey, ...(text === undefined ? {} : { 'Content-Type': 'application/json' }) },
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

  list(): Promise<{ personas: Persona[] }> { return this.request(''); }
  messages(id: string): Promise<{ threadId: string; messages: Message[] }> {
    return this.request(`/${encodeURIComponent(id)}/messages`);
  }
  send(id: string, text: string): Promise<{ threadId: string; sent: Message; reply: Message }> {
    return this.request(`/${encodeURIComponent(id)}/messages`, text);
  }
}

type UiRequest = { type: 'select'; id: string } | { type: 'send'; id: string; text: string } | { type: 'refresh' };

export class TeammatesView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private personas: Persona[] = [];
  private selected?: string;
  private generation = 0;
  private busy = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview.cspSource);
    this.context.subscriptions.push(view.webview.onDidReceiveMessage((request: UiRequest) => void this.handle(request)));
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const session = readSession();
    if (!session) { this.personas = []; this.selected = undefined; await vscode.commands.executeCommand('setContext', 'promptster.ticketFlow', false); return; }
    try {
      const { personas } = await new TeammatesApi(session).list();
      if (generation !== this.generation) return;
      this.personas = personas;
      this.selected = personas.some(p => p.id === this.selected) ? this.selected : personas[0]?.id;
      await vscode.commands.executeCommand('setContext', 'promptster.ticketFlow', true);
      this.post({ type: 'personas', personas: personas.map(p => ({ ...p, avatarUrl: this.avatarUrl(p.avatar) })), selected: this.selected });
      if (this.selected) await this.load(this.selected);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof TeammatesError && error.code === 'not_ticket_flow') {
        this.personas = []; this.selected = undefined;
        await vscode.commands.executeCommand('setContext', 'promptster.ticketFlow', false);
      } else this.post({ type: 'error', text: errorText(error) });
    }
  }

  private async load(id: string): Promise<void> {
    const session = readSession();
    if (!session || !this.personas.some(p => p.id === id)) return;
    this.selected = id;
    this.post({ type: 'selected', id });
    try {
      const thread = await new TeammatesApi(session).messages(id);
      if (this.selected === id) this.post({ type: 'thread', id, messages: thread.messages });
    } catch (error) { this.post({ type: 'error', text: errorText(error) }); }
  }

  private async handle(request: UiRequest): Promise<void> {
    if (request.type === 'refresh') return this.refresh();
    if (request.type === 'select') return this.load(request.id);
    if (request.type !== 'send' || this.busy || request.id !== this.selected || !this.personas.some(p => p.id === request.id)) return;
    const text = request.text?.trim();
    if (!text || text.length > 4000) return;
    const session = readSession();
    if (!session) return;
    this.busy = true;
    this.post({ type: 'busy', value: true });
    try {
      const result = await new TeammatesApi(session).send(request.id, text);
      if (this.selected === request.id) this.post({ type: 'append', id: request.id, messages: [result.sent, result.reply] });
    } catch (error) {
      if (error instanceof TeammatesError && error.status === 503) {
        await this.load(request.id); // The server recorded the sent message before the model failed.
        this.post({ type: 'error', text: 'Your message was sent but not answered. Try again.' });
      } else this.post({ type: 'error', text: errorText(error) });
    } finally { this.busy = false; this.post({ type: 'busy', value: false }); }
  }

  private avatarUrl(avatar: string | null): string | null {
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
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px var(--vscode-font-family)}button,textarea{font:inherit}button{cursor:pointer}.people{border-bottom:1px solid var(--vscode-panel-border)}.person{display:flex;width:100%;gap:10px;text-align:left;border:0;border-bottom:1px solid var(--vscode-panel-border);background:transparent;color:inherit;padding:12px 14px}.person:hover,.person.active{background:var(--vscode-list-hoverBackground)}.person.active{box-shadow:inset 2px 0 var(--vscode-focusBorder)}.face{width:28px;height:28px;flex:none;border-radius:5px;display:grid;place-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:10px;font-weight:700}.person strong{display:block;font-weight:600}.person small{display:block;color:var(--vscode-descriptionForeground);line-height:1.45;margin-top:2px}.thread-head{padding:12px 14px;border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.messages{padding:16px 14px;overflow:auto;min-height:110px;max-height:calc(100vh - 280px)}.message{display:flex;gap:9px;margin:0 0 17px}.message .body{min-width:0;flex:1}.meta{display:flex;gap:7px;align-items:baseline;margin-bottom:4px}.meta time{color:var(--vscode-descriptionForeground);font-size:11px}.text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}.mine .text{background:var(--vscode-editor-inactiveSelectionBackground);border-radius:5px;padding:8px}.away .text{font-style:italic;color:var(--vscode-descriptionForeground)}.away-tag{color:var(--vscode-editorWarning-foreground);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.composer{padding:12px 14px;border-top:1px solid var(--vscode-panel-border)}textarea{display:block;width:100%;min-height:56px;resize:vertical;border:1px solid var(--vscode-input-border);border-radius:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:9px}.actions{display:flex;justify-content:space-between;align-items:center;margin-top:8px;color:var(--vscode-descriptionForeground);font-size:11px}.actions button{border:0;border-radius:3px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:6px 13px}.actions button:disabled{opacity:.5;cursor:default}.notice{padding:10px 14px;color:var(--vscode-errorForeground)}.empty{color:var(--vscode-descriptionForeground);line-height:1.5}
  </style></head><body><div id="people" class="people"></div><div id="head" class="thread-head"></div><div id="messages" class="messages"><p class="empty">Choose a teammate to start a conversation.</p></div><div class="composer"><textarea id="draft" aria-label="Message teammate" placeholder="Ask a question…" maxlength="4000"></textarea><div class="actions"><span id="status">Enter to send · Shift+Enter for newline</span><button id="send" type="button">Send</button></div></div><div id="notice" class="notice" role="status"></div><script nonce="${nonce}">
  const vscode=acquireVsCodeApi();let personas=[],selected=null,busy=false;const el=id=>document.getElementById(id);const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node};const person=()=>personas.find(p=>p.id===selected);function relative(at){const seconds=Math.max(0,Math.floor((Date.now()-new Date(at).getTime())/1000));if(seconds<60)return 'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';return new Date(at).toLocaleDateString()}
  function face(p){if(p?.avatarUrl){const img=document.createElement('img');img.src=p.avatarUrl;img.alt=p.name;img.className='face';return img}return text('span',p?.name.split(/\\s+/).map(x=>x[0]).slice(0,2).join('')||'?','face')}function renderPeople(){el('people').replaceChildren();for(const p of personas){const button=text('button','','person'+(p.id===selected?' active':''));button.type='button';button.append(face(p));const info=document.createElement('span');info.append(text('strong',p.name),text('small',p.role+' · '+p.owns));button.append(info);button.onclick=()=>vscode.postMessage({type:'select',id:p.id});el('people').append(button)}}
  function renderMessages(messages){el('messages').replaceChildren();if(!messages.length)el('messages').append(text('p','Ask '+(person()?.name||'your teammate')+' about the ticket.','empty'));for(const m of messages){const mine=m.direction==='to_persona';const row=text('article','','message'+(mine?' mine':'')+(m.kind==='away'?' away':''));row.append(mine?text('span','YOU','face'):face(person()));const body=text('div','','body'),meta=text('div','','meta');meta.append(text('strong',mine?'You':person()?.name||'Teammate'),text('time',relative(m.at)));if(m.kind==='away')meta.append(text('span','Away','away-tag'));body.append(meta,text('div',m.text,'text'));row.append(body);el('messages').append(row)}el('messages').scrollTop=el('messages').scrollHeight}
  const threads={};function send(){const value=el('draft').value.trim();if(!selected||busy||!value)return;vscode.postMessage({type:'send',id:selected,text:value});el('draft').value='';el('notice').textContent=''}el('send').onclick=send;el('draft').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};window.addEventListener('message',({data})=>{if(data.type==='personas'){personas=data.personas;selected=data.selected;renderPeople();el('head').textContent=person()?.name||'Teammates';renderMessages(threads[selected]||[])}if(data.type==='selected'){selected=data.id;renderPeople();el('head').textContent=person()?.name||'Teammates';renderMessages(threads[selected]||[])}if(data.type==='thread'){threads[data.id]=data.messages;if(selected===data.id)renderMessages(data.messages)}if(data.type==='append'){threads[data.id]=[...(threads[data.id]||[]),...data.messages];if(selected===data.id)renderMessages(threads[data.id])}if(data.type==='busy'){busy=data.value;el('send').disabled=busy;el('status').textContent=busy?'Waiting for reply…':'Enter to send · Shift+Enter for newline'}if(data.type==='error')el('notice').textContent=data.text});
  </script></body></html>`;
}
