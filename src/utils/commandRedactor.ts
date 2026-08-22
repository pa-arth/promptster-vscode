/**
 * Redact a terminal command line into a structured, secret-safe summary.
 *
 * We never send the raw command line — it commonly contains API keys, bearer
 * tokens, passwords, or other credentials. Instead we extract just enough
 * signal (program, subcommand, arg count, flag presence) to know *what kind*
 * of command ran without leaking the values.
 */

export interface RedactedCommand {
  /**
   * Secret-safe string suitable for the canonical `data.command` field.
   * Format: `program` or `program subcommand`. Never contains flag values
   * or arbitrary arg text — only the program and (if present) subcommand.
   */
  display: string;
  /** First non-env-var token (e.g. "git", "pnpm", "curl"). */
  program: string;
  /** Second token if it is a positional subcommand (e.g. "push", "install"). */
  subcommand?: string;
  /** Total whitespace-separated tokens including the program. */
  tokenCount: number;
  /** Whether any flag (-x or --xyz) is present. */
  hasFlags: boolean;
  /** Whether the command line contained anything that looks like a secret. */
  hadPotentialSecret: boolean;
}

const ENV_PREFIX = /^[A-Z_][A-Z0-9_]*=/i;

const SECRET_FLAG_NAMES = [
  'token',
  'api-key',
  'apikey',
  'api_key',
  'key',
  'password',
  'pass',
  'pw',
  'secret',
  'bearer',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'private-key',
  'access-key',
  'access_token',
  'refresh_token',
];

const SECRET_FLAG_PATTERN = new RegExp(
  `(?:^|\\s)-{1,2}(?:${SECRET_FLAG_NAMES.join('|')})(?:[\\s=]|$)`,
  'i',
);

const SECRET_HEADER_PATTERN = /\b(?:Authorization|X-API-Key|Cookie|Set-Cookie)\s*:/i;

const SECRET_ENV_PATTERN = new RegExp(
  `(?:^|\\s)(?:${SECRET_FLAG_NAMES.join('|')})=`,
  'i',
);

/** Long opaque blob (likely a token/key) — 30+ chars of base64-y alphabet. */
const OPAQUE_BLOB_PATTERN = /[A-Za-z0-9+/_=-]{30,}/;

export function redactCommand(raw: string): RedactedCommand {
  const trimmed = raw.trim();
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);

  let programIndex = 0;
  while (programIndex < tokens.length && ENV_PREFIX.test(tokens[programIndex])) {
    programIndex++;
  }

  const program = tokens[programIndex] ?? '';
  const subcommandRaw = tokens[programIndex + 1];
  // A subcommand must look like a simple word — alphanumeric plus -, _, :
  // (the colon allows things like `cargo test:foo`). URLs, file paths, JSON,
  // and positional args won't match, so they never leak into `display`.
  const subcommand =
    subcommandRaw && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(subcommandRaw) ? subcommandRaw : undefined;

  const hasFlags = tokens.some((t) => t.startsWith('-'));

  const hadPotentialSecret =
    SECRET_FLAG_PATTERN.test(trimmed) ||
    SECRET_HEADER_PATTERN.test(trimmed) ||
    SECRET_ENV_PATTERN.test(trimmed) ||
    OPAQUE_BLOB_PATTERN.test(trimmed);

  const display = subcommand ? `${program} ${subcommand}` : program || '<empty>';

  return {
    display,
    program,
    subcommand,
    tokenCount: tokens.length,
    hasFlags,
    hadPotentialSecret,
  };
}
