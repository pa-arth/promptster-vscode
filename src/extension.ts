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
import { registerCommands } from './ui/commands';
import { loadIgnorePatterns } from './utils/pathSanitizer';
import { log, logError } from './utils/logger';
import type { PromptsterSession } from './types';

/** ms after activation during which a repeat file_open is a reattach artifact. */
const REATTACH_WINDOW_MS = 5_000;

let statusBar: StatusBarManager;
let store: SessionStore;
let transport: TransportLayer | undefined;
let collectors: CollectorRegistry | undefined;
/** The session capture is currently running for, if any. */
let running: PromptsterSession | undefined;
/** Version of the running extension, read from the manifest at activation. */
let extensionVersion = 'unknown';

export function activate(context: vscode.ExtensionContext): void {
  log('Promptster extension activating');

  statusBar = new StatusBarManager();
  store = new SessionStore(context.globalState);
  extensionVersion = context.extension?.packageJSON?.version ?? 'unknown';
  context.subscriptions.push(statusBar);

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
  const session = readSession();
  const paused = session ? store.read(session.sessionId).paused : false;
  const decision = captureDecision(session, paused);

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
    if (!persisted.sessionStartEmitted) {
      transport.enqueue(
        factory.create('session_start', {
          editorVersion: vscode.version,
          extensionVersion,
        }),
      );
      await store.update(session.sessionId, { sessionStartEmitted: true });
    } else {
      log('session_start already recorded for this session — reattach, not a new start');
    }

    writeCaptureState(extensionVersion, { capturing: true, sessionId: session.sessionId });
    log(`Capture started for session ${session.sessionId} (from ${session.sourceFile})`);
  } catch (err) {
    logError('Failed to start capture', err);
    running = undefined;
    statusBar.showError(err instanceof Error ? err.message : 'Unknown error');
  }
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
