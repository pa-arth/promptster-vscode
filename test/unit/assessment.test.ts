import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import * as config from '../../src/config';
import { fromJson } from '../../src/config';
vi.mock('vscode', () => import('../fakes/vscode'));
import { state, resetState } from '../fakes/vscode';
import { AssessmentView, parseWorkspaceBrief } from '../../src/ui/assessment';
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
  it('rejects unassigned tools, shell text and stale session messages',async()=>{view();await receive({action:'tool',tool:'claude',sessionId:'s1'});await receive({action:'tool',tool:'codex; bad-command',sessionId:'s1'});await receive({action:'tool',tool:'codex',sessionId:'previous'});expect(state.terminals).toHaveLength(0)});
  it('rechecks consent and expiry when an action arrives',async()=>{view();vi.spyOn(config,'readSession').mockReturnValue({...session,consentAccepted:false});await receive({action:'tool',tool:'codex',sessionId:'s1'});vi.spyOn(config,'readSession').mockReturnValue({...session,expiresAt:'2020-01-01T00:00:00Z'});await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(0)});
  it('does not launch without an assessment workspace',async()=>{rmSync(join(root,'assessment.json'));view();await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(0)});
  it('rejects handoff paths outside the root and projects only public fields',()=>{expect(parseWorkspaceBrief({id:'INV-907',title:'test',specFile:'../secrets.spec'})).toBeNull();expect(parseWorkspaceBrief({id:'INV-907',title:'test',specFile:'INV-907.spec',hidden:'secret'})).toEqual({id:'INV-907',title:'test',specFile:'INV-907.spec'})});
});
