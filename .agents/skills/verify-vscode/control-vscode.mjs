#!/usr/bin/env node
// control-vscode — drive the Promptster VS Code extension the way a candidate
// does, from a script, and capture proof.
//
// The surface is a VS Code extension, so the real user path is an editor window
// with the extension loaded. That is what `drive` launches: a genuine Extension
// Development Host, in an isolated user-data dir, with a probe running INSIDE
// the extension host that activates the extension, invokes commands, and reads
// back what the extension wrote. Nothing here mocks the `vscode` module.
//
// Every command prints one JSON object. Every failure prints
// {ok:false, error, hint} where `hint` names the fix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SKILL, "..", "..", "..");

// Short by construction. The extension host opens a unix socket at
// <user-data-dir>/<ver>-main.sock and macOS caps that path at 103 chars; a
// scratch dir under /private/tmp/claude-*/... blows the cap and the host dies
// with `listen EINVAL` before any extension loads. Verified, not theoretical.
const HOME_STATE = path.join(os.homedir(), ".promptster-verify", "vscode");
const EVIDENCE = process.env.PROMPTSTER_VERIFY_EVIDENCE || path.join(HOME_STATE, "evidence");
const PIDFILE = path.join(HOME_STATE, "pids.json");

const out = (o) => { process.stdout.write(JSON.stringify(o, null, 2) + "\n"); };
const fail = (error, hint, extra = {}) => { out({ ok: false, error, hint, ...extra }); process.exit(1); };

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
};

// ---------------------------------------------------------------- editors

// Mirrors promptster-cli's supportedEditors() in editor_extension.go. Keep the
// two in step: this command exists to tell you when the CLI is about to be
// wrong about this machine, which only works if it looks where the CLI looks.
const EDITORS = {
  vscode: {
    name: "VS Code",
    command: "code",
    bundle: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    electron: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  },
  cursor: {
    name: "Cursor",
    command: "cursor",
    bundle: "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    electron: "/Applications/Cursor.app/Contents/MacOS/Cursor",
  },
};

const sh = (file, args, opts = {}) =>
  spawnSync(file, args, { encoding: "utf8", timeout: 30_000, ...opts });

/** Where the CLI's exec.LookPath would land, then the macOS bundle fallback. */
function resolveEditorCLI(key) {
  const e = EDITORS[key];
  const which = sh("/usr/bin/which", [e.command]);
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  if (fs.existsSync(e.bundle)) return e.bundle;
  return null;
}

/**
 * What that CLI path ACTUALLY is.
 *
 * `code` on PATH is routinely a symlink into another editor's app bundle —
 * Cursor ships `bin/code` and installs it as both `code` and `cursor`. A
 * detector that trusts the command name then reports "VS Code" for a machine
 * with no VS Code on it, installs the extension twice into Cursor, and records
 * an editor that was never there. Resolve to the .app and say which one it is.
 */
function identifyEditorCLI(cliPath) {
  let real = cliPath;
  try { real = fs.realpathSync(cliPath); } catch { /* keep the unresolved path */ }
  const m = real.match(/^(.*\.app)\//);
  const app = m ? m[1] : null;
  const ver = sh(cliPath, ["--version"]);
  const lines = (ver.stdout || "").trim().split("\n");
  return {
    path: cliPath,
    resolvesTo: real,
    app,
    appIs: app ? path.basename(app, ".app") : null,
    version: lines[0] || null,
    ok: ver.status === 0,
  };
}

function detectEditors() {
  const found = {};
  for (const key of Object.keys(EDITORS)) {
    const cli = resolveEditorCLI(key);
    if (!cli) continue;
    const id = identifyEditorCLI(cli);
    // "Is the thing the CLI calls VS Code actually VS Code?"
    id.impersonated = id.appIs !== null && id.appIs.toLowerCase().replace(/\s+/g, "") !==
      ({ vscode: "visualstudiocode", cursor: "cursor" })[key];
    found[key] = id;
  }
  return found;
}

/** The extension's marketplace identity — publisher.name from package.json. */
function extensionId() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  return { id: `${pkg.publisher}.${pkg.name}`, version: pkg.version, pkg };
}

