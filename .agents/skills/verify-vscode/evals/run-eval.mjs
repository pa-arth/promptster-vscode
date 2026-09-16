#!/usr/bin/env node
// run-eval — measure how good an agent actually is at verifying this extension.
//
// The method: inject a real defect into the extension, rebuild it, hand a FRESH
// agent session the verify-vscode skill and one instruction ("verify feature X"),
// and see whether it comes back FAIL. Control cases inject nothing and must come
// back PASS. Everything is scored against ground truth we planted, so the
// numbers are not self-reported.
//
// What it produces:
//   detection   — of the broken runs, how many the agent caught   (recall)
//   falseAlarm  — of the healthy runs, how many it wrongly failed (precision cost)
//   evidence    — how often it actually drove a host and kept the artifact
//   costs       — wall time per case
//
// Usage:
//   node run-eval.mjs --validate                 # anchors only, no agent, no cost
//   node run-eval.mjs --agent claude
//   node run-eval.mjs --agent codex --case pause-silently-fails
//   node run-eval.mjs --all-agents

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(HERE);
const REPO = path.resolve(SKILL, "..", "..", "..");
const CASES = path.join(HERE, "cases");
const RESULTS = path.join(HERE, "results");
const CONTROL = path.join(SKILL, "control-vscode.mjs");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
};

const AGENTS = {
  claude: (prompt) => ["claude", ["-p", prompt, "--permission-mode", "bypassPermissions"]],
  codex: (prompt) => ["codex", ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt]],
  cursor: (prompt) => ["cursor-agent", ["-p", prompt, "--force"]],
};

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: REPO, ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ out: String(e.message), ms: Date.now() - t0, code: -1 }));
    child.on("close", (code) => resolve({ out, ms: Date.now() - t0, code }));
  });

const loadCases = () =>
  fs.readdirSync(CASES).filter((f) => f.endsWith(".json")).sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(CASES, f), "utf8")) }));

// ------------------------------------------------------------ defect injection

/**
 * Anchors must match exactly once. If one stops matching, the extension changed
 * under the case: fix the case, never loosen the anchor. A loosened anchor
 * silently starts injecting somewhere else, and the eval then measures nothing
 * while still printing a score.
 */
function checkAnchor(defect) {
  const file = path.join(REPO, defect.file);
  if (!fs.existsSync(file)) return { ok: false, why: `file does not exist: ${defect.file}` };
  const original = fs.readFileSync(file, "utf8");
  const hits = original.split(defect.find).length - 1;
  if (hits !== 1) return { ok: false, why: `anchor matched ${hits}× in ${defect.file}, must match exactly 1×` };
  return { ok: true, original, file };
}

