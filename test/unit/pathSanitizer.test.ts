import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspaceFolders: [{ uri: { fsPath: '/workspace' } }] as
    | { uri: { fsPath: string } }[]
    | undefined,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    get workspaceFolders() {
      return mocks.workspaceFolders;
    },
  },
}));

import { sanitizePath, loadIgnorePatterns } from '../../src/utils/pathSanitizer';

describe('sanitizePath', () => {
  beforeEach(() => {
    mocks.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    loadIgnorePatterns('/workspace');
  });

  describe('workspace-relative conversion', () => {
    it('converts absolute path inside workspace to relative', () => {
      expect(sanitizePath('/workspace/src/index.ts')).toBe('src/index.ts');
    });

    it('handles workspace-root files', () => {
      expect(sanitizePath('/workspace/package.json')).toBe('package.json');
    });

    it('handles deeply nested paths', () => {
      expect(sanitizePath('/workspace/apps/api/src/routes/v1/users.ts')).toBe(
        'apps/api/src/routes/v1/users.ts',
      );
    });
  });

  // README.md:33 promises "Anything outside the workspace" is NOT captured.
  // These must stay null, not a '<external>' placeholder: a placeholder redacts
  // the path but still emits the event, and the event carries languageId,
  // lineCount, dwell, scroll depth and typing-burst charCount for that file.
  // See openspec editor-attention-capture/findings-1.md, finding F-33.
  describe('paths outside workspace are dropped entirely', () => {
    it('returns null for parent directory paths', () => {
      expect(sanitizePath('/Users/candidate/.ssh/id_rsa')).toBeNull();
    });

    it('returns null for a sibling checkout of another repo', () => {
      expect(sanitizePath('/Users/candidate/repos/other-private-repo/src/a.ts')).toBeNull();
    });

    it('returns null when no workspace is open', () => {
      mocks.workspaceFolders = undefined;
      expect(sanitizePath('/anywhere/file.ts')).toBeNull();
    });

    it('returns null when workspace folders array is empty', () => {
      mocks.workspaceFolders = [];
      expect(sanitizePath('/anywhere/file.ts')).toBeNull();
    });

    it('never returns the <external> placeholder for any input', () => {
      const inputs = [
        '/Users/candidate/.ssh/id_rsa',
        '/etc/hosts',
        '/workspace/../sibling/file.ts',
        '/workspace/src/ok.ts',
      ];
      for (const input of inputs) {
        expect(sanitizePath(input)).not.toBe('<external>');
      }
    });
  });

  describe('default ignore patterns', () => {
    it('filters .env file', () => {
      expect(sanitizePath('/workspace/.env')).toBeNull();
    });

    it('filters .env.local variants', () => {
      expect(sanitizePath('/workspace/.env.local')).toBeNull();
      expect(sanitizePath('/workspace/.env.production')).toBeNull();
    });

    it('filters .promptster/ dir', () => {
      expect(sanitizePath('/workspace/.promptster/config.json')).toBeNull();
    });

    it('filters node_modules paths', () => {
      expect(sanitizePath('/workspace/node_modules/lodash/index.js')).toBeNull();
      expect(sanitizePath('/workspace/apps/api/node_modules/foo.js')).toBeNull();
    });

    it('filters .git internals', () => {
      expect(sanitizePath('/workspace/.git/HEAD')).toBeNull();
    });

    it('filters files matching /credentials/i case-insensitively', () => {
      expect(sanitizePath('/workspace/src/credentials.ts')).toBeNull();
      expect(sanitizePath('/workspace/src/Credentials.json')).toBeNull();
    });

    it('filters files matching /secret/i case-insensitively', () => {
      expect(sanitizePath('/workspace/src/secret.ts')).toBeNull();
      expect(sanitizePath('/workspace/src/secrets/api.ts')).toBeNull();
    });
  });

  describe('safe files are not filtered', () => {
    it('allows normal source files', () => {
      expect(sanitizePath('/workspace/src/main.ts')).toBe('src/main.ts');
      expect(sanitizePath('/workspace/README.md')).toBe('README.md');
    });

    it('allows test files', () => {
      expect(sanitizePath('/workspace/test/unit/foo.test.ts')).toBe(
        'test/unit/foo.test.ts',
      );
    });
  });
});
