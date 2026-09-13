import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromJson } from '../../src/config';

vi.mock('vscode', () => import('../fakes/vscode'));
import { TeammatesApi } from '../../src/ui/teammates';

const session = fromJson({ apiUrl: 'https://api.example.test/', sessionToken: 'PST-test', sessionId: 'session 1' }, '.promptster/session.json')!;
const sent = { eventId: 'one', at: '2026-09-12T10:03:20Z', direction: 'to_persona', kind: 'message', text: 'Question' };
const away = { eventId: 'two', at: '2026-09-12T10:03:21Z', direction: 'from_persona', kind: 'away', text: 'In a meeting, back in a bit.' };

beforeEach(() => vi.restoreAllMocks());

describe('Teammates API', () => {
  it('uses the session credential and exact candidate routes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ threadId: 'priya', sent, reply: away }) } as Response);
    const result = await new TeammatesApi(session).send('priya', ' Question ');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/v1/sessions/session%201/teammates/priya/messages', expect.objectContaining({
      method: 'POST', headers: { 'X-API-Key': 'PST-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ' Question ' }),
    }));
    expect(result.reply.kind).toBe('away');
    expect(result.reply.text).toBe(away.text);
  });

  it('reads the persisted thread without manufacturing an answer', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ threadId: 'priya', messages: [sent, away] }) } as Response);
    const result = await new TeammatesApi(session).messages('priya');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/v1/sessions/session%201/teammates/priya/messages', expect.objectContaining({ method: 'GET', headers: { 'X-API-Key': 'PST-test' } }));
    expect(result.messages).toEqual([sent, away]);
  });
});

describe('thread isolation', () => {
  it('contributes no command or language-model tool that returns thread contents', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(manifest.contributes.commands.every((command: { command: string }) => !/teammate|thread|message/i.test(command.command))).toBe(true);
    expect(manifest.contributes.languageModelTools).toBeUndefined();
    const source = readFileSync(resolve('src/ui/teammates.ts'), 'utf8');
    expect(source).not.toMatch(/registerCommand|writeFile|process\.env|createTerminal|registerTool/);
  });
});
