import { describe, it, expect } from 'vitest';
import { redactCommand } from '../../src/utils/commandRedactor';

describe('redactCommand', () => {
  describe('program + subcommand parsing', () => {
    it('extracts program from simple command', () => {
      const result = redactCommand('ls');
      expect(result.program).toBe('ls');
      expect(result.subcommand).toBeUndefined();
      expect(result.tokenCount).toBe(1);
      expect(result.display).toBe('ls');
    });

    it('extracts program + subcommand for git', () => {
      const result = redactCommand('git push origin main');
      expect(result.program).toBe('git');
      expect(result.subcommand).toBe('push');
      expect(result.tokenCount).toBe(4);
      expect(result.display).toBe('git push');
    });

    it('extracts program + subcommand for pnpm', () => {
      const result = redactCommand('pnpm install --frozen-lockfile');
      expect(result.program).toBe('pnpm');
      expect(result.subcommand).toBe('install');
      expect(result.hasFlags).toBe(true);
    });

    it('does not treat a flag as a subcommand', () => {
      const result = redactCommand('node --version');
      expect(result.program).toBe('node');
      expect(result.subcommand).toBeUndefined();
      expect(result.hasFlags).toBe(true);
    });

    it('skips leading env-var assignments to find program', () => {
      const result = redactCommand('DEBUG=1 NODE_ENV=test pnpm test');
      expect(result.program).toBe('pnpm');
      expect(result.subcommand).toBe('test');
    });

    it('handles extra whitespace', () => {
      const result = redactCommand('  git    status  ');
      expect(result.program).toBe('git');
      expect(result.subcommand).toBe('status');
      expect(result.tokenCount).toBe(2);
    });

    it('returns empty program for empty input', () => {
      const result = redactCommand('');
      expect(result.program).toBe('');
      expect(result.tokenCount).toBe(0);
      expect(result.hasFlags).toBe(false);
      expect(result.hadPotentialSecret).toBe(false);
      expect(result.display).toBe('<empty>');
    });
  });

  describe('display field is always safe for canonical command field', () => {
    it('never contains flag values', () => {
      const result = redactCommand('npm publish --token=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(result.display).toBe('npm publish');
      expect(result.display).not.toContain('token');
      expect(result.display).not.toContain('xxxx');
    });

    it('never contains URLs or positional args', () => {
      const result = redactCommand('curl https://api.example.com/v1/users');
      expect(result.display).toBe('curl');
      expect(result.display).not.toContain('example.com');
    });

    it('never contains secret-looking env-var values', () => {
      const result = redactCommand('TOKEN=abc123xyz ./deploy.sh prod');
      expect(result.display).toBe('./deploy.sh prod');
      expect(result.display).not.toContain('abc123xyz');
    });

    it('is non-empty even for blank input', () => {
      expect(redactCommand('').display.length).toBeGreaterThan(0);
      expect(redactCommand('   ').display.length).toBeGreaterThan(0);
    });
  });

  describe('secret detection', () => {
    it('flags --token flag', () => {
      const result = redactCommand('curl --token abc123def456 https://api.example.com');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags --token=value form', () => {
      const result = redactCommand('npm publish --token=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags --api-key', () => {
      const result = redactCommand('mytool --api-key sk_live_abc');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags --password', () => {
      const result = redactCommand('mysql --password=hunter2');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags Authorization header', () => {
      const result = redactCommand('curl -H "Authorization: Bearer eyJhbGciOi"');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags TOKEN= env-var-style', () => {
      const result = redactCommand('TOKEN=secretvalue ./deploy.sh');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags long opaque blobs as likely secrets', () => {
      const result = redactCommand('echo eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('does NOT flag short alphanumeric strings', () => {
      const result = redactCommand('git checkout abc123');
      expect(result.hadPotentialSecret).toBe(false);
    });

    it('does NOT flag plain commands', () => {
      const result = redactCommand('pnpm test --reporter=verbose');
      expect(result.hadPotentialSecret).toBe(false);
    });

    it('does NOT flag --key when it is not a secret flag (e.g. ssh-keygen -t rsa)', () => {
      // ssh-keygen -t is fine; --key is the secret-y one
      const result = redactCommand('ssh-keygen -t rsa');
      expect(result.hadPotentialSecret).toBe(false);
    });
  });

  describe('never leaks raw command', () => {
    it('returned object has no field containing the raw command text', () => {
      const raw = 'curl -H "Authorization: Bearer SECRETxyz123" https://api.example.com';
      const result = redactCommand(raw);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SECRETxyz123');
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('api.example.com');
    });
  });
});
