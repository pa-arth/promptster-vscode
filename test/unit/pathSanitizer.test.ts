import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspaceFolders: [{ uri: { fsPath: '/workspace' } }] as
    | { uri: { fsPath: string } }[]
    | undefined,
}));

vi.mock('vscode', () => ({
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

  describe('paths outside workspace', () => {
    it('returns <external> for parent directory paths', () => {
      expect(sanitizePath('/Users/candidate/.ssh/id_rsa')).toBe('<external>');
    });

    it('returns <external> when no workspace is open', () => {
      mocks.workspaceFolders = undefined;
      expect(sanitizePath('/anywhere/file.ts')).toBe('<external>');
    });

    it('returns <external> when workspace folders array is empty', () => {
      mocks.workspaceFolders = [];
      expect(sanitizePath('/anywhere/file.ts')).toBe('<external>');
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
