import { TicketEditor } from './ui/ticket';
import * as vscode from 'vscode';
import { readSession, watchSession } from './config';
import { captureDecision, reasonText } from './consent';
import { EventFactory } from './events/factory';
import { TransportLayer } from './transport';
import { CollectorRegistry } from './collectors';
import type { CaptureOptions } from './collectors/base';
import { SessionStore } from './sessionStore';
import { writeCaptureState } from './captureState';
import { StatusBarManager } from './ui/statusBar';
import { TimeLeft } from './ui/timeLeft';
import { Budget } from './ui/budget';
import { registerCommands } from './ui/commands';
import { TeammatesView } from './ui/teammates';
import { AssessmentView, openTaskMd } from './ui/assessment';
import { loadIgnorePatterns } from './utils/pathSanitizer';
import { log, logError } from './utils/logger';
import type { PromptsterSession } from './types';

/** ms after activation during which a repeat file_open is a reattach artifact. */
const REATTACH_WINDOW_MS = 5_000;

let statusBar: StatusBarManager;
let timeLeft: TimeLeft;
let budget: Budget;
let store: SessionStore;
let transport: TransportLayer | undefined;
let collectors: CollectorRegistry | undefined;
/** The session capture is currently running for, if any. */
let running: PromptsterSession | undefined;
let teammates: TeammatesView;
let assessment: AssessmentView;
/** Version of the running extension, read from the manifest at activation. */
let extensionVersion = 'unknown';

export function activate(context: vscode.ExtensionContext): void {
  log('Promptster extension activating');

  statusBar = new StatusBarManager();
  store = new SessionStore(context.globalState, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  extensionVersion = context.extension?.packageJSON?.version ?? 'unknown';
  timeLeft = new TimeLeft();
  budget = new Budget();
  context.subscriptions.push(statusBar, timeLeft, budget);

  context.subscriptions.push(vscode.window.registerCustomEditorProvider('promptster.ticket', new TicketEditor()));
  assessment = new AssessmentView(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('promptster.assessment', assessment));
  assessment.refresh();

  teammates = new TeammatesView(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('promptster.teammates', teammates));
  void teammates.refresh();

  registerCommands(context, {
    onPause: async () => {
      const session = running ?? readSession();
      if (session) await store.update(session.sessionId, { paused: true });
      // Through reconcile, not around it. Pausing has to leave the same
      // status bar, the same teardown and the same reported capture state as
      // every other way of not capturing.
      await reconcile(context);
      log('Capture paused by user');
    },
    onResume: async () => {
      const session = readSession();
      if (session) await store.update(session.sessionId, { paused: false });
      await reconcile(context);
      log('Capture resumed by user');
    },
    onConfigure: () => {
      vscode.window.showInformationMessage(
        'Promptster reads its session from .promptster/session.json in your workspace root. ' +
          'That file is written when you run `promptster start` from the CLI.',
      );
    },
  });

  void reconcile(context);

  // The CLI rewrites session.json several times during a session. Every write
  // lands here, so this must be a reconcile, never a restart — see reconcile().
  context.subscriptions.push(watchSession(() => void reconcile(context)));

  // Unticking the setting has to stop a capture that is ALREADY running, not
  // only prevent the next one. Without this the opt-out would appear to work
  // and not take effect until the window reloaded.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('promptster.enabled')) void reconcile(context);
    }),
  );
}

/**
 * The candidate's telemetry opt-out, read fresh on every decision.
 *
 * Defaults to true to match the manifest's `default: true` — an unreadable or
 * absent setting must not silently disable capture for everyone. Explicitly
 * false is the only value that stops it.
 */
function captureEnabled(): boolean {
  return vscode.workspace.getConfiguration('promptster').get<boolean>('enabled', true) !== false;
}

/**
 * Bring capture into line with what the session says, and do nothing when it
 * already is.
 *
 * This is the idempotence boundary. It is called on activation, on every write
 * to the session file, and on resume, and each of those can fire repeatedly for
 * one candidate. A restart on each would re-emit `session_start` and re-report
 * every open file, and every derived measure over these events is a count — so
 * a duplicate does not add noise, it manufactures attention that did not occur.
 */
async function reconcile(context: vscode.ExtensionContext): Promise<void> {
  assessment.refresh();
  void teammates.refresh();
  const session = readSession();
  // The clock runs whether or not capture does: the limit applies either way.
  timeLeft.set(session?.deadlineAt);
  budget.set(session ?? undefined);
  const paused = session ? store.read(session.sessionId).paused : false;
  const decision = captureDecision(session, paused, captureEnabled());

  if (!decision.capture) {
    if (running) {
      log(`Stopping capture: ${decision.reason}`);
      await stopCapture();
    }
    if (decision.reason === 'paused') {
      statusBar.showPaused();
    } else {
      statusBar.showNotCapturing(reasonText(decision.reason));
    }
    writeCaptureState(extensionVersion, {
      capturing: false,
      sessionId: session?.sessionId,
      reason: decision.reason,
    });
    return;
  }

  // `session` is non-null whenever the decision is to capture.
  const next = session as PromptsterSession;

  if (running && isSameCapture(running, next)) {
    // Already capturing this session under these terms. The write that woke us
    // changed something the extension does not care about.
    log('Session state changed but capture is unaffected — leaving it running');
    statusBar.showCapturing();
    writeCaptureState(extensionVersion, { capturing: true, sessionId: next.sessionId });
    return;
  }

  await stopCapture();
  await startCapture(context, next);
}

