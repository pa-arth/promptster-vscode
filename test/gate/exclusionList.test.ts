import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('vscode', () => import('../fakes/vscode'));

import { driveSession, CANARIES, WORKSPACE_ROOT } from '../fakes/driveSession';
import { resetState } from '../fakes/vscode';
import type { PromptsterEvent } from '../../src/types';

const REPO_ROOT = path.join(__dirname, '../..');
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');

/**
 * The release gate for the published exclusion list.
 *
 * README.md:25-33 tells candidates what an instrumented editor does not collect.
 * They read it to decide whether to consent, so a claim the code does not honour
 * is not a documentation defect — it is consent obtained on a false description.
 * Before this suite existed the list had never been checked against the running
 * collectors, and two of its seven lines were false.
 *
 * This gate runs the real collectors against a fake editor whose documents,
 * paste buffers, command lines and diagnostics are canary strings, then asserts
 * no canary reaches the wire. Static scanning cannot do that; a payload field
 * carrying file text looks like any other string in the source.
 *
 * When you change either side, change both: the README list and this suite are
 * pinned to each other below.
 */

/** README.md:27-33, verbatim, in order. Pinned so an edit to either trips here. */
const PUBLISHED_EXCLUSIONS = [
  'File contents, source code, or diffs',
  'Clipboard text',
  'Terminal output',
  'AI prompt text',
  'Diagnostic error messages',
  'URLs or browser activity',
  'Anything outside the workspace',
];

