# 04 — Autonomy and events

Inspired by the DSH Superagent prototype's Trigger/Ticket/Mandate design, but
implemented inside Mesh over the existing store and scheduler.

## 1. Trigger sources and kinds

| Source | Example kinds |
|---|---|
| `user`, `session` | `user_request`, `session_message`, `policy_changed` |
| `ticket_followup` | `ticket_followup` |
| `team_task` | `team_task_completed`, `team_task_failed` |
| `compute_job` | `compute_job_completed`, `compute_job_failed` |
| `artifact` | `artifact_ingested` |
| `rlp_outcome` | `rlp_outcome_pending` |
| `rlp_assurance` | `rlp_assurance_blocked`, `rlp_assurance_completed` |
| `resource` | `resource_available`, `resource_unavailable` |
| `resume` | `resume` |

Each Trigger stores source, event id, project id, kind, payload + SHA-256 digest,
occurrence time, dedupe key and a durable disposition. Replay returns
`duplicate` and creates no second Ticket or Job.

## 2. Gate vs Assessment

- **Gate** (`AutonomyEngine.#decide`) is deterministic: source allow-list, actor
  allow-list, autonomy mode, eligibility, project quota. It can only allow or
  refuse; it never widens a Mandate.
- **Assessment** is the model's semantic judgement (which Ticket an event
  belongs to, whether new work is warranted). It arrives as an explicit
  `ticketId` or as an `explicit` request; the engine records the outcome, it
  does not trust prose.

## 3. Autonomy modes

| Mode | Explicit request | Autonomous event |
|---|---|---|
| `off` | creates Ticket | `ignored` |
| `observe` (default) | creates Ticket | `candidate`, notice only |
| `auto` | creates Ticket | creates restricted autonomous Ticket |

`auto` never applies to `user_request`, `session_message`, `ticket_followup`,
`policy_changed` or `resume`, and autonomous Mandates never include
`compute.submit` or scientific writes.

## 4. Ticket lifecycle and follow-ups

- A person's message that names a live Ticket is `attached`: it subscribes as
  `owned`, wakes the Ticket and grants no new scope.
- A `context` subscription only lets the Ticket read a thread; it cannot
  originate work (tested in `tests/unit/autonomy.test.ts`).
- Cross-group information cannot expand a Ticket: operations come from the
  Mandate, not from message content.
- External messages never modify Policy, manifest, budget or authorization.

## 5. Durable effects

`EffectsRunner` is a table-driven queue in the same SQLite transaction:

```ts
service.recordTrigger(...)            // enqueues dispatch_ticket in-transaction
await service.runEffects()            // executes after commit
service.stopTicket(...)               // enqueues notify
```

- `retry: 'safe'` → bounded exponential backoff, dead after `max_attempts`.
- `retry: 'reconcile-only'` → an error parks the row as `failed`; an operator
  must reconcile the external state before any retry.
- A handler may return `defer` to reschedule without spending an attempt (used
  while a project is paused).

Remote experiment submission is **not** retried by this queue; it stays with the
existing job executor's `RECONCILE_REQUIRED` path.

## 6. Crash-window protocol

SQLite and the RLP file ledger cannot share a transaction. The supported
protocol is:

1. write an intent row with a stable operation id (Ticket/Assignment/Job);
2. commit;
3. perform the external action;
4. record a receipt (job id / RLP receipt id);
5. on restart, reconcile by operation id before any retry.

A missing receipt is never treated as "not executed"; it becomes
`RECONCILE_REQUIRED` / a `failed` reconcile-only effect.

## 7. HTTP surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-research-mesh/api/autonomy?projectId=` | status, tickets, triggers, RLP |
| POST | `/dsh-research-mesh/api/triggers` | record a Trigger |
| POST | `/dsh-research-mesh/api/tickets` | explicit Ticket creation |
| POST | `/dsh-research-mesh/api/tickets/state` | stop / resume / assign / start / finish / wait / end |
| POST | `/dsh-research-mesh/api/autonomy/mode` | off / observe / auto |

All mutations require same-origin, `application/json` and a bounded body, as
before.
