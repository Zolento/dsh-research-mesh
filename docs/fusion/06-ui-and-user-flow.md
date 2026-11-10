# 06 — UI and user flow

The existing Projects → Project Workbench shell is kept. No Superagent panel is
copied, and no DSH upstream file is modified.

## 1. Projects

Unchanged entry and list. Each project shows name, goal, status, group count and
RLP readability. Linking an existing RLP checkout now also reports:

- detected storage root (`new` / `legacy` / `ambiguous` / `none`);
- that a legacy-only checkout needs an explicit migration before formal runs.

## 2. Workbench

Sections, top to bottom:

1. **Header** — back, name, status, discussion, simulation, pause/resume.
2. **Research State** — RLP `state_version`, goal, advisory next phase,
   uncertainties, experiments, scheduler actions. Mesh never invents a stage.
3. **Tickets** *(new)* — one row per Ticket:
   - title, route, explicit vs autonomous;
   - status (`open`, `running`, `waiting_compute`, `waiting_evidence`,
     `waiting_human`, `ended`);
   - assigned group;
   - actions: **Stop** (revokes the Mandate; confirms) and **Resume**
     (explicit re-authorization; disabled for stopped tickets).
4. **Groups** — route, worktree branch, current task, Captain/member sessions,
   models, expanded details.
5. **Execution** — Mesh jobs, GPU leases, artifact state; text states that
   execution completion is not a scientific PASS.
6. **Activity** — decision-relevant events only.

## 3. New interactions

| Action | Effect |
|---|---|
| Stop Ticket | `stopTicket`; Mandate revoked; pending assignments cancelled; no event can undo |
| Resume Ticket | explicit resume; policy change issues a new Mandate |
| Autonomy mode | `off` / `observe` / `auto` via API; default `observe` |
| RLP badge | version + storage status; legacy root shows `MIGRATION_REQUIRED` |

## 4. Presentation rules

- Human attention first: waiting-human tickets and failed effects sort above
  routine activity.
- Internal ids, JSON and file paths stay in details/diagnostics.
- A blocked scientific gate is shown as "waiting for RLP evidence", never as
  "done" or "failed experiment".
- Status colour only for running / attention / failure / verified.
- Responsive breakpoints 1440 / 1280 / 768 / 390 keep the existing layout; the
  Tickets list uses the same row pattern as Groups (wraps, no horizontal
  overflow).

## 5. Settings

Existing model settings are unchanged: Group default, Captain override, Member
override, explicit provider/model, no fallback. RLP-specific settings are
deliberately minimal: `rlp.skillPath` (optional), `rlp.autonomyMode`,
`rlp.autonomyPolicyVersion`. No scientific knob is exposed in the UI.

## 6. Verification

`node scripts/ui-acceptance.mjs` passed on an isolated `DSH_HOME` and profile
(port 3311, headless Chrome): project creation, three groups, Captain/member
sessions, model settings persistence, dark appearance, and no horizontal
overflow at 1440 / 1280 / 768 / 390. The Workbench capture now includes the
Tickets section (`docs/screenshots/workbench-1440.png`).

Visible labels were renamed from RSI to RLP, including the advisory phase, the
state-read error and the scientific note. API fields such as `rsiReadable` /
`rsiVersion` keep their names as compatibility aliases.

## 7. Not in this version

- Project deletion and worktree cleanup stay API-only.
- A full decision-trace viewer is not built; the event list links to RLP state.
- Ticket stop/resume is exercised by unit/integration tests; the acceptance
  script does not click those buttons yet.
