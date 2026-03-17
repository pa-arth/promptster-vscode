/**
 * Shared types for the Promptster VSCode extension.
 * Mirrors the backend CommonEvent envelope shape.
 */

// --- Source / Actor / Provenance ---

export type SourceChannel = 'ide-extension';

export type Integration = 'vscode' | 'cursor';

export interface EventSource {
  channel: SourceChannel;
  integration: Integration;
  emitter: 'promptster-vscode';
  cwd?: string;
  repo?: string;
}

export interface EventActor {
  type: 'human';
  role: 'candidate';
  id?: string;
  display?: string;
}

export interface EventProvenance {
  attribution: 'likely_human';
  confidence: number;
  observability: 'high';
  methods: string[];
}

// --- Event kinds we emit ---

export type EditorFocusSubKind =
  | 'file_open'
  | 'file_close'
  | 'tab_switch'
  | 'editor_blur'
  | 'editor_gain'
  | 'scroll_depth';

export type EditorEditSubKind =
  | 'typing_burst'
  | 'paste'
  | 'undo_redo'
  | 'quick_fix'
  | 'diagnostic_hover';

export type EditorIdleSubKind = 'idle_start' | 'idle_end';

export type EventKind =
  | 'editor_focus'
  | 'editor_edit'
  | 'editor_idle'
  | 'command'
  | 'file_create'
  | 'file_delete';

// --- Common event envelope ---

export interface PromptsterEvent {
  id: string;
  sessionId: string;
  ts: string;
  source: EventSource;
  actor: EventActor;
  provenance: EventProvenance;
  v: number;
  kind: EventKind;
  data: Record<string, unknown>;
}

// --- Config ---

export interface PromptsterConfig {
  apiUrl: string;
  apiKey: string;
  sessionId: string;
}