/** What `<cli> --list-extensions --show-versions` says about us. */
function installedVersion(cliPath, wantId) {
  const r = sh(cliPath, ["--list-extensions", "--show-versions"]);
  if (r.status !== 0) return { error: `--list-extensions failed: ${(r.stderr || "").trim().split("\n")[0] || r.status}` };
  for (const line of (r.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const at = t.lastIndexOf("@");
    const id = at === -1 ? t : t.slice(0, at);
    const version = at === -1 ? "" : t.slice(at + 1);
    // EqualFold, like the Go side.
    if (id.toLowerCase() === wantId.toLowerCase()) return { installed: true, version };
  }
  return { installed: false, version: null };
}

// ---------------------------------------------------------------- build state

const newestMtime = (dir, ext) => {
  let newest = 0, file = null;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) { newest = m; file = full; }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { mtime: newest, file };
};

/**
 * Is `dist/` the build of the `src/` on disk right now?
 *
 * The Extension Development Host loads `main` from package.json — `dist/extension.js`.
 * It never reads src/. So an agent that edits src, skips the compile, and drives
 * the host is verifying the PREVIOUS build while believing it verified its
 * change. That proof looks perfect and measures nothing, which is the whole
 * reason this check is in doctor rather than in a footnote.
 */
function buildState() {
  const src = newestMtime(path.join(REPO, "src"), ".ts");
  const dist = newestMtime(path.join(REPO, "dist"), ".js");
  const entry = path.join(REPO, "dist", "extension.js");
  return {
    compiled: fs.existsSync(entry),
    entry,
    newestSource: src.file ? path.relative(REPO, src.file) : null,
    newestBuilt: dist.file ? path.relative(REPO, dist.file) : null,
    current: fs.existsSync(entry) && dist.mtime >= src.mtime,
    sourceNewerBySeconds: dist.mtime ? Math.max(0, Math.round((src.mtime - dist.mtime) / 1000)) : null,
  };
}

// ---------------------------------------------------------------- workspace

const CAPTURE_STATE_FILE = ".promptster/editor-capture.json";

function readCaptureState(ws) {
  const f = path.join(ws, CAPTURE_STATE_FILE);
  if (!fs.existsSync(f)) return { present: false };
  try {
    const state = JSON.parse(fs.readFileSync(f, "utf8"));
    const ageSeconds = Math.round((Date.now() - Date.parse(state.updatedAt)) / 1000);
    return { present: true, state, ageSeconds, stale: !(ageSeconds < 86_400) };
  } catch (e) {
    return { present: true, error: String(e.message || e) };
  }
}

/**
 * A workspace the extension will actually capture in.
 *
 * Without `.promptster/session.json` the extension activates, decides
 * `no-session`, and does nothing — correctly. Driving that and reporting "the
 * extension works" verifies only that it can stay quiet.
 */
function makeWorkspace(dir, patch = {}) {
  fs.mkdirSync(path.join(dir, ".promptster"), { recursive: true });
  const session = {
    // Field names copied from promptster-cli's Session struct.
    sessionId: "sess_verify",
    sessionToken: "tok_verify",
    apiUrl: "http://127.0.0.1:9",   // refused fast; nothing leaves the machine
    consentAccepted: true,
    consentToIntegrity: false,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    // Relative, never a literal. A hard-coded expiry turns every future run
    // into a silent no-capture that looks like a broken extension.
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    tools: ["claude"],
    ...patch,
  };
  for (const k of Object.keys(session)) if (session[k] === undefined) delete session[k];
  fs.writeFileSync(path.join(dir, ".promptster/session.json"), JSON.stringify(session, null, 2));
  fs.writeFileSync(path.join(dir, "notes.ts"), "export const a = 1;\n");
  return { dir, session };
}

// ---------------------------------------------------------------- pids