/**
 * Whether a running capture already satisfies the new session state.
 *
 * Only the fields capture actually depends on. A change to any of them means
 * the pipeline has to be rebuilt; a change to anything else must not disturb it.
 */
function isSameCapture(a: PromptsterSession, b: PromptsterSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.apiUrl === b.apiUrl &&
    a.apiKey === b.apiKey &&
    a.consentAccepted === b.consentAccepted &&
    a.consentToIntegrity === b.consentToIntegrity
  );
}

async function startCapture(
  context: vscode.ExtensionContext,
  session: PromptsterSession,
): Promise<void> {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      loadIgnorePatterns(folders[0].uri.fsPath);
    }

    const persisted = store.read(session.sessionId);

    const options: CaptureOptions = {
      openedFiles: new Set(persisted.openedFiles),
      onFileOpened: (filePath) => {
        void store.update(session.sessionId, {
          openedFiles: [...store.read(session.sessionId).openedFiles, filePath],
        });
      },
      reattachWindowMs: REATTACH_WINDOW_MS,
      bootedAt: Date.now(),
      captureKeystrokeCadence: session.consentToIntegrity,
    };

    const factory = new EventFactory(session);
    transport = new TransportLayer(session, context.globalState);
    collectors = new CollectorRegistry(factory, transport, options);

    collectors.activateAll();
    transport.start();
    running = session;
    statusBar.showCapturing();

    // Exactly once per session, not once per attach. A reload that re-emitted
    // session_start would put a second start on the candidate's timeline.
    if (await store.claim(session.sessionId, 'sessionStartEmitted')) {
      transport.enqueue(
        factory.create('session_start', {
          editorVersion: vscode.version,
          extensionVersion,
        }),
      );
    } else {
      log('session_start already recorded for this session — reattach, not a new start');
    }

    writeCaptureState(extensionVersion, { capturing: true, sessionId: session.sessionId });
    await launchHostedAgent(session);
    log(`Capture started for session ${session.sessionId} (from ${session.sourceFile})`);
  } catch (err) {
    logError('Failed to start capture', err);
    running = undefined;
    statusBar.showError(err instanceof Error ? err.message : 'Unknown error');
  }
}

async function launchHostedAgent(session: PromptsterSession): Promise<void> {
  if (!session.hosted) return;

  const command = session.tools.includes('claude')
    ? 'claude'
    : session.tools.includes('codex')
      ? 'promptster codex'
      : null;
  if (!command) {
    log('Hosted session has no supported agent to launch');
    return;
  }

  // Claimed before launching, on disk, so neither a reload nor a second
  // browser or window can create another interactive agent beside the first.
  if (!(await store.claim(session.sessionId, 'agentLaunched'))) return;
  // code-server currently opens its generic Copilot/Agent secondary sidebar by
  // default. It is unrelated to the recruiter-selected, Promptster-authenticated
  // agent below and makes the candidate choose between two apparently competing
  // entry points. Close it before focusing the assessment terminal.
  try {
    const commands = await vscode.commands.getCommands(true);
    const closeSidebar = ['workbench.action.closeAuxiliaryBar', 'workbench.action.closeSecondarySideBar']
      .find(commandId => commands.includes(commandId));
    if (closeSidebar) await vscode.commands.executeCommand(closeSidebar);
  } catch (error) {
    // Optional layout adjustments must never interrupt capture or tool launch.
    log(`Could not close the secondary sidebar: ${String(error)}`);
  }
  try {
    await vscode.commands.executeCommand('workbench.view.extension.promptster');
  } catch (error) {
    log(`Could not reveal the assessment sidebar: ${String(error)}`);
  }
  // The candidate's first view is their task, not an empty editor (provisioning
  // sets `workbench.startupEditor: none` so code-server's Welcome tab cannot
  // claim it first). Once per session, behind the same `agentLaunched` latch.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    try {
      await openTaskMd(root);
    } catch (error) {
      log(`Could not open TASK.md: ${String(error)}`);
    }
  }
  const tool = command === 'claude' ? 'claude' : 'codex';
  const terminal = vscode.window.createTerminal({ name: 'Promptster Assessment', env: { PROMPTSTER_TERMINAL_SESSION_ID: session.sessionId, PROMPTSTER_TERMINAL_TOOL: tool } });
  assessment.trackTool(session.sessionId, tool, terminal);
  terminal.show(false);
  terminal.sendText(command, true);
  log(`Opened the hosted assessment terminal with ${command}`);
}

async function stopCapture(): Promise<void> {
  running = undefined;
  if (collectors) {
    collectors.disposeAll();
    collectors = undefined;
  }
  if (transport) {
    const t = transport;
    transport = undefined;
    await t.stop();
  }
}

export async function deactivate(): Promise<void> {
  log('Promptster extension deactivating');
  await stopCapture();
}
