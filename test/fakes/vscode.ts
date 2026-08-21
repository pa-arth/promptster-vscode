/**
 * A fake of the slice of the VSCode extension API that the collectors subscribe
 * to, plus a driver for replaying a plausible candidate session against it.
 *
 * This exists so the exclusion-list gate (test/gate/exclusionList.test.ts) can
 * check what the collectors ACTUALLY emit rather than what the source reads like.
 * A static scan cannot tell you that a payload field carries file text; running
 * the collectors over documents whose contents are canary strings can.
 */

export interface FakeDisposable {
  dispose: () => void;
}

class Emitter<T> {
  private handlers: ((e: T) => void)[] = [];

  readonly event = (handler: (e: T) => void): FakeDisposable => {
    this.handlers.push(handler);
    return {
      dispose: () => {
        this.handlers = this.handlers.filter((h) => h !== handler);
      },
    };
  };

  fire(e: T): void {
    for (const h of [...this.handlers]) h(e);
  }

  get listenerCount(): number {
    return this.handlers.length;
  }
}

export interface FakeDocument {
  uri: { scheme: string; fsPath: string };
  languageId: string;
  lineCount: number;
  /** Full text. Collectors must never put any of this on the wire. */
  text: string;
}

export interface FakeEditor {
  document: FakeDocument;
}

export const emitters = {
  activeTextEditor: new Emitter<FakeEditor | undefined>(),
  windowState: new Emitter<{ focused: boolean }>(),
  textEditorSelection: new Emitter<{ textEditor: FakeEditor }>(),
  visibleRanges: new Emitter<{
    textEditor: FakeEditor;
    visibleRanges: { end: { line: number } }[];
  }>(),
  closeTextDocument: new Emitter<FakeDocument>(),
  changeTextDocument: new Emitter<{
    document: FakeDocument;
    contentChanges: {
      text: string;
      rangeLength: number;
      range: { start: { line: number }; end: { line: number } };
    }[];
  }>(),
  changeDiagnostics: new Emitter<{ uris: { scheme: string; fsPath: string }[] }>(),
  openTerminal: new Emitter<unknown>(),
  closeTerminal: new Emitter<unknown>(),
  startShellExecution: new Emitter<{ execution: { commandLine: { value: string } } }>(),
  endShellExecution: new Emitter<{
    execution: { commandLine: { value: string } };
    exitCode: number | undefined;
  }>(),
  fileCreate: new Emitter<{ scheme: string; fsPath: string }>(),
  fileDelete: new Emitter<{ scheme: string; fsPath: string }>(),
};

export const state = {
  workspaceRoot: '/workspace',
  appName: 'Visual Studio Code',
  activeEditor: undefined as FakeEditor | undefined,
  /** fsPath -> diagnostics currently reported for it. */
  diagnostics: new Map<string, { severity: number; message: string }[]>(),
  logLines: [] as string[],
};

export function resetState(): void {
  state.workspaceRoot = '/workspace';
  state.appName = 'Visual Studio Code';
  state.activeEditor = undefined;
  state.diagnostics = new Map();
  state.logLines = [];
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export const window = {
  get activeTextEditor() {
    return state.activeEditor;
  },
  get appName() {
    return state.appName;
  },
  createOutputChannel: () => ({
    appendLine: (line: string) => state.logLines.push(line),
    dispose: () => {},
  }),
  createStatusBarItem: () => ({
    show: () => {},
    hide: () => {},
    dispose: () => {},
    text: '',
    tooltip: '',
    command: undefined as unknown,
  }),
  showInformationMessage: async () => undefined,
  onDidChangeActiveTextEditor: emitters.activeTextEditor.event,
  onDidChangeWindowState: emitters.windowState.event,
  onDidChangeTextEditorSelection: emitters.textEditorSelection.event,
  onDidChangeTextEditorVisibleRanges: emitters.visibleRanges.event,
  onDidOpenTerminal: emitters.openTerminal.event,
  onDidCloseTerminal: emitters.closeTerminal.event,
  onDidStartTerminalShellExecution: emitters.startShellExecution.event,
  onDidEndTerminalShellExecution: emitters.endShellExecution.event,
};

class FakeFileSystemWatcher {
  onDidCreate = emitters.fileCreate.event;
  onDidDelete = emitters.fileDelete.event;
  onDidChange = new Emitter<unknown>().event;
  dispose(): void {}
}

export const workspace = {
  get workspaceFolders() {
    return [{ uri: { fsPath: state.workspaceRoot } }];
  },
  onDidCloseTextDocument: emitters.closeTextDocument.event,
  onDidChangeTextDocument: emitters.changeTextDocument.event,
  createFileSystemWatcher: () => new FakeFileSystemWatcher(),
};

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

export const languages = {
  onDidChangeDiagnostics: emitters.changeDiagnostics.event,
  getDiagnostics: (uri: { fsPath: string }) => state.diagnostics.get(uri.fsPath) ?? [],
};

export const env = {
  get appName() {
    return state.appName;
  },
  // Deliberately absent: `clipboard`. README.md:28 promises clipboard text is
  // never captured, and the gate asserts no source file references it. If a
  // collector ever reaches for it, it will throw here as well as fail the scan.
};

export const version = '1.95.0-fake';

export function makeDocument(
  fsPath: string,
  text: string,
  languageId = 'typescript',
): FakeDocument {
  return {
    uri: { scheme: 'file', fsPath },
    languageId,
    lineCount: text.split('\n').length,
    text,
  };
}