const readPids = () => { try { return JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch { return []; } };
const writePids = (p) => { fs.mkdirSync(path.dirname(PIDFILE), { recursive: true }); fs.writeFileSync(PIDFILE, JSON.stringify(p, null, 2)); };
const recordPid = (pid, note) => writePids([...readPids().filter((e) => e.pid !== pid), { pid, note, startedAt: new Date().toISOString() }]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------- the probe

// Runs INSIDE the extension host. CommonJS on purpose: --extensionTestsPath is
// loaded with require(), and an ESM module there fails with ERR_REQUIRE_ESM.
const PROBE = String.raw`
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const spec = JSON.parse(fs.readFileSync(process.env.PV_SPEC, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateFile = () => {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  return root ? path.join(root.uri.fsPath, '.promptster/editor-capture.json') : null;
};
const captureState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
};

exports.run = async () => {
  const rec = {
    editor: { appName: vscode.env.appName, apiVersion: vscode.version },
    workspace: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)[0] || null,
    steps: [],
  };
  try {
    const ext = vscode.extensions.getExtension(spec.extensionId);
    rec.extension = { id: spec.extensionId, found: !!ext, version: ext && ext.packageJSON.version };
    if (ext) { await ext.activate(); rec.extension.active = ext.isActive; }

    // Activation is onStartupFinished and reconcile() is async, so the capture
    // state is written a beat after activate() resolves.
    await sleep(spec.settleMs);

    const all = await vscode.commands.getCommands(true);
    rec.commands = all.filter((c) => c.indexOf('promptster.') === 0).sort();
    rec.contributed = {};
    for (const c of spec.contributedCommands) rec.contributed[c] = all.indexOf(c) !== -1;
    rec.config = { 'promptster.enabled': vscode.workspace.getConfiguration().get('promptster.enabled') };
    rec.captureStateBefore = captureState();

    for (const c of spec.commands) {
      const before = captureState();
      const step = { command: c };
      const t0 = Date.now();
      try { step.result = await vscode.commands.executeCommand(c); step.ok = true; }
      catch (e) { step.ok = false; step.error = String((e && e.message) || e); }
      await sleep(spec.settleMs);
      const after = captureState();
      step.ms = Date.now() - t0;
      step.captureStateAfter = after;
      // The point of driving a command is the side effect, not the call
      // returning. Say whether anything actually moved — ignoring updatedAt,
      // which reconcile() rewrites on every pass whether or not the decision
      // changed. Comparing it would report "changed" for a command that did
      // nothing, which is the exact failure this field exists to expose.
      const meaningful = (s) => { if (!s) return null; const c = Object.assign({}, s); delete c.updatedAt; return JSON.stringify(c); };
      step.captureStateChanged = meaningful(before) !== meaningful(after);
      rec.steps.push(step);
    }
    rec.captureStateAfter = captureState();
    rec.ok = true;
  } catch (e) {
    rec.ok = false;
    rec.error = String((e && e.stack) || e);
  }
  fs.writeFileSync(spec.out, JSON.stringify(rec, null, 2));
};
`;

// ---------------------------------------------------------------- drive

function contributedCommands() {
  const { pkg } = extensionId();
  return (pkg.contributes?.commands ?? []).map((c) => c.command);
}

async function drive() {
  const editorKey = String(flag("editor", "auto"));
  const commands = String(flag("commands", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const timeoutMs = Number(flag("timeout", 120)) * 1000;
  const settleMs = Number(flag("settle", 1500));
  const keepOpen = flag("keep-open", false) === true;

  const editors = detectEditors();
  // Auto-pick the first editor that is really itself AND whose app bundle is
  // present. `code` being on PATH does not mean VS Code is installed here.
  const runnable = Object.keys(editors).filter((k) => fs.existsSync(EDITORS[k].electron));
  const key = editorKey === "auto"
    ? (runnable.find((k) => !editors[k].impersonated) ?? runnable[0])
    : editorKey;
  if (!key || !editors[key]) {
    return fail(`no editor to drive (asked for: ${editorKey})`,
      "Install VS Code or Cursor. `doctor` lists what this machine has.", { detected: Object.keys(editors) });
  }
  const electron = EDITORS[key].electron;
  if (!fs.existsSync(electron)) {
    return fail(`${EDITORS[key].name} has a CLI but no app binary at ${electron}`,
      "The Extension Development Host needs the app bundle, not the CLI shim. Install the editor app, or pass --editor for one that is installed.");
  }

  const build = buildState();
  if (!build.compiled) {
    return fail("dist/extension.js does not exist — there is nothing to load",
      "Run `node control-vscode.mjs build` first. The host loads package.json `main`, which is dist/, never src/.", { build });
  }
  if (!build.current && flag("allow-stale", false) !== true) {
    return fail(`dist/ is older than src/ by ${build.sourceNewerBySeconds}s — you would be driving the previous build`,
      "Run `node control-vscode.mjs build`. Pass --allow-stale only if you meant to drive the old build.", { build });
  }

  // Workspace: an explicit one, or a throwaway with a live session in it.
  let ws = flag("workspace", null);
  let ephemeral = false;
  if (!ws || ws === true) {
    ws = fs.mkdtempSync(path.join(HOME_STATE_DIR(), "ws-"));
    makeWorkspace(ws);
    ephemeral = true;
  }
  ws = path.resolve(String(ws));
  if (!fs.existsSync(ws)) return fail(`workspace does not exist: ${ws}`, "Create one with `node control-vscode.mjs workspace --dir <path>`.");

  const run = fs.mkdtempSync(path.join(HOME_STATE_DIR(), "run-"));
  const probeFile = path.join(run, "probe.cjs");
  const specFile = path.join(run, "spec.json");
  const resultFile = path.join(run, "result.json");
  const logFile = path.join(run, "host.log");
  const { id } = extensionId();

  fs.writeFileSync(probeFile, PROBE);
  fs.writeFileSync(specFile, JSON.stringify({
    extensionId: id, commands, settleMs, out: resultFile,
    contributedCommands: contributedCommands(),
  }, null, 2));

  const log = fs.openSync(logFile, "w");
  const child = spawn(electron, [
    `--extensionDevelopmentPath=${REPO}`,
    `--extensionTestsPath=${probeFile}`,
    `--user-data-dir=${path.join(run, "udd")}`,
    `--extensions-dir=${path.join(run, "ext")}`,
    "--disable-workspace-trust", "--skip-release-notes", "--disable-updates", "--no-sandbox",
    ws,
  ], { env: { ...process.env, PV_SPEC: specFile }, stdio: ["ignore", log, log], detached: false });

  recordPid(child.pid, `extension host for ${REPO}`);

  let exited = null;
  child.on("exit", (code) => { exited = code; });

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(resultFile)) break;
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const timedOut = !fs.existsSync(resultFile) && exited === null;

  // The host does NOT reliably exit when the probe resolves (Cursor keeps the
  // window open). Kill by the pid we recorded — never by process name, which
  // would take out the editor the user is sitting in.
  if (!keepOpen && exited === null) {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1500));
    if (alive(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* raced */ } }
  }
  writePids(readPids().filter((e) => e.pid !== child.pid));
  fs.closeSync(log);

  const hostLog = fs.readFileSync(logFile, "utf8");
  if (!fs.existsSync(resultFile)) {
    const socketDeath = /listen EINVAL|longer than 103 chars/.test(hostLog);
    return fail(
      timedOut ? `the extension host produced no result within ${timeoutMs / 1000}s`
               : `the extension host exited (code ${exited}) before the probe wrote a result`,
      socketDeath
        ? "The host died on its IPC socket path. Keep --user-data-dir short: macOS caps the unix socket at 103 chars."
        : "Read the host log — the extension most likely threw during activate(). `doctor` checks the build; a stale dist/ is the other usual cause.",
      { hostLog: hostLog.split("\n").slice(-25).join("\n"), logFile, workspace: ws },
    );
  }

  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = path.join(EVIDENCE, `drive-${stamp}.json`);
  const record = {
    ok: result.ok !== false,
    editorDriven: EDITORS[key].name,
    editorImpersonated: editors[key].impersonated,
    build,
    workspace: ws,
    ephemeralWorkspace: ephemeral,
    ...result,
    evidence,
    hostLogFile: logFile,
  };
  fs.writeFileSync(evidence, JSON.stringify(record, null, 2));
  out(record);
}

function HOME_STATE_DIR() { fs.mkdirSync(HOME_STATE, { recursive: true }); return HOME_STATE; }

// ---------------------------------------------------------------- doctor

function doctor() {
  const hints = [];
  const { id, version } = extensionId();
  const editors = detectEditors();
  const build = buildState();

  if (!build.compiled) hints.push("dist/extension.js is missing — run `control-vscode.mjs build`. The host loads dist/, never src/.");
  else if (!build.current) hints.push(`dist/ is ${build.sourceNewerBySeconds}s older than src/ — run \`control-vscode.mjs build\` or you will verify the previous build.`);

  if (Object.keys(editors).length === 0) hints.push("No VS Code or Cursor on this machine — `drive` has nothing to launch, and promptster-cli would record no_supported_editor.");

  const installs = {};
  for (const [key, e] of Object.entries(editors)) {
    installs[key] = installedVersion(e.path, id);
    if (e.impersonated) {
      hints.push(
        `\`${EDITORS[key].command}\` resolves to ${e.app} — that is NOT ${EDITORS[key].name}. ` +
        `promptster-cli's detectEditors() would report "${key}" for this machine anyway and claim an install into an editor that is not here.`,
      );
    }
    if (installs[key].error) hints.push(`${EDITORS[key].name}: ${installs[key].error}`);
    else if (!installs[key].installed) hints.push(`${id} is not installed in ${EDITORS[key].name} — \`promptster doctor\` would say so too. Install with \`control-vscode.mjs install --vsix <file>\`, or skip it: \`drive\` loads the extension from source and does not need an install.`);
    else if (installs[key].version !== version) hints.push(`${EDITORS[key].name} has ${id}@${installs[key].version}; this checkout is ${version}. A reviewer reading an attention track cannot tell which collector produced it.`);
  }

  const vsixDir = path.join(REPO, "dist-vsix");
  const vsix = fs.existsSync(vsixDir) ? fs.readdirSync(vsixDir).filter((f) => f.endsWith(".vsix")) : [];

  const wsFlag = flag("workspace", null);
  let workspace = null;
  if (wsFlag && wsFlag !== true) {
    const dir = path.resolve(String(wsFlag));
    const cs = readCaptureState(dir);
    const session = fs.existsSync(path.join(dir, ".promptster/session.json"));
    workspace = { dir, sessionFile: session, captureState: cs };
    if (!session) hints.push(`${dir} has no .promptster/session.json — the extension will activate and correctly capture NOTHING. Make one with \`control-vscode.mjs workspace --dir ${dir}\`.`);
    else if (!cs.present) hints.push(`${dir} has a session but no ${CAPTURE_STATE_FILE} — the extension has never activated here. Installed is not activated, and an installed-but-dormant extension produces a session that reads exactly like a candidate who opened no files.`);
    else if (cs.stale) hints.push(`${CAPTURE_STATE_FILE} in ${dir} is ${cs.ageSeconds}s old — promptster-cli calls that stale past 24h and stops counting it as activated.`);
    else if (cs.state && cs.state.capturing === false) hints.push(`The extension is activated in ${dir} but not capturing: reason "${cs.state.reason}". That may be correct — check it is the reason you expect.`);
  }

  const stragglers = readPids().filter((e) => alive(e.pid));
  if (stragglers.length) hints.push(`${stragglers.length} extension host(s) from a previous run are still alive — run \`control-vscode.mjs cleanup\`.`);

  out({
    ok: hints.length === 0,
    extensionId: id,
    manifestVersion: version,
    build,
    editors,
    installed: installs,
    vsix,
    workspace,
    stragglerHosts: stragglers,
    evidenceDir: EVIDENCE,
    hints,
  });
}

// ---------------------------------------------------------------- cli-detect

/**
 * What promptster-cli would conclude about this machine, computed the way it
 * computes it (editor_extension.go detectEditors + editor_extension_doctor.go
 * installedExtensionVersion).
 *
 * This is the integration that actually matters and the one that breaks
 * quietly: the extension can install perfectly and still be invisible to the
 * CLI, because the CLI matches a marketplace id string that lives in a
 * different repo from the package.json that produces it.
 */
function cliDetect() {
  const CLI_EXPECTS_ID = "promptster.promptster"; // editorExtensionID in promptster-cli
  const { id, version } = extensionId();
  const editors = detectEditors();
  const per = {};
  for (const [key, e] of Object.entries(editors)) per[key] = { ...installedVersion(e.path, CLI_EXPECTS_ID), cli: e.path, actuallyIs: e.appIs };

  const matches = id.toLowerCase() === CLI_EXPECTS_ID;
  const detected = Object.keys(editors);
  const hints = [];
  if (!matches) hints.push(
    `This checkout builds "${id}" but promptster-cli looks for "${CLI_EXPECTS_ID}". ` +
    `The .vsix installs fine and the extension captures fine; \`promptster doctor\` just cannot see it, and reports "not installed" forever.`,
  );
  for (const [key, e] of Object.entries(editors)) {
    if (e.impersonated) hints.push(`The CLI would record editor "${key}" for this machine, but \`${EDITORS[key].command}\` is ${e.app}. The session would name an editor that is not installed.`);
  }
  out({
    ok: hints.length === 0,
    cliExpectsId: CLI_EXPECTS_ID,
    manifestId: id,
    manifestVersion: version,
    idMatchesCLI: matches,
    wouldDetect: detected,
    wouldReport: detected.length === 0 ? "no_supported_editor" : "installed/install_failed per editor",
    perEditor: per,
    hints,
  });
}

// ---------------------------------------------------------------- misc cmds

function build() {
  const r = spawnSync("pnpm", ["run", "compile"], { cwd: REPO, encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) return fail("compile failed", "Fix the TypeScript errors below; the host cannot load a build that does not exist.", { output: (r.stdout || "") + (r.stderr || "") });
  out({ ok: true, ran: "pnpm run compile", build: buildState() });
}

function pkg() {
  const r = spawnSync("scripts/build-vsix.sh", [], { cwd: REPO, encoding: "utf8", timeout: 600_000 });
  const output = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) {
    return fail("build-vsix.sh failed", /working tree is dirty/.test(output)
      ? "The packaging script refuses a dirty tree on purpose — a .vsix built from uncommitted changes has a checksum that identifies nothing. Commit first."
      : "Read the output below.", { output });
  }
  const dir = path.join(REPO, "dist-vsix");
  out({ ok: true, artifacts: fs.readdirSync(dir).map((f) => path.join(dir, f)), output });
}

function install() {
  const vsix = flag("vsix", null);
  if (!vsix || vsix === true) return fail("--vsix <file> is required", "Build one with `control-vscode.mjs package`, or point at dist-vsix/*.vsix.");
  const editors = detectEditors();
  const only = flag("editor", null);
  const results = {};
  for (const [key, e] of Object.entries(editors)) {
    if (only && only !== true && only !== key) continue;
    const r = sh(e.path, ["--install-extension", path.resolve(String(vsix)), "--force"], { timeout: 45_000 });
    results[key] = { ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-3).join("\n") };
  }
  out({ ok: Object.values(results).some((r) => r.ok), results, note: "Installing is not activating. Check `doctor --workspace <dir>` for the capture state before believing it works." });
}