function readmeExclusionList(): string[] {
  const section = README.split('## What Is NOT Captured')[1];
  if (section === undefined) return [];
  return section
    .split('\n##')[0]
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

describe('published exclusion list ↔ shipped collectors', () => {
  describe('the published list itself', () => {
    it('README.md still publishes exactly the seven audited exclusions', () => {
      // If this fails, the README changed. Re-audit the new or changed line
      // against the collectors before updating PUBLISHED_EXCLUSIONS.
      expect(readmeExclusionList()).toEqual(PUBLISHED_EXCLUSIONS);
    });

    it('the in-editor consent screen makes the same promise as the README', () => {
      // A candidate sees the webview, not the README. They must not differ.
      const webview = fs.readFileSync(
        path.join(REPO_ROOT, 'src/ui/consentWebview.ts'),
        'utf-8',
      );
      const notCaptured = webview.split('What is NOT captured')[1] ?? '';
      for (const claim of [
        'File contents',
        'source code',
        'diffs',
        'clipboard text',
        'terminal output',
        'AI prompt text',
        'diagnostic messages',
        'URLs',
        'anything outside your workspace',
      ]) {
        expect(notCaptured, `consent webview must still name: ${claim}`).toContain(claim);
      }
    });
  });

  describe('what the collectors actually emit', () => {
    let events: PromptsterEvent[];
    let wire: string;

    beforeEach(() => {
      resetState();
      vi.useFakeTimers();
      const result = driveSession((ms) => vi.advanceTimersByTime(ms));
      result.registry.disposeAll();
      events = result.events;
      wire = JSON.stringify(events);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('produces a session worth auditing', () => {
      // A gate that passes because nothing was emitted proves nothing.
      expect(events.length).toBeGreaterThan(10);
      const kinds = new Set(events.map((e) => e.kind));
      for (const kind of ['editor_focus', 'editor_edit', 'editor_idle', 'command']) {
        expect(kinds, `expected the session to produce ${kind}`).toContain(kind);
      }
    });

    // README.md:27
    it('carries no file contents, source code, or diffs', () => {
      expect(wire).not.toContain(CANARIES.fileContent);
      expect(wire).not.toContain(CANARIES.fileSecret);
      expect(wire).not.toContain('export function verify');
      expect(wire).not.toContain('rejects an expired token');
    });

    // README.md:28
    it('carries no clipboard text', () => {
      expect(wire).not.toContain(CANARIES.clipboard);
      expect(wire).not.toContain('function pasted');
    });

    // README.md:28 — belt and braces: nothing may even reach for the clipboard.
    it('no source file references the clipboard API', () => {
      for (const file of sourceFiles()) {
        expect(
          fs.readFileSync(file, 'utf-8'),
          `${path.relative(REPO_ROOT, file)} must not touch the clipboard`,
        ).not.toMatch(/env\s*\.\s*clipboard/);
      }
    });

    // README.md:29
    it('carries no terminal output', () => {
      expect(wire).not.toContain(CANARIES.terminalOutput);
    });

    it('no source file subscribes to terminal output APIs', () => {
      for (const file of sourceFiles()) {
        const src = fs.readFileSync(file, 'utf-8');
        const rel = path.relative(REPO_ROOT, file);
        expect(src, `${rel} must not read terminal data`).not.toContain(
          'onDidWriteTerminalData',
        );
        expect(src, `${rel} must not read a shell execution stream`).not.toMatch(
          /execution\s*\.\s*read\s*\(/,
        );
      }
    });

    // README.md:30
    it('carries no AI prompt text', () => {
      expect(wire).not.toContain(CANARIES.promptText);
    });

    // README.md:31
    it('carries no diagnostic error messages', () => {
      expect(wire).not.toContain(CANARIES.diagnosticMessage);
      // ...while still reporting that diagnostics were resolved.
      const quickFix = events.find((e) => e.data.subKind === 'quick_fix');
      expect(quickFix?.data.diagnosticsResolved).toBe(2);
    });

    it('no collector reads a diagnostic message field', () => {
      const diag = fs.readFileSync(
        path.join(REPO_ROOT, 'src/collectors/diagnostic.ts'),
        'utf-8',
      );
      expect(diag).not.toMatch(/\.\s*message/);
    });

    // README.md:32
    it('carries no URLs or browser activity', () => {
      expect(wire).not.toContain(CANARIES.url);
      expect(wire).not.toContain('canary.example.invalid');
      expect(wire).not.toContain(CANARIES.bearerToken);
      expect(wire).not.toMatch(/https?:\/\//);
    });

    // README.md:33
    it('carries nothing about files outside the workspace', () => {
      expect(wire).not.toContain(CANARIES.externalFile);
      expect(wire).not.toContain('.ssh');
      expect(wire).not.toContain('<external>');
      // Its typing and scrolling must be absent too, not merely its path: an
      // event with a redacted path still reports that the candidate was reading
      // and editing something we promised not to look at.
      const outsideRelated = events.filter(
        (e) =>
          typeof e.data.filePath === 'string' &&
          (e.data.filePath as string).includes('..'),
      );
      expect(outsideRelated).toEqual([]);
    });

    // README.md:38 — same section, same reader.
    it('leaks no absolute or home-directory path', () => {
      expect(wire).not.toContain(WORKSPACE_ROOT);
      expect(wire).not.toContain(CANARIES.homePath);
      expect(wire).not.toContain('/Users/');
      for (const event of events) {
        expect(event.source).not.toHaveProperty('cwd');
        for (const key of ['filePath', 'fromFile', 'toFile', 'path', 'lastActiveFile']) {
          const value = event.data[key];
          if (typeof value === 'string') {
            expect(path.isAbsolute(value), `${key}=${value} must be relative`).toBe(false);
          }
        }
      }
    });

    /**
     * The catch-all. Every field name any collector puts on the wire is listed
     * here. A new field is not automatically a violation — but it must be looked
     * at against the seven claims above before it ships, and an allowlist is the
     * only mechanism that forces that look.
     */
    it('emits no payload field outside the audited allowlist', () => {
      const ALLOWED = new Set([
        'subKind',
        // file navigation
        'filePath',
        'fileExtension',
        'languageId',
        'lineCount',
        'isNewFile',
        'fromFile',
        'toFile',
        'fromDwellMs',
        'dwellMs',
        'maxVisibleLineReached',
        'totalLines',
        'scrollDepthPct',
        // edit patterns
        'burstDurationMs',
        'charCount',
        'lineRange',
        'avgInterKeystrokeMs',
        // diagnostics
        'diagnosticsResolved',
        'remainingErrors',
        'remainingWarnings',
        // focus / idle
        'lastActiveFile',
        'lastAction',
        'idleDurationMs',
        // terminal
        'command',
        'program',
        'subcommand',
        'tokenCount',
        'hasFlags',
        'hadPotentialSecret',
        'exitCode',
        'durationMs',
        // file lifecycle
        'path',
        // session lifecycle
        'editorVersion',
        'extensionVersion',
      ]);

      const seen = new Set<string>();
      for (const event of events) {
        for (const key of Object.keys(event.data)) seen.add(key);
      }
      const unexpected = [...seen].filter((k) => !ALLOWED.has(k));
      expect(unexpected, `unaudited payload fields: ${unexpected.join(', ')}`).toEqual([]);
    });

    it('emits only string values that are paths, subkinds or redacted commands', () => {
      // Free-text is how excluded content arrives. Every string on the wire must
      // be one we can name.
      const FREE_TEXT_FIELDS = new Set(['command', 'program', 'subcommand']);
      for (const event of events) {
        for (const [key, value] of Object.entries(event.data)) {
          if (typeof value !== 'string') continue;
          if (FREE_TEXT_FIELDS.has(key)) {
            // Redacted command form: program, optionally one subcommand token.
            expect(value, `${key}=${value} is not a redacted command form`).toMatch(
              /^[^\s]*(?: [A-Za-z][A-Za-z0-9_:-]*)?$/,
            );
            expect(value.length, `${key} is suspiciously long: ${value}`).toBeLessThan(64);
            continue;
          }
          // Everything else is a subkind, a language id, an extension, or a
          // workspace-relative path — none of which contain whitespace.
          expect(value, `${key}=${value} contains free text`).not.toMatch(/\s/);
        }
      }
    });
  });
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return out;
}
