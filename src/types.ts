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
  /**
   * Workspace identity, if ever needed. NOT an absolute path — see
   * events/factory.ts and openspec findings-1.md F-38. `cwd` was removed from
   * this interface on purpose so a future edit cannot reintroduce the home-path
   * leak without also editing the type.
   */
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

/**
 * Window focus/blur ('gain'/'blur') is deliberately NOT here. The public
 * candidate promise disclaims focus tracking by name — see openspec
 * findings-2.md, finding P-1.
 */
export type EditorFocusSubKind =
  | 'file_open'
  | 'file_close'
  | 'tab_switch'
  | 'scroll_depth';

export type EditorEditSubKind =
  | 'typing_burst'
  | 'paste'
  | 'undo_redo'
  | 'quick_fix'
  | 'diagnostic_hover';

export type EditorIdleSubKind = 'idle_start' | 'idle_end';

/**
 * Canonical event kinds, aligned with the backend's CanonicalEventKind enum
 * in packages/event-schema. Editor-* kinds use LoosePayloadEvent (any data
 * shape); session_start, command, file_create, file_delete use the strict
 * schemas — see types.ts comments at each emission site for required fields.
 */
export type EventKind =
  | 'editor_focus'
  | 'editor_edit'
  | 'editor_idle'
  | 'command'
  | 'file_create'
  | 'file_delete'
  | 'session_start';

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

/**
 * The assessment session as the CLI recorded it, read from
 * `.promptster/session.json`.
 *
 * The extension has no build-time API URL and no consent state of its own: both
 * come from the session the CLI started. See config.ts.
 */
export interface PromptsterSession extends PromptsterConfig {
  /**
   * The candidate accepted the canonical consent disclosure. Capture does not
   * begin without it, and the extension never asks a second time.
   */
  consentAccepted: boolean;
  /**
   * The candidate additionally opted in to cadence-based integrity checks. The
   * disclosure covers keystroke-interval timing only under this opt-in, so
   * `avgInterKeystrokeMs` is emitted only when it is true.
   */
  consentToIntegrity: boolean;
  /** Candidate-key expiry. Capture stops once it passes. */
  expiresAt?: string;
  /** Tools selected by the hiring team for this assessment. */
  tools: Array<'claude' | 'codex'>;
  /** Seeded sessions run in a Promptster-owned hosted box. */
  hosted: boolean;
  /** Which file the session state was read from, for diagnostics. */
  sourceFile: string;
}

/** Why the extension is not capturing, when it is not. */
export type NotCapturingReason =
  | 'disabled'
  | 'no-session'
  | 'consent-not-recorded'
  | 'session-expired'
  | 'paused';