function uninstall() {
  const { id } = extensionId();
  const results = {};
  for (const [key, e] of Object.entries(detectEditors())) {
    const r = sh(e.path, ["--uninstall-extension", id], { timeout: 45_000 });
    results[key] = { ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-2).join("\n") };
  }
  out({ ok: true, results });
}

function workspaceCmd() {
  const dir = flag("dir", null);
  const target = dir && dir !== true ? path.resolve(String(dir)) : fs.mkdtempSync(path.join(HOME_STATE_DIR(), "ws-"));
  const patch = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") {
      const [k, ...rest] = String(argv[i + 1]).split("=");
      const v = rest.join("=");
      patch[k] = v === "true" ? true : v === "false" ? false : v === "null" ? undefined : v;
    }
  }
  fs.mkdirSync(target, { recursive: true });
  const made = makeWorkspace(target, patch);
  out({ ok: true, ...made, captureState: readCaptureState(target) });
}

function stateCmd() {
  const ws = flag("workspace", null);
  if (!ws || ws === true) return fail("--workspace <dir> is required", "Point at the workspace you drove.");
  const dir = path.resolve(String(ws));
  const cs = readCaptureState(dir);
  if (!cs.present) return fail(`no ${CAPTURE_STATE_FILE} in ${dir}`,
    "The extension has not activated in this workspace. Run `drive --workspace <dir>`, and remember: installed is not activated.", { workspace: dir });
  out({ ok: true, workspace: dir, ...cs });
}

