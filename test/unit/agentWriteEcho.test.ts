import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('vscode', () => import('../fakes/vscode'));
import { emitters, fireWatcher, clearWatchers } from '../fakes/vscode';
import { EditPatternCollector } from '../../src/collectors/editPattern';
import { FileLifecycleCollector } from '../../src/collectors/fileLifecycle';
import { EventFactory } from '../../src/events/factory';
import type { PromptsterEvent } from '../../src/types';

// Prod sessions 4c2c64c9 / 1f85e395: every file Claude wrote while it was open
// in the editor came through as a candidate `paste` of Claude's code, and every
// Write fired a candidate `file_create` — which made the backend read files
// only Claude touched as `ai_revised_by_human`.

function harness() {
  const sent: PromptsterEvent[] = [];
  const transport = { enqueue: (e: PromptsterEvent) => sent.push(e) };
  const factory = new EventFactory({ sessionId: 's1' } as never);
  return { sent, transport, factory };
}

const doc = (isDirty: boolean | undefined) => ({
  uri: { scheme: 'file', fsPath: '/workspace/poller/handler.py' },
  languageId: 'python',
  lineCount: 40,
  text: '',
  isDirty,
});

const bigInsert = {
  text: 'def retry():\n    return 1\n',
  rangeLength: 0,
  range: { start: { line: 1 }, end: { line: 1 } },
};

describe('agent writes are not candidate edits', () => {
  beforeEach(() => clearWatchers());

  it('drops a content change that leaves the document clean — a reload from disk', () => {
    const { sent, transport, factory } = harness();
    const c = new EditPatternCollector(factory, transport as never);
    c.activate();
    emitters.changeTextDocument.fire({ document: doc(false), contentChanges: [bigInsert] } as never);
    c.dispose();
    expect(sent).toEqual([]);
  });

  it('still records a real paste, which leaves the document dirty', () => {
    const { sent, transport, factory } = harness();
    const c = new EditPatternCollector(factory, transport as never);
    c.activate();
    emitters.changeTextDocument.fire({ document: doc(true), contentChanges: [bigInsert] } as never);
    c.dispose();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data.subKind).toBe('paste');
    expect(sent[0]!.actor.type).toBe('human');
  });

  it('stamps watcher creates and deletes as a system observation, not the candidate', () => {
    const { sent, transport, factory } = harness();
    const c = new FileLifecycleCollector(factory, transport as never);
    c.activate();
    fireWatcher('**/*', 'create', '/workspace/poller/handler.py');
    fireWatcher('**/*', 'delete', '/workspace/poller/old.py');
    c.dispose();
    expect(sent.map((e) => e.kind)).toEqual(['file_create', 'file_delete']);
    for (const e of sent) {
      expect(e.actor).toEqual({ type: 'system', role: 'file-watcher' });
      expect(e.provenance.attribution).toBe('unknown');
      expect(e.provenance.methods).toContain('fs-watcher');
    }
  });
});
