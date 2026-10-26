import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import * as config from '../../src/config';
import { fromJson } from '../../src/config';
vi.mock('vscode', () => import('../fakes/vscode'));
import { state, resetState } from '../fakes/vscode';
import { AssessmentView, parseWorkspaceBrief, hostedBrief } from '../../src/ui/assessment';
let root: string;
const session = fromJson({apiUrl:'https://api.example.test',sessionToken:'test',sessionId:'s1',tools:['codex'],consentAccepted:true,noSelfEvict:true},'.promptster/session.json')!;
let receive: (request: unknown) => Promise<void>;
function view() {
  const instance = new AssessmentView({subscriptions:[]} as never);
  instance.resolveWebviewView({webview:{options:{},html:'',postMessage:vi.fn(),onDidReceiveMessage:(fn: typeof receive)=>{receive=fn;return {dispose(){}}}}} as never);
  return instance;
}
beforeEach(()=>{vi.restoreAllMocks();resetState();root=mkdtempSync(join(tmpdir(),'assessment-view-'));state.workspaceRoot=root;writeFileSync(join(root,'assessment.json'),JSON.stringify({id:'INV-907',title:'Inventory incident',specFile:'INV-907.spec'}));vi.spyOn(config,'readSession').mockReturnValue(session)});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
describe('native assessment actions',()=>{
  it('creates a rendered HTML ticket without overwriting source or an existing HTML file', async () => {
    const source = '# Ticket\n\nOriginal notes <script>bad()</script>';
    writeFileSync(join(root, 'TASK.md'), source);
    const open = vi.spyOn(vscode.commands, 'executeCommand');
    view(); await receive({ action: 'ticket', sessionId: 's1' });
    expect(open).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: join(root, 'TASK.html') }), 'promptster.ticket');
    expect(readFileSync(join(root, 'TASK.html'), 'utf8')).toContain('&lt;script&gt;');
    expect(readFileSync(join(root, 'TASK.md'), 'utf8')).toBe(source);
    writeFileSync(join(root, 'TASK.html'), '<p>Candidate notes</p>');
    await receive({ action: 'ticket', sessionId: 's1' });
    expect(readFileSync(join(root, 'TASK.html'), 'utf8')).toBe('<p>Candidate notes</p>');
  });
  it('launches the permitted native tool once, then focuses its terminal',async()=>{view();await receive({action:'tool',tool:'codex',sessionId:'s1'});await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(1);expect(state.terminals[0].commands).toEqual(['promptster codex']);expect(state.terminals[0].shown).toBe(true)});
  it('focuses the agent terminal launched by the existing session lifecycle', async () => {
    const instance = view();
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    instance.trackTool('s1', 'codex', terminal as never);
    await receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(state.terminals).toHaveLength(0);
  });
  it('does not submit if consent changes while confirmation is open', async () => {
    view();
    const window = vscode.window as unknown as Record<string, unknown>;
    const previous = window.showWarningMessage;
    window.showWarningMessage = vi.fn(async () => {
      vi.spyOn(config, 'readSession').mockReturnValue({ ...session, consentAccepted: false });
      return 'Review submission';
    });
    try {
      await receive({ action: 'submit', sessionId: 's1' });
      expect(state.terminals).toHaveLength(0);
    } finally {
      if (previous === undefined) delete window.showWarningMessage;
      else window.showWarningMessage = previous;
    }
  });
  it('opens one submission flow for a double-click', async () => {
    view();
    const window = vscode.window as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const previous = [window.showWarningMessage, workspace.saveAll];
    window.showWarningMessage = vi.fn(async () => 'Review submission');
    workspace.saveAll = vi.fn(async () => true);
    try {
      await Promise.all([receive({ action: 'submit', sessionId: 's1' }), receive({ action: 'submit', sessionId: 's1' })]);
      expect(state.terminals).toHaveLength(1);
      expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (previous[0] === undefined) delete window.showWarningMessage; else window.showWarningMessage = previous[0];
      if (previous[1] === undefined) delete workspace.saveAll; else workspace.saveAll = previous[1];
    }
  });
  it('rejects unassigned tools, shell text and stale session messages',async()=>{view();await receive({action:'tool',tool:'claude',sessionId:'s1'});await receive({action:'tool',tool:'codex; bad-command',sessionId:'s1'});await receive({action:'tool',tool:'codex',sessionId:'previous'});expect(state.terminals).toHaveLength(0)});
  it('rechecks consent and expiry when an action arrives',async()=>{view();vi.spyOn(config,'readSession').mockReturnValue({...session,consentAccepted:false});await receive({action:'tool',tool:'codex',sessionId:'s1'});vi.spyOn(config,'readSession').mockReturnValue({...session,expiresAt:'2020-01-01T00:00:00Z'});await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(0)});
  it('does not launch without an assessment workspace',async()=>{rmSync(join(root,'assessment.json'));view();await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(0)});
  it('rejects handoff paths outside the root and projects only public fields',()=>{expect(parseWorkspaceBrief({id:'INV-907',title:'test',specFile:'../secrets.spec'})).toBeNull();expect(parseWorkspaceBrief({id:'INV-907',title:'test',specFile:'INV-907.spec',hidden:'secret'})).toEqual({id:'INV-907',title:'test',specFile:'INV-907.spec'})});
});
describe('hosted box without assessment.json',()=>{
  // Nothing in the hosted lane writes assessment.json, so a live box never set
  // promptster.assessmentWorkspace and "Review & submit" never appeared.
  const hosted = fromJson({apiUrl:'https://api.example.test',sessionToken:'test',sessionId:'s1',tools:['claude'],consentAccepted:true,noSelfEvict:true,assessmentTitle:'Fix the exporter',issueId:'tf-react-spectrum-8696'},'.promptster/session.json')!;
  beforeEach(()=>{rmSync(join(root,'assessment.json'));vi.spyOn(config,'readSession').mockReturnValue(hosted)});
  it('derives the brief from the ARM session and shows the view',()=>{
    const ctx = vi.spyOn(vscode.commands,'executeCommand');
    expect(hostedBrief(root,hosted)).toEqual({id:'tf-react-spectrum-8696',title:'Fix the exporter'});
    view();
    expect(ctx).toHaveBeenCalledWith('setContext','promptster.assessmentWorkspace',true);
  });
  it('picks up a lone ticket-flow spec stub as the handoff',()=>{
    writeFileSync(join(root,'ENG-2841.spec'),'# ENG-2841\n');
    expect(hostedBrief(root,hosted)).toEqual({id:'tf-react-spectrum-8696',title:'Fix the exporter',specFile:'ENG-2841.spec'});
  });
  it('stays hidden for a laptop session, or one with no title',()=>{
    expect(hostedBrief(root,{...hosted,hosted:false})).toBeNull();
    expect(hostedBrief(root,{...hosted,assessmentTitle:undefined})).toBeNull();
  });
  it('opens TASK.md instead of rendering a ticket',async()=>{
    writeFileSync(join(root,'TASK.md'),'# Task');
    const open = vi.spyOn(vscode.commands,'executeCommand');
    view(); await receive({action:'ticket',sessionId:'s1'});
    expect(open).toHaveBeenCalledWith('markdown.showPreview',expect.objectContaining({fsPath:join(root,'TASK.md')}));
    expect(existsSync(join(root,'TASK.html'))).toBe(false);
  });
});