function cleanup() {
  const killed = [], left = [];
  for (const e of readPids()) {
    if (!alive(e.pid)) continue;
    // Only pids this CLI recorded, and only ones whose command line still names
    // the repo we drive. Never by process name — that would kill the editor the
    // user is working in.
    const ps = sh("/bin/ps", ["-o", "command=", "-p", String(e.pid)]);
    if (ps.status === 0 && ps.stdout.includes(REPO)) { try { process.kill(e.pid, "SIGTERM"); killed.push(e.pid); } catch { /* raced */ } }
    else left.push({ pid: e.pid, why: "command line no longer names this repo — not ours to kill" });
  }
  writePids([]);
  const runs = fs.existsSync(HOME_STATE) ? fs.readdirSync(HOME_STATE).filter((f) => f.startsWith("run-") || f.startsWith("ws-")) : [];
  for (const r of runs) fs.rmSync(path.join(HOME_STATE, r), { recursive: true, force: true });
  out({
    ok: true, killed, left, removedRunDirs: runs.length,
    evidenceDir: EVIDENCE,
    evidenceKept: fs.existsSync(EVIDENCE) ? fs.readdirSync(EVIDENCE).length : 0,
    note: "Evidence is never removed by cleanup. A verification whose artifacts were torn down with the instance proved nothing.",
  });
}

