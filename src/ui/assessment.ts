import * as vscode from 'vscode';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { renderTicket } from './ticket';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readSession, isExpired } from '../config';
import type { PromptsterSession } from '../types';

/** `specFile` is absent for a plain (non-ticket) problem: there is no handoff to open. */
interface WorkspaceBrief { id: string; title: string; specFile?: string }
const SPEC_FILE = /^[a-zA-Z0-9_-]+\.spec$/;
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;
/** The terminal the hosted auto-launch opens (src/extension.ts). */
export const AUTO_TERMINAL_NAME = 'Promptster Assessment';

/**
 * The session's live agent terminal for `tool`, if one exists in this window.
 *
 * A terminal created in this window carries its session and tool in
 * `creationOptions.env`. One RESTORED into a new window (the candidate reopened
 * the box from another browser) comes back with its name but without that env,
 * so on a HOSTED session it is matched by name: the view's per-tool name, or
 * the auto-launch's, which always runs the session's preferred tool. Missing it
 * meant the button started a second agent beside the restored one. A hosted box
 * only ever holds one session, so a name cannot belong to another; a local
 * editor can switch sessions with old terminals still open, so it never
 * matches by name.
 */
export function findAgentTerminal(session: Pick<PromptsterSession, 'sessionId' | 'tools' | 'hosted'>, tool: 'claude' | 'codex'): vscode.Terminal | undefined {
  const { sessionId, tools } = session;
  const autoTool = tools.includes('claude') ? 'claude' : 'codex';
  return vscode.window.terminals?.find(candidate => {
    if (candidate.exitStatus) return false;
    const env = (candidate.creationOptions as vscode.TerminalOptions | undefined)?.env;
    if (env?.PROMPTSTER_TERMINAL_SESSION_ID) {
      return env.PROMPTSTER_TERMINAL_SESSION_ID === sessionId && env.PROMPTSTER_TERMINAL_TOOL === tool;
    }
    if (!session.hosted) return false;
    return candidate.name === TOOL_NAMES[tool] || (candidate.name === AUTO_TERMINAL_NAME && tool === autoTool);
  });
}

export function parseWorkspaceBrief(raw: unknown): WorkspaceBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.specFile !== 'string') return null;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || !value.title.trim() || value.title.length > 300 || !SPEC_FILE.test(value.specFile)) return null;
  return { id: value.id, title: value.title, specFile: value.specFile };
}

function briefAt(root: string): WorkspaceBrief | null {
  try { return parseWorkspaceBrief(JSON.parse(readFileSync(join(root, 'assessment.json'), 'utf8'))); }
  catch { return null; }
}

/**
 * The brief for a hosted box, which has no `assessment.json`.
 *
 * Nothing in the hosted lane writes `assessment.json` — not provisioning, not
 * ARM, not `promptster start --seeded` — so gating the view on it alone meant
 * `promptster.assessmentWorkspace` was false on every hosted box and the
 * candidate never saw "Review & submit". ARM's session already carries the
 * title and problem key; a root-level `<key>.spec` (the ticket-flow stub
 * provisioning seeds) is the handoff when there is exactly one.
 */
export function hostedBrief(root: string, session: PromptsterSession | null): WorkspaceBrief | null {
  if (!session?.hosted) return null;
  const title = session.assessmentTitle?.trim();
  if (!title || title.length > 300) return null;
  const id = session.issueId && /^[a-zA-Z0-9-]{1,80}$/.test(session.issueId) ? session.issueId : '';
  let specs: string[] = [];
  try { specs = readdirSync(root).filter(name => SPEC_FILE.test(name)); } catch { /* no root, no spec */ }
  return specs.length === 1 ? { id, title, specFile: specs[0] } : { id, title };
}

function workspaceBrief(root: string | undefined, session: PromptsterSession | null): WorkspaceBrief | null {
  return root ? briefAt(root) ?? hostedBrief(root, session) : null;
}

/** Open TASK.md rendered. Falls back to the source if the markdown preview is unavailable. */
export async function openTaskMd(root: string): Promise<void> {
  const uri = vscode.Uri.file(join(root, 'TASK.md'));
  if (!existsSync(uri.fsPath)) return;
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  }
}

