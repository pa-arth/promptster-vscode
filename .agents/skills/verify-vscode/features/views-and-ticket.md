# Assessment views & ticket editor

The activity-bar container and what lives in it. This is the candidate's actual
workspace furniture during a ticket-flow assessment: the brief, the teammates,
and the rendered ticket.

## Sub-features

From `contributes` — a view container plus two webview views and a custom editor:

- **Container `promptster`** — activity bar, title "Promptster",
  icon `assets/activity.svg`.
- **View `promptster.assessment`** — webview, name "Assessment", shown
  `when: promptster.assessmentWorkspace`. Provider `AssessmentView`
  (`src/ui/assessment.ts`). Buttons: *Open ticket*, *Open <specFile>*, one
  *Open <tool>* per enabled tool, *Review & submit*.
- **View `promptster.teammates`** — webview, name "Teammates", shown
  `when: promptster.ticketFlow`. Provider `TeammatesView`
  (`src/ui/teammates.ts`). Lists personas from
  `GET {apiUrl}/v1/sessions/{id}/teammates` and sends messages to them.
- **Custom editor `promptster.ticket`** — viewType `promptster.ticket`, selector
  `TASK.html`, priority `default`. `TicketEditor` renders the document inside a
  webview with `enableScripts: false` and a `default-src 'none'` CSP.
- **Auto-generated commands** — VS Code synthesises `promptster.teammates.focus`,
  `.open` and `.resetViewLocation` for the view. They are real and appear in the
  registry; they are not in `contributes.commands`.

## How to get to it (user POV)

Click the Promptster icon in the activity bar. The views appear only when their
context key is set, so on a workspace with no assessment the container is there
and empty.

## Driving it with control-vscode

```bash
CV=.agents/skills/verify-vscode/control-vscode.mjs
node $CV workspace --dir /tmp/pv-views
node $CV drive --workspace /tmp/pv-views --commands promptster.teammates.focus
```

The generated workspace has a session but **no `assessment.json`**, so
`promptster.assessmentWorkspace` stays false and the Assessment view stays
hidden. To exercise it, add the brief yourself before driving:

```bash
cat > /tmp/pv-views/assessment.json <<'JSON'
{"id":"inv-907","title":"Can the inventory launch go ahead?","specFile":"handoff.spec"}
JSON
printf '# Ticket\n- stale stock\n' > /tmp/pv-views/TASK.md
node $CV drive --workspace /tmp/pv-views --keep-open
```

## Proves it works

- `commands` in the drive result contains the `promptster.teammates.*` entries —
  that is the view actually being registered with the workbench, not just
  declared. Their absence means `registerWebviewViewProvider` did not run.
- With `assessment.json` present and a consented, unexpired session, the
  Assessment view appears in the container and shows the brief `id` and `title`
  from that file, plus one tool button per entry in the session's `tools`. With
  the brief absent it shows "Open your assessment to begin." Both are correct
  states; which one you get is decided by the workspace you built.
- *Open ticket* creates `TASK.html` in the workspace root (from `TASK.md`) and
  opens it with viewType `promptster.ticket` — the rendered ticket, not raw HTML
  source. Check the file appeared on disk; that is the observable side effect.
- The Teammates view is visible only after a successful `teammates` API call sets
  `promptster.ticketFlow`. Against the generated workspace's dead `apiUrl` it
  correctly stays hidden and posts an error state.

## Gotchas

- **Both views are gated on context keys the extension sets itself**, from
  `setContext` calls in `assessment.ts` (`promptster.assessmentWorkspace`) and
  `teammates.ts` (`promptster.ticketFlow`). A hidden view is therefore ambiguous:
  it means "the gate is closed", which may be correct. Establish the gate state
  before concluding the view is broken — the gate is the single most common
  reason a proof here verifies nothing.
- **Teammates needs a reachable backend.** The generated workspace points
  `apiUrl` at `http://127.0.0.1:9`, which refuses instantly and deliberately.
  Everything teammates-shaped will be an error state. That is an environment
  limit, not a bug in the feature; do not file it, and do not score a run against
  it. To verify teammates for real, point the workspace session at a backend you
  control (`node $CV workspace --dir … --session apiUrl=http://localhost:8787`).
- **`not_ticket_flow` is a legitimate answer, not a failure.** The view remembers
  that session id and stops asking. An empty Teammates view on a non-ticket-flow
  session is correct.
- **`TASK.html` is written with `flag: 'wx'`** — it is created once and never
  overwritten. A second *Open ticket* on a workspace that already has one opens
  the existing file. If you are verifying a change to `renderTicket()`, delete
  `TASK.html` first or you will be looking at the previous render.
- **The ticket editor runs with scripts disabled and `localResourceRoots: []`.**
  Only public ticket text is rendered and markdown HTML is escaped to text. A
  change that enables scripts to make something render is a security regression,
  not a fix.
- **Webview DOM is not readable from the probe.** As with the consent panel,
  `drive` proves registration and side effects on disk; proving what the view
  *displays* needs `--keep-open` and a human, or the existing unit tests
  (`test/unit/assessment.test.ts`, `test/unit/teammates.test.ts`,
  `test/unit/ticket.test.ts`). Say which one you did.
