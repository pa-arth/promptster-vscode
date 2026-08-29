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

/**
 * `vi.resetModules()` re-evaluates this module, which is how a test simulates an
 * editor reload. The emitters, window state and command registry must NOT be
 * re-created when that happens: the test file holds references from before the
 * reset and the reloaded extension subscribes after it, and if those are two
 * different objects nothing the test fires ever reaches the extension.
 */
function singleton<T>(key: string, make: () => T): T {
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) g[key] = make();
  return g[key] as T;
}

export const emitters = singleton('__promptsterFakeEmitters', () => ({
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
}));

export const state = singleton('__promptsterFakeState', () => ({
  workspaceRoot: '/workspace',
  appName: 'Visual Studio Code',
  activeEditor: undefined as FakeEditor | undefined,
  /** fsPath -> diagnostics currently reported for it. */
  diagnostics: new Map<string, { severity: number; message: string }[]>(),
  logLines: [] as string[],
  terminals: [] as Array<{ name: string; shown: boolean; commands: string[] }>,
}));

export function resetState(): void {
  clearWatchers();
  state.workspaceRoot = '/workspace';
  state.appName = 'Visual Studio Code';
  state.activeEditor = undefined;
  state.diagnostics = new Map();
  state.logLines = [];
  state.terminals = [];
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
  createTerminal: ({ name }: { name: string }) => {
    const terminal = { name, shown: false, commands: [] as string[] };
    state.terminals.push(terminal);
    return {
      show: () => {
        terminal.shown = true;
      },
      sendText: (command: string) => terminal.commands.push(command),
      dispose: () => {},
    };
  },
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

/**
 * Watchers are per-pattern, as they are in the real API. The extension creates
 * one for the session file and the file-lifecycle collector creates one for
 * `**\/*`; firing "a file changed" at both of them at once is a test artifact
 * that makes a session-file write look like the candidate creating a file.
 */
interface FakeWatcher {
  pattern: string;
  create: Emitter<{ scheme: string; fsPath: string }>;
  del: Emitter<{ scheme: string; fsPath: string }>;
  change: Emitter<{ scheme: string; fsPath: string }>;
  disposed: boolean;
}

const watchers = singleton('__promptsterFakeWatchers', () => [] as FakeWatcher[]);

/** Fire a filesystem event only at watchers registered for `pattern`. */
export function fireWatcher(
  pattern: string,
  kind: 'create' | 'change' | 'delete',
  fsPath: string,
): void {
  const uri = { scheme: 'file', fsPath };
  for (const w of watchers) {
    if (w.disposed || w.pattern !== pattern) continue;
    if (kind === 'create') w.create.fire(uri);
    else if (kind === 'change') w.change.fire(uri);
    else w.del.fire(uri);
  }
}

export function clearWatchers(): void {
  watchers.length = 0;
}

export const workspace = {
  get workspaceFolders() {
    return [{ uri: { fsPath: state.workspaceRoot } }];
  },
  onDidCloseTextDocument: emitters.closeTextDocument.event,
  onDidChangeTextDocument: emitters.changeTextDocument.event,
  createFileSystemWatcher: (pattern: { pattern?: string } | string) => {
    const entry: FakeWatcher = {
      pattern: typeof pattern === 'string' ? pattern : (pattern.pattern ?? ''),
      create: new Emitter(),
      del: new Emitter(),
      change: new Emitter(),
      disposed: false,
    };
    watchers.push(entry);
    return {
      onDidCreate: entry.create.event,
      onDidDelete: entry.del.event,
      onDidChange: entry.change.event,
      dispose: () => {
        entry.disposed = true;
      },
    };
  },
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

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const commands = singleton('__promptsterFakeCommands', () => {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  return {
    registered,
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): FakeDisposable {
      registered.set(id, handler);
      return { dispose: () => registered.delete(id) };
    },
    async execute(id: string): Promise<unknown> {
      const handler = registered.get(id);
      if (!handler) throw new Error(`no such command: ${id}`);
      return handler();
    },
    async executeCommand(id: string): Promise<unknown> {
      const handler = registered.get(id);
      return handler?.();
    },
  };
});

export const ViewColumn = { One: 1 };

/** A vscode.Memento that survives a simulated editor reload. */
export class FakeMemento {
  constructor(private readonly backing = new Map<string, unknown>()) {}
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.backing.has(key) ? (this.backing.get(key) as T) : fallback) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.backing.delete(key);
    else this.backing.set(key, value);
  }
  keys(): string[] {
    return [...this.backing.keys()];
  }
}

export function makeExtensionContext(globalState: FakeMemento, version = '0.2.0') {
  return {
    subscriptions: [] as FakeDisposable[],
    globalState,
    extension: { packageJSON: { version } },
  };
}

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
