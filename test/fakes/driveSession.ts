import { EventFactory } from '../../src/events/factory';
import { CollectorRegistry } from '../../src/collectors';
import { loadIgnorePatterns } from '../../src/utils/pathSanitizer';
import type { PromptsterEvent } from '../../src/types';
import { emitters, makeDocument, state, type FakeEditor } from './vscode';

/**
 * Canary strings. Each one is content that README.md:27-33 promises is never
 * captured. They are planted in the fake editor's documents, paste buffers,
 * command lines and diagnostics; the gate then asserts none of them appear
 * anywhere in the serialised event stream.
 *
 * A collector that starts carrying excluded content fails here, by name.
 */
export const CANARIES = {
  fileContent: 'CANARY_FILE_CONTENT_a1b2c3',
  fileSecret: 'sk-CANARYSECRET0123456789abcdefghij',
  clipboard: 'CANARY_CLIPBOARD_PASTE_d4e5f6',
  terminalOutput: 'CANARY_TERMINAL_OUTPUT_p6q7r8',
  promptText: 'CANARY_AI_PROMPT_TEXT_s9t0u1',
  diagnosticMessage: 'CANARY_DIAGNOSTIC_MESSAGE_j0k1l2',
  url: 'https://canary.example.invalid/CANARY_URL_PATH_v2w3x4',
  bearerToken: 'CANARY_BEARER_TOKEN_g7h8i9',
  externalFile: 'CANARY_EXTERNAL_FILE_m3n4o5',
  homePath: 'CANARY_PRIVATE_REPO_y5z6a7',
};

/** Workspace root deliberately contains a home-directory path with a canary. */
export const WORKSPACE_ROOT = `/Users/candidate/repos/${CANARIES.homePath}`;

class CapturingTransport {
  readonly events: PromptsterEvent[] = [];
  enqueue(event: PromptsterEvent): void {
    this.events.push(event);
  }
  start(): void {}
  async stop(): Promise<void> {}
}

function editorFor(fsPath: string, text: string, languageId?: string): FakeEditor {
  return { document: makeDocument(fsPath, text, languageId) };
}

function activate(editor: FakeEditor | undefined): void {
  state.activeEditor = editor;
  emitters.activeTextEditor.fire(editor);
}

/**
 * Replay a plausible candidate session against the real collectors.
 *
 * Returns every event the collectors handed to the transport. `advance` is
 * supplied by the caller so the test controls the debounce/idle timers
 * (vi.advanceTimersByTime under fake timers).
 */
