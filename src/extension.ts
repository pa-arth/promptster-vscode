import * as vscode from 'vscode';
import { readConfig, watchConfig } from './config';
import { ensureConsent } from './consent';
import { EventFactory } from './events/factory';
import { TransportLayer } from './transport';
import { CollectorRegistry } from './collectors';
import { StatusBarManager } from './ui/statusBar';
import { registerCommands } from './ui/commands';
import { loadIgnorePatterns } from './utils/pathSanitizer';
import { log, logError } from './utils/logger';
import type { PromptsterConfig } from './types';

let statusBar: StatusBarManager;
let transport: TransportLayer | undefined;
let collectors: CollectorRegistry | undefined;
let paused = false;

export function activate(context: vscode.ExtensionContext): void {
  log('Promptster extension activating');

  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Register commands (available even when dormant)
  registerCommands(context, {
    onPause: () => {
      paused = true;
      transport?.stop();
      collectors?.disposeAll();
      collectors = undefined;
      statusBar.showPaused();
      log('Capture paused by user');
    },
    onResume: () => {
      paused = false;
      const config = readConfig();
      if (config) {
        startCapture(context, config);
      }
      log('Capture resumed by user');
    },
    onConfigure: () => {
      vscode.window.showInformationMessage(
        'Promptster reads config from .promptster/config.json in your workspace root. ' +
        'This file is auto-created when you run `promptster start` from the CLI.',
      );
    },
  });

  // Try to load config immediately
  const config = readConfig();
  if (config) {
    void bootWithConsent(context, config);
  } else {
    statusBar.showDormant();
  }

  // Watch for config file appearing/changing
  const configWatcher = watchConfig((newConfig) => {
    if (paused) return;

    if (newConfig) {
      void bootWithConsent(context, newConfig);
    } else {
      stopCapture();
      statusBar.showDormant();
    }
  });
  context.subscriptions.push(configWatcher);
}

async function bootWithConsent(
  context: vscode.ExtensionContext,
  config: PromptsterConfig,
): Promise<void> {
  const consented = await ensureConsent(context);
  if (!consented) {
    log('Candidate declined consent — staying dormant');
    statusBar.showDormant();
    return;
  }

  startCapture(context, config);
}

function startCapture(context: vscode.ExtensionContext, config: PromptsterConfig): void {
  // Stop any existing capture first
  stopCapture();

  try {
    // Load ignore patterns
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      loadIgnorePatterns(folders[0].uri.fsPath);
    }

    // Build the pipeline
    const factory = new EventFactory(config);
    transport = new TransportLayer(config, context.globalState);
    collectors = new CollectorRegistry(factory, transport);

    // Activate
    collectors.activateAll();
    transport.start();
    statusBar.showCapturing();

    // Emit session_start event
    transport.enqueue(
      factory.create('editor_focus', {
        subKind: 'session_start',
        editorVersion: vscode.version,
        extensionVersion: '0.1.0',
      }),
    );

    log('Capture started');
  } catch (err) {
    logError('Failed to start capture', err);
    statusBar.showError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function stopCapture(): void {
  if (collectors) {
    collectors.disposeAll();
    collectors = undefined;
  }
  if (transport) {
    transport.stop();
    transport = undefined;
  }
}

export function deactivate(): void {
  log('Promptster extension deactivating');
  stopCapture();
}
