import * as vscode from 'vscode';

const escape = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Only public ticket text is rendered. Markdown HTML is displayed as text. */
export function renderTicket(markdown: string, brief: { id: string; title: string; specFile: string }): string {
  const inventory = brief.id.toLowerCase() === 'inv-907';
  const lines = markdown.split(/\r?\n/);
  const content = lines.map(line => {
    if (!line.trim()) return '';
    if (/^# /.test(line)) return `<h3>${escape(line.slice(2))}</h3>`;
    if (/^#{2,6} /.test(line)) return `<h3>${escape(line.replace(/^#+ /, ''))}</h3>`;
    if (/^- /.test(line)) return `<p class="item">${escape(line.slice(2))}</p>`;
    return `<p>${escape(line)}</p>`;
  }).join('\n');
  const intro = inventory ? `<h1>Can the inventory launch go ahead?</h1>
    <p class="lead">Stores are seeing stale or incorrect stock. The largest customer’s dashboard is slow. The launch team needs a decision before stores open.</p>
    <section class="assignment"><h2>Your task</h2><p>Investigate with your teammates and coding assistant. Write the smallest safe mitigation, repair and verification plan in <strong>${escape(brief.specFile)}</strong>.</p></section>
    <details><summary>Incident notes &amp; original ticket</summary><div class="notes">${content}</div></details>
    <details><summary>Before you submit</summary><ul><li>Preserve incoming inventory updates.</li><li>Define the customer-facing scope and communication.</li><li>Separate evidence, agreed decisions and unresolved checks.</li><li>Explain what would justify resuming the launch.</li></ul></details>
    <p class="footnote">This is an investigation and handoff. You won’t execute production changes here. Your handoff and teammate conversations receive human review.</p>`
    : `<h1>${escape(brief.title)}</h1><div class="notes">${content}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brief.id)} · Ticket</title><style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background,#faf9f6);color:var(--vscode-editor-foreground,#242333);font:16px/1.65 var(--vscode-font-family,'Segoe UI',sans-serif)}main{max-width:740px;margin:0 auto;padding:clamp(28px,6vw,64px) clamp(22px,5vw,48px)}.eyebrow{font-size:12px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--vscode-descriptionForeground,#686572);margin:0 0 14px}h1{font-size:clamp(26px,3vw,36px);line-height:1.2;letter-spacing:-.025em;font-weight:650;margin:0 0 22px}h2{font-size:17px;margin:0 0 8px}h3{font-size:16px;line-height:1.5;margin:20px 0 10px}.lead{font-size:18px;line-height:1.65;margin:0 0 30px}.assignment{padding:22px 0 28px;border-top:1px solid var(--vscode-panel-border,#dfdcd5)}p{margin:0 0 14px}.assignment p{margin:0}strong{font-weight:650}details{border-top:1px solid var(--vscode-panel-border,#dfdcd5)}summary{padding:16px 0;cursor:pointer;font-size:15px;font-weight:600}summary:focus-visible{outline:2px solid var(--vscode-focusBorder,#d87505);outline-offset:4px}.notes,ul{font-size:15px;line-height:1.7;margin:0 0 24px;overflow-wrap:anywhere}.item{padding-left:18px;position:relative}.item:before{content:'•';position:absolute;left:0}li{margin:0 0 9px}.footnote{font-size:13px;line-height:1.6;margin:28px 0 0;color:var(--vscode-descriptionForeground,#686572)}@media(prefers-color-scheme:dark){body{background:var(--vscode-editor-background,#1d1c22);color:var(--vscode-editor-foreground,#eeeae2)}.eyebrow,.footnote{color:var(--vscode-descriptionForeground,#bbb5c1)}}
    </style></head><body><main><p class="eyebrow">${escape(brief.id)} · Ticket</p>${intro}</main></body></html>`;
}

/** A real HTML file opens as a rendered ticket, with no scripts or network access. */
export class TicketEditor implements vscode.CustomTextEditorProvider {
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: false, localResourceRoots: [] };
    const update = () => {
      const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'">`;
      panel.webview.html = `<!doctype html><html><head>${policy}</head><body>${document.getText()}</body></html>`;
    };
    update();
    const changed = vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === document.uri.toString()) update(); });
    panel.onDidDispose(() => changed.dispose());
  }
}