export function driveSession(advance: (ms: number) => void): {
  events: PromptsterEvent[];
  registry: CollectorRegistry;
} {
  state.workspaceRoot = WORKSPACE_ROOT;
  loadIgnorePatterns(WORKSPACE_ROOT);

  const factory = new EventFactory({
    apiUrl: 'https://api.example.invalid',
    apiKey: 'PST-test-key',
    sessionId: 'sess_test_0001',
  });
  const transport = new CapturingTransport();
  const registry = new CollectorRegistry(factory, transport as never);
  registry.activateAll();

  const failingTest = editorFor(
    `${WORKSPACE_ROOT}/test/auth.test.ts`,
    [
      "import { verify } from '../src/auth';",
      `// ${CANARIES.fileContent}`,
      `const KEY = '${CANARIES.fileSecret}';`,
      'it("rejects an expired token", () => {});',
    ].join('\n'),
  );
  const source = editorFor(
    `${WORKSPACE_ROOT}/src/auth.ts`,
    [`// ${CANARIES.fileContent}`, 'export function verify() {}'].join('\n'),
  );
  // Outside the workspace entirely — README.md:33.
  const outside = editorFor(
    `/Users/candidate/.ssh/${CANARIES.externalFile}`,
    `PRIVATE KEY ${CANARIES.fileSecret}`,
    'plaintext',
  );

  // --- read the failing test, then the source ------------------------------
  activate(failingTest);
  advance(1_500);
  emitters.visibleRanges.fire({
    textEditor: failingTest,
    visibleRanges: [{ end: { line: 3 } }],
  });
  advance(1_500); // let the scroll-depth debounce fire

  activate(source);
  advance(2_000);

  // --- open something outside the workspace, and scroll and type in it -----
  activate(outside);
  advance(1_000);
  emitters.visibleRanges.fire({ textEditor: outside, visibleRanges: [{ end: { line: 0 } }] });
  advance(1_500);
  emitters.changeTextDocument.fire({
    document: outside.document,
    contentChanges: [
      { text: 'x', rangeLength: 0, range: { start: { line: 0 }, end: { line: 0 } } },
    ],
  });
  advance(2_500); // flush the typing burst
  activate(source);

  // --- type in the source file --------------------------------------------
  for (const ch of 'const ok = true;') {
    emitters.changeTextDocument.fire({
      document: source.document,
      contentChanges: [
        { text: ch, rangeLength: 0, range: { start: { line: 1 }, end: { line: 1 } } },
      ],
    });
    advance(30);
  }
  advance(2_500); // flush the burst

  // --- paste something that came from the clipboard ------------------------
  emitters.changeTextDocument.fire({
    document: source.document,
    contentChanges: [
      {
        text: `// ${CANARIES.clipboard}\nfunction pasted() {\n  return ${CANARIES.fileSecret};\n}`,
        rangeLength: 0,
        range: { start: { line: 2 }, end: { line: 2 } },
      },
    ],
  });

  // --- run terminal commands, one of which carries a URL and a token -------
  const commands = [
    'pnpm test',
    `curl -H "Authorization: Bearer ${CANARIES.bearerToken}" ${CANARIES.url}`,
    `sed -i 's/old/${CANARIES.fileContent}/' src/auth.ts`,
    `claude -p "${CANARIES.promptText}"`,
  ];
  for (const cmd of commands) {
    emitters.startShellExecution.fire({ execution: { commandLine: { value: cmd } } });
    advance(120);
    emitters.endShellExecution.fire({
      execution: { commandLine: { value: cmd } },
      exitCode: 0,
    });
  }
  // Terminal OUTPUT is never surfaced by the APIs we subscribe to; assert it by
  // planting it where an accidental subscription would pick it up.
  emitters.openTerminal.fire({ name: CANARIES.terminalOutput });
  emitters.closeTerminal.fire({ name: CANARIES.terminalOutput });

  // --- diagnostics appear, then get resolved -------------------------------
  const diagPath = `${WORKSPACE_ROOT}/src/auth.ts`;
  state.diagnostics.set(diagPath, [
    { severity: 0, message: CANARIES.diagnosticMessage },
    { severity: 0, message: CANARIES.diagnosticMessage },
    { severity: 1, message: CANARIES.diagnosticMessage },
  ]);
  emitters.changeDiagnostics.fire({ uris: [{ scheme: 'file', fsPath: diagPath }] });
  state.diagnostics.set(diagPath, [{ severity: 1, message: CANARIES.diagnosticMessage }]);
  emitters.changeDiagnostics.fire({ uris: [{ scheme: 'file', fsPath: diagPath }] });

  // --- file lifecycle ------------------------------------------------------
  emitters.fileCreate.fire({ scheme: 'file', fsPath: `${WORKSPACE_ROOT}/src/token.ts` });
  emitters.fileDelete.fire({ scheme: 'file', fsPath: `${WORKSPACE_ROOT}/src/old.ts` });
  // ...and a create outside the workspace, which must not be reported at all.
  emitters.fileCreate.fire({
    scheme: 'file',
    fsPath: `/Users/candidate/.ssh/${CANARIES.externalFile}`,
  });

  // --- blur, go idle, come back -------------------------------------------
  emitters.windowState.fire({ focused: false });
  advance(65_000); // cross the 60s idle threshold
  emitters.windowState.fire({ focused: true });
  emitters.textEditorSelection.fire({ textEditor: source });

  // --- close a file --------------------------------------------------------
  emitters.closeTextDocument.fire(failingTest.document);

  return { events: transport.events, registry };
}