function help() {
  out({
    ok: true,
    usage: "node .agents/skills/verify-vscode/control-vscode.mjs <command> [flags]",
    commands: {
      doctor: "[--workspace DIR]  is this checkout/machine worth driving?",
      build: "compile src/ to dist/ (the host loads dist/)",
      package: "build the reproducible .vsix via scripts/build-vsix.sh (needs a clean tree)",
      workspace: "[--dir DIR] [--session k=v ...]  a workspace with a live .promptster/session.json",
      drive: "[--workspace DIR] [--commands a,b] [--editor vscode|cursor] [--timeout S] [--keep-open]  launch a real Extension Development Host, activate, invoke, read back",
      state: "--workspace DIR  read .promptster/editor-capture.json with staleness",
      "cli-detect": "what promptster-cli would conclude about this machine",
      install: "--vsix FILE [--editor KEY]   uninstall: remove it again",
      cleanup: "kill hosts this CLI started, drop run dirs, KEEP evidence",
    },
    contributedCommands: contributedCommands(),
    evidenceDir: EVIDENCE,
  });
}

// ---------------------------------------------------------------- dispatch

const COMMANDS = {
  doctor, build, package: pkg, workspace: workspaceCmd, drive,
  state: stateCmd, "cli-detect": cliDetect, install, uninstall, cleanup, help,
};

if (!cmd || !COMMANDS[cmd]) {
  out({ ok: false, error: cmd ? `unknown command: ${cmd}` : "no command given", hint: `Run \`help\`. Known: ${Object.keys(COMMANDS).join(", ")}` });
  process.exit(1);
}
await COMMANDS[cmd]();
