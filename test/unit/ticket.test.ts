import { describe, it, expect, vi } from 'vitest';
vi.mock('vscode', () => import('../fakes/vscode'));
import { renderTicket, TicketEditor } from '../../src/ui/ticket';
describe('readable ticket', () => {
  it('retains all public source text in collapsed details and escapes markup', () => {
    const html = renderTicket('# Ticket\n- 08:55: eight times normal size\n<script>run()</script>', { id:'INV-907', title:'Incident', specFile:'INV-907.spec' });
    expect(html).toContain('<details><summary>Incident notes &amp; original ticket');
    expect(html).not.toContain('<details open');
    expect(html).toContain('08:55: eight times normal size');
    expect(html).toContain('&lt;script&gt;run()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('disables scripts and external resources in the HTML editor', () => {
    const panel = { webview: { options:{}, html:'' }, onDidDispose:vi.fn() };
    new TicketEditor().resolveCustomTextEditor({getText:()=>'<p>Ticket</p>'} as never, panel as never);
    expect(panel.webview.options).toEqual({enableScripts:false,localResourceRoots:[]});
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toContain("form-action 'none'");
  });
});
