import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { PromptsterConfig, PromptsterEvent, EventKind, EventSource, Integration } from '../types';
import { detectIntegration } from '../utils/editorDetector';

export class EventFactory {
  private readonly integration: Integration;
  private readonly source: EventSource;

  constructor(private readonly config: PromptsterConfig) {
    this.integration = detectIntegration();

    const folders = vscode.workspace.workspaceFolders;
    this.source = {
      channel: 'ide-extension',
      integration: this.integration,
      emitter: 'promptster-vscode',
      cwd: folders?.[0]?.uri.fsPath,
    };
  }

  create(kind: EventKind, data: Record<string, unknown>): PromptsterEvent {
    return {
      id: crypto.randomUUID(),
      sessionId: this.config.sessionId,
      ts: new Date().toISOString(),
      source: this.source,
      actor: {
        type: 'human',
        role: 'candidate',
      },
      provenance: {
        attribution: 'likely_human',
        confidence: 1.0,
        observability: 'high',
        methods: ['ide-extension'],
      },
      v: 1,
      kind,
      data,
    };
  }
}