function compile() {
  const r = spawnSync("pnpm", ["run", "compile"], { cwd: REPO, encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`compile failed after injection:\n${(r.stdout || "") + (r.stderr || "")}`);
}

function inject(defect) {
  const a = checkAnchor(defect);
  if (!a.ok) throw new Error(`${a.why}. The extension changed under the case — fix the case, do not loosen the anchor.`);
  fs.writeFileSync(a.file, a.original.replace(defect.find, defect.replace));
  // The host loads dist/, not src/. An injected defect that is never compiled
  // is not in the running extension, and the whole run scores the healthy build.
  if (defect.rebuild !== false) compile();
  return () => {
    fs.writeFileSync(a.file, a.original);
    if (defect.rebuild !== false) { try { compile(); } catch { /* revert must not throw */ } };
  };
}

// ------------------------------------------------------------ verdict parsing

// The verdict is read from a FILE the agent writes, never scraped from its
// output. Scraping was actively wrong: these TUIs echo the prompt back, so the
// instruction lines "VERDICT: PASS / or / VERDICT: FAIL" appear in the
// transcript verbatim and the parser read MY OWN PROMPT as the agent's answer.
// That scored a confident verdict for runs where the agent sat at a permission
// dialog and executed nothing at all.
function readVerdict(verdictFile) {
  if (!fs.existsSync(verdictFile)) return { verdict: null, reason: "agent wrote no verdict file" };
  const raw = fs.readFileSync(verdictFile, "utf8").trim().toUpperCase();
  try { fs.unlinkSync(verdictFile); } catch { /* best effort */ }
  if (raw === "PASS" || raw === "FAIL") return { verdict: raw, reason: null };
  return { verdict: null, reason: `verdict file held ${JSON.stringify(raw.slice(0, 40))}, not PASS or FAIL` };
}

// Did it actually drive something, rather than reading source and reasoning?
const sawEvidence = (out) => /promptster-verify|drive-\d{4}-|editor-capture\.json/.test(out);

// ------------------------------------------------------------ main

const PROMPT = (feature, verdictFile) => `Use the verify-vscode skill to verify the "${feature}" feature of this VS Code extension is working correctly right now.

Drive the real extension with the control CLI — launch an Extension Development Host and observe what the extension actually does. Do not read the source code to decide your answer. Clean up any host you start.

When you have decided, write your verdict to this exact path, as a file whose
entire contents are one word, either PASS or FAIL:

${verdictFile}

For example: printf PASS > ${verdictFile}

PASS means the feature works as its feature-map file says it should. FAIL means it does not. Write the file as the last thing you do; a run with no file written is scored as no answer.`;

function validate() {
  const rows = loadCases().map((c) => {
    if (!c.defect) return { case: c.id, file: c.file, anchor: "n/a (control case)", ok: true };
    const a = checkAnchor(c.defect);
    return { case: c.id, file: c.file, target: c.defect.file, ok: a.ok, why: a.why };
  });
  const bad = rows.filter((r) => !r.ok);
  process.stdout.write(JSON.stringify({
    ok: bad.length === 0,
    checked: rows.length,
    ...(bad.length ? { error: "one or more anchors do not match exactly once", hint: "Fix the case to match the current source. Never loosen an anchor to make it match again." } : {}),
    anchors: rows,
  }, null, 2) + "\n");
  process.exit(bad.length === 0 ? 0 : 1);
}

async function main() {
  if (flag("validate")) return validate();
  fs.mkdirSync(RESULTS, { recursive: true });

  const agentNames = flag("all-agents") ? Object.keys(AGENTS) : [String(flag("agent", "claude"))];
  for (const a of agentNames) if (!AGENTS[a]) { console.error(`unknown agent: ${a}. Known: ${Object.keys(AGENTS).join(", ")}`); process.exit(1); }

  const only = flag("case");
  let cases = loadCases();
  if (typeof only === "string") cases = cases.filter((c) => c.id === only);
  if (!cases.length) { console.error("no cases matched"); process.exit(1); }

  // Fail fast rather than scoring an agent against an extension that cannot run.
  const doc = await run("node", [CONTROL, "doctor"]);
  let health; try { health = JSON.parse(doc.out); } catch { health = null; }
  const runnable = Object.entries(health?.editors ?? {}).filter(([, e]) => e.ok);
  if (!health?.build?.compiled || runnable.length === 0) {
    console.error(JSON.stringify({
      ok: false,
      error: !health?.build?.compiled ? "dist/ is not built" : "no editor on this machine to host the extension",
      hint: "Run `node .agents/skills/verify-vscode/control-vscode.mjs build`, and install VS Code or Cursor. Scoring an agent against an extension that cannot load measures nothing.",
      doctor: health,
    }, null, 2));
    process.exit(1);
  }

  const runs = [];
  for (const agent of agentNames) {
    for (const c of cases) {
      let revert = () => {};
      try {
        if (c.defect) revert = inject(c.defect);
        const verdictFile = path.join(HERE, `.verdict-${agent}-${c.id}.txt`);
        try { fs.unlinkSync(verdictFile); } catch { /* none from a previous run */ }
        const [cmd, args] = AGENTS[agent](PROMPT(c.feature, verdictFile));
        const res = await run(cmd, args);
        const { verdict, reason } = readVerdict(verdictFile);
        const correct = verdict === null ? null : verdict === c.expect;
        runs.push({
          agent, case: c.id, feature: c.feature, expect: c.expect, got: verdict,
          correct, invalid: reason, evidence: sawEvidence(res.out), ms: res.ms,
          detects: c.detects ?? null,
          transcriptTail: (reason || correct === false) ? String(res.out).slice(-6000) : undefined,
          exitCode: (reason || correct === false) ? res.code : undefined,
        });
        console.error(`${correct === true ? "HIT " : correct === false ? "MISS" : "INV "} ${agent}/${c.id} expect=${c.expect} got=${verdict ?? "-"} ${(res.ms / 1000).toFixed(0)}s`);
      } catch (e) {
        const error = String(e.message || e);
        runs.push({ agent, case: c.id, error });
        console.error(`ERR  ${agent}/${c.id}: ${error}`);
      } finally {
        // Always, so a crashed run never leaves the extension broken on disk.
        revert();
        // And never leave a host holding memory between cases.
        await run("node", [CONTROL, "cleanup"]);
      }
    }
  }

  const score = (agent) => {
    const mine = runs.filter((r) => r.agent === agent && !r.error);
    const broken = mine.filter((r) => r.expect === "FAIL");
    const healthy = mine.filter((r) => r.expect === "PASS");
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
    return {
      agent,
      scored: mine.length,
      detection: { caught: broken.filter((r) => r.correct).length, of: broken.length, pct: pct(broken.filter((r) => r.correct).length, broken.length) },
      falseAlarm: { wrongFails: healthy.filter((r) => r.correct === false).length, of: healthy.length, pct: pct(healthy.filter((r) => r.correct === false).length, healthy.length) },
      invalidVerdicts: mine.filter((r) => r.invalid).length,
      drove: { n: mine.filter((r) => r.evidence).length, of: mine.length, pct: pct(mine.filter((r) => r.evidence).length, mine.length) },
      medianSeconds: mine.length ? Math.round(mine.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(mine.length / 2)] / 1000) : null,
    };
  };

  const report = { ranAt: new Date().toISOString(), scores: agentNames.map(score), runs };
  const file = path.join(RESULTS, `${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, runs: undefined, reportFile: file }, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