/** Native navigation only. No extra model API, credentials, or teammate transcript export. */
export class AssessmentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private terminals = new Map<string, vscode.Terminal>();
  /** A submit is awaiting confirmation or saving; a second click must not start another. */
  private submitting = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
      for (const [key, value] of this.terminals) if (value === terminal) this.terminals.delete(key);
    }));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    this.context.subscriptions.push(view.webview.onDidReceiveMessage(request => void this.handle(request)));
    this.refresh();
  }
  refresh(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const session = readSession();
    const brief = workspaceBrief(root, session);
    const ready = !!(brief && session?.consentAccepted && !isExpired(session));
    void vscode.commands.executeCommand('setContext', 'promptster.assessmentWorkspace', ready);
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'state', brief: ready ? brief : null, sessionId: ready ? session!.sessionId : null,
      tools: ready ? [...new Set(session!.tools)].map(id => ({ id, name: TOOL_NAMES[id] })) : [],
    });
  }
  trackTool(sessionId: string, tool: 'claude' | 'codex', terminal: vscode.Terminal): void {
    this.terminals.set(`${sessionId}:${tool}`, terminal);
  }
  /**
   * A restore the extension is still waiting on. A click that lands first must
   * wait for it, or it starts a second agent beside the one being restored.
   */
  awaitRestore(restore: Promise<unknown>): void {
    const pending = restore.finally(() => { if (this.pendingRestore === pending) this.pendingRestore = undefined; });
    this.pendingRestore = pending;
  }
  private pendingRestore?: Promise<unknown>;
  private async handle(request: { type?: unknown; action?: unknown; sessionId?: unknown; tool?: unknown }): Promise<void> {
    if (request.type === 'ready') { this.refresh(); return; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const session = readSession();
    const brief = workspaceBrief(root, session);
    if (!root || !brief || !session?.consentAccepted || isExpired(session) || request.sessionId !== session.sessionId) return;
    try {
      if (request.action === 'ticket') {
        const specFile = brief.specFile;
        if (!specFile) { await openTaskMd(root); return; }
        const path = join(root, 'TASK.html');
        if (!existsSync(path)) writeFileSync(path, renderTicket(readFileSync(join(root, 'TASK.md'), 'utf8'), { ...brief, specFile }), { flag: 'wx' });
        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path), 'promptster.ticket');
      } else if (request.action === 'handoff') {
        if (!brief.specFile) return;
        const uri = vscode.Uri.file(join(root, brief.specFile));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
      } else if (request.action === 'tool') {
        const tool = request.tool;
        if ((tool !== 'claude' && tool !== 'codex') || !session.tools.includes(tool)) return;
        const key = `${session.sessionId}:${tool}`;
        let terminal = this.terminals.get(key) ?? findAgentTerminal(session, tool);
        if (!terminal && this.pendingRestore) {
          await this.pendingRestore;
          terminal = this.terminals.get(key) ?? findAgentTerminal(session, tool);
        }
        if (!terminal) {
          terminal = vscode.window.createTerminal({ name: TOOL_NAMES[tool], cwd: root, env: { PROMPTSTER_TERMINAL_SESSION_ID: session.sessionId, PROMPTSTER_TERMINAL_TOOL: tool } });
          this.terminals.set(key, terminal);
          terminal.sendText(tool === 'codex' ? 'promptster codex' : 'claude', true);
        }
        terminal.show();
      } else if (request.action === 'submit') {
        // Keep the established CLI confirmation/upload flow; do not fake completion.
        const key = `${session.sessionId}:submit`;
        let terminal = this.terminals.get(key);
        if (!terminal) {
          if (this.submitting) return;
          this.submitting = true;
          try {
            const accepted = await vscode.window.showWarningMessage('Review and submit this assessment? The submission command will guide you through the final steps.', { modal: true }, 'Review submission');
            if (accepted !== 'Review submission') return;
            const current = readSession();
            if (!current?.consentAccepted || current.sessionId !== session.sessionId || isExpired(current)) return;
            if (!await vscode.workspace.saveAll(false)) throw new Error('Some files could not be saved. Save them before submitting.');
            terminal = vscode.window.createTerminal({ name: 'Assessment submission', cwd: root });
            this.terminals.set(key, terminal);
            terminal.sendText('promptster done', true);
          } finally {
            this.submitting = false;
          }
        }
        terminal.show();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open assessment action: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function html(): string {
  const nonce = randomBytes(18).toString('hex');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:12px/1.6 var(--vscode-font-family)}main{padding:16px}.label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}h1{font-size:17px;line-height:1.35;font-weight:600;margin:9px 0 20px}button{font:inherit;text-align:left;cursor:pointer;width:100%;padding:9px 11px;margin:0 0 8px;border-radius:3px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);color:var(--vscode-foreground)}button:hover{background:var(--vscode-list-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder)}section{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--vscode-panel-border)}p{color:var(--vscode-descriptionForeground);font-size:11px;margin:6px 0 12px}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.primary:hover{background:var(--vscode-button-hoverBackground)}[hidden]{display:none!important}
  </style></head><body><main><div id="empty">Open your assessment to begin.</div><div id="content" hidden><div id="key" class="label"></div><h1 id="title"></h1><button id="ticket">Open ticket</button><button id="handoff">Open handoff</button><section><div class="label">Coding tool</div><p>Enabled by the hiring company. Opens in your integrated terminal.</p><div id="tools"></div></section><section><div class="label">Finish your work</div><p>Save your work, then review your submission.</p><button id="submit" class="primary">Review &amp; submit</button></section></div></main><script nonce="${nonce}">
  const api=acquireVsCodeApi(),el=id=>document.getElementById(id);let sessionId=null;const act=(action,tool)=>api.postMessage({action,tool,sessionId});el('ticket').onclick=()=>act('ticket');el('handoff').onclick=()=>act('handoff');el('submit').onclick=()=>act('submit');window.addEventListener('message',({data})=>{if(data.type!=='state')return;sessionId=data.sessionId;el('content').hidden=!data.brief;el('empty').hidden=!!data.brief;el('tools').replaceChildren();if(!data.brief)return;el('key').textContent=data.brief.id;el('title').textContent=data.brief.title;el('ticket').textContent=data.brief.specFile?'Open ticket':'Open task';el('handoff').hidden=!data.brief.specFile;el('handoff').textContent='Open '+(data.brief.specFile||'');for(const tool of data.tools){const b=document.createElement('button');b.textContent='Open '+tool.name;b.onclick=()=>act('tool',tool.id);el('tools').append(b)}if(!data.tools.length)el('tools').textContent='No coding tool is enabled for this session.'});api.postMessage({type:'ready'});
  </script></body></html>`;
}
