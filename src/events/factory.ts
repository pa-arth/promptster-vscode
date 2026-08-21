import * as crypto from 'crypto';
import type { PromptsterConfig, PromptsterEvent, EventKind, EventSource, Integration } from '../types';
import { detectIntegration } from '../utils/editorDetector';

export class EventFactory {
  private readonly integration: Integration;
  private readonly source: EventSource;

  constructor(private readonly config: PromptsterConfig) {
    this.integration = detectIntegration();

    // No `cwd`. It carried `workspaceFolders[0].uri.fsPath` — the ABSOLUTE
    // workspace path, e.g. /Users/<name>/repos/<private-repo> — on every event,
    // and the ingest route persists the whole envelope into raw_events. That is
    // a home-directory path, which README.md:38 promises never leaks. Nothing on
    // the hiring rail reads source.cwd (the hooks ingest route does not write it
    // to sessions.cwd). If workspace identity is ever needed, send the folder
    // basename, not the path. See openspec findings-1.md, finding F-38.
    this.source = {
      channel: 'ide-extension',
      integration: this.integration,
      emitter: 'promptster-vscode',
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
