import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '' as string,
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
      return [{ uri: { fsPath: mocks.root } }];
    },
  },
}));

import { sanitizePath, loadIgnorePatterns, customIgnoreCount } from '../../src/utils/pathSanitizer';

/**
 * README.md's Privacy section publishes "Files matching `.promptsterignore`
 * patterns are excluded". Before this change `loadIgnorePatterns` was a stub
 * that set the custom pattern list to `[]` and never opened the file, so the
 * published promise was false for every candidate who wrote one.
 *
 * See openspec editor-attention-capture/findings-1.md, finding F-39.
 */
describe('.promptsterignore', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptster-ignore-'));
    mocks.root = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeIgnore(contents: string): void {
    fs.writeFileSync(path.join(root, '.promptsterignore'), contents, 'utf-8');
    loadIgnorePatterns(root);
  }

  it('is actually read from the workspace root', () => {
    writeIgnore('internal/\n');
    expect(customIgnoreCount()).toBe(1);
    expect(sanitizePath(path.join(root, 'internal/notes.md'))).toBeNull();
  });

  it('leaves non-matching files reportable', () => {
    writeIgnore('internal/\n');
    expect(sanitizePath(path.join(root, 'src/index.ts'))).toBe('src/index.ts');
  });

  it('supports a bare filename anywhere in the tree', () => {
    writeIgnore('notes.md\n');
    expect(sanitizePath(path.join(root, 'notes.md'))).toBeNull();
    expect(sanitizePath(path.join(root, 'docs/notes.md'))).toBeNull();
  });

  it('supports a leading-slash anchored path', () => {
    writeIgnore('/build\n');
    expect(sanitizePath(path.join(root, 'build/out.js'))).toBeNull();
    expect(sanitizePath(path.join(root, 'apps/build/out.js'))).toBe('apps/build/out.js');
  });

  it('supports * globs without crossing a path separator', () => {
    writeIgnore('*.pem\n');
    expect(sanitizePath(path.join(root, 'server.pem'))).toBeNull();
    expect(sanitizePath(path.join(root, 'certs/server.pem'))).toBeNull();
    expect(sanitizePath(path.join(root, 'server.pem.txt'))).toBe('server.pem.txt');
  });

  it('supports **/ globs', () => {
    writeIgnore('**/fixtures/\n');
    expect(sanitizePath(path.join(root, 'test/fixtures/a.json'))).toBeNull();
    expect(sanitizePath(path.join(root, 'fixtures/a.json'))).toBeNull();
  });

  it('skips comments and blank lines', () => {
    writeIgnore('# a comment\n\n   \nprivate/\n');
    expect(customIgnoreCount()).toBe(1);
  });

  it('skips negation patterns rather than mistranslating them', () => {
    // Supporting `!` wrongly would re-include a path the candidate excluded.
    writeIgnore('secrets/\n!secrets/public.md\n');
    expect(customIgnoreCount()).toBe(1);
    expect(sanitizePath(path.join(root, 'secrets/public.md'))).toBeNull();
  });

  it('falls back to defaults when the file is absent', () => {
    loadIgnorePatterns(root);
    expect(customIgnoreCount()).toBe(0);
    expect(sanitizePath(path.join(root, '.env'))).toBeNull();
    expect(sanitizePath(path.join(root, 'src/index.ts'))).toBe('src/index.ts');
  });

  it('every pattern in .promptsterignore.default compiles and is honoured', () => {
    const shipped = fs.readFileSync(
      path.join(__dirname, '../../.promptsterignore.default'),
      'utf-8',
    );
    writeIgnore(shipped);
    // Every non-comment, non-blank, non-negation line must have compiled.
    const expected = shipped
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).length;
    expect(customIgnoreCount()).toBe(expected);

    for (const p of [
      '.env.local',
      '.promptster/config.json',
      'credentials.json',
      'src/secrets.ts',
      'node_modules/x/index.js',
      '.git/HEAD',
      'dist/main.js',
      'build/main.js',
      'out/main.js',
      'promptster-0.2.0.vsix',
      '.DS_Store',
      'Thumbs.db',
    ]) {
      expect(sanitizePath(path.join(root, p)), `${p} should be excluded`).toBeNull();
    }
  });
});
