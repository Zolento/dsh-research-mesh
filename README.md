# DSH Research Mesh

A durable, recoverable multi-group research runtime for **DeepSeek Harness
(DSH)**, integrated with the **Research Lifecycle Protocol (RLP v2.2.0)**.

DSH runs agents. RLP owns scientific method, evidence gates and the canonical
Research State. Research Mesh owns projects, groups, Git worktrees, tickets,
task scheduling, remote jobs, artifact ingestion and the Web control surface.

## Purpose

- Turn a canonical RLP Git checkout into a durable research project.
- Run up to **3 Research Groups**, **4 members per group**, **12 total**.
- Isolate each group in an external `mesh/<group>` Git worktree.
- Carry long-lived work in **Tickets** with explicit **Mandates**, executed
  through **Assignments** bound to native Agent Teams or compute jobs.
- Schedule and recover local/SSH experiments through SQLite-backed state.
- Keep execution results at `ASSURANCE_PENDING`; Mesh never declares a
  scientific PASS.
- Load RLP context as **L0 / L1 / L2** on demand — never the whole protocol.

## Principles

1. **One canonical checkout.** Git worktrees are temporary checkouts, not route
   copies and not a second scientific authority.
2. **External control state.** Mesh `controlDir`, worktrees and large artifacts
   live outside the canonical checkout; artifacts default to the configured
   store, e.g. `/data/<user>/<project>_store/`.
3. **RLP state is read-only to Mesh.** Mesh reads
   `<project>/.research-lifecycle-protocol/routes/<R>/research-state.json`;
   only RLP's legal write entries may update it.
4. **Durable by default.** Tickets, mandates, assignments, effects, tasks, jobs
   and leases are persisted in SQLite; crash recovery never silently reruns a
   consumed receipt.
5. **Isolation is not a sandbox.** Git worktrees isolate files, not the OS,
   network or GPU. Operators must check Mesh leases, the RLP scheduler and the
   real GPU process together.
6. **One project per DSH profile.** Each profile owns one executable source,
   its own model settings, quotas and control DB; use another profile for a
   second project. Do not load one profile twice.

## Autonomy and tickets

Mesh records project-scoped events as immutable **Triggers** (dedupe key,
payload digest, source, actor). A deterministic Gate decides what may happen:

| Mode | Explicit request | Autonomous event |
|---|---|---|
| `off` | creates a Ticket | ignored |
| `observe` (default) | creates a Ticket | recorded as a candidate, no work |
| `auto` | creates a Ticket | restricted autonomous Ticket within policy ceilings |

A **Mandate** records issuer, route, scope, allowed operations, resource ceiling,
RLP scope and policy version; it is immutable and can only be revoked. A
**Ticket** may have several **Assignments**, but never two active ones. A
successful execution parks the Ticket at `waiting_evidence`; only RLP's outcome
gate can end it as completed.

## Relationship to RLP

| Artifact | Repository / location |
|---|---|
| RLP skill | <https://github.com/Zolento/my-research-skills> (`research-lifecycle-protocol`) |
| RLP release | `research-lifecycle-protocol/v2.2.0` |
| RLP installed skill | `~/.agents/skills/research-lifecycle-protocol` |
| Runtime root | `<project>/.research-lifecycle-protocol/` |
| Legacy root (read-only) | `<project>/.research-idea-pipeline/` |
| Shared contract id | `dsh-research-mesh/mesh-collaboration@1` |

The three layers must stay aligned: RLP defines the canonical research layout,
the project `AGENTS.md` fixes checkout/worktree/store rules, and this plugin
enforces the Mesh side (external control/worktrees, one executable source, RLP
state read-only, consumed-ledger recovery, group and ticket controls).

## Install and verify

Verified against **DSH 0.2.2-rc.1** (Node 24) and RLP **v2.2.0**.

```bash
cd dsh-research-mesh
node scripts/link-toolchain.mjs
npm run typecheck
npm run test:all          # 167 tests

# isolated Web UI acceptance (does not touch the user's profile)
node scripts/ui-acceptance.mjs
node scripts/check-dsh.mjs
```

If a linked checkout boots with
`Cannot find package '@deepseek-ai/schemastery'`, its local dependency link is
stale (usually after removing a temporary DSH install). From the checkout:

```bash
node scripts/link-toolchain.mjs
node scripts/check-dsh.mjs
```

Then restart the profile. Do not fix this by copying a package into the DSH
global tree.

Install into a profile:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-research-mesh
```

Then configure `projectRoot`, `sourceDir`, `controlDir`, `worktreesDir` and
(optionally) `artifactsDir`, plus `rlp.skillPath` when RLP is not in the default
location. See [`examples/config.example.yml`](examples/config.example.yml).

## Profiles: one project per DSH profile

```text
web          → MoSA (current)
web-3dzssl   → 3D_ZS_SSL
web-<slug>   → another canonical Git project
```

Each profile owns its own `projectRoot` / `sourceDir`, control SQLite DB, group
quotas, worktrees and GPU leases, model assignments, artifact store, Web port
and token. Profiles do **not** share controlDir, worktreesDir or artifactsDir.
The RLP skill installation and the external store medium are shared.

Create a profile once:

```bash
dsh --profile web-3dzssl --from-default-profile web --dump-config
dsh plugin --profile web-3dzssl add /home/lenovo/code/dsh-plugins/dsh-research-mesh
dsh --profile web-3dzssl web --port 3081
```

After that, open Research Mesh in that profile and link the project. RLP routes
are detected and the default control/worktrees/artifacts directories are
initialized automatically. Profile creation itself is one-time and cannot be
done from the running plugin UI.

See [PROFILE-PER-PROJECT.md](docs/PROFILE-PER-PROJECT.md) and the
[example profile config](examples/profile-per-project.example.yml).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Requirements (v0.1.0, RSI-era; RLP v2.2 supersedes naming)](docs/REQUIREMENTS.md)
- [Canonical checkout + Mesh worktrees](docs/MESH-OPERATING-RULES.md)
- [One profile per project](docs/PROFILE-PER-PROJECT.md)
- [Project onboarding](docs/PROJECT-ONBOARDING.md)
- [MoSA migration](docs/MOSA-MESH-MIGRATION.md)
- [DSH 0.2.2-rc.1 adaptation](docs/DSH-0.2.2-rc1.md)
- [Tests and evidence](docs/TESTING.md)
- [Current status and limits](docs/STATUS.md)
- Audit fixes: [10-audit-fixes.md](docs/fusion/10-audit-fixes.md)
- Fusion design: [audit](docs/fusion/00-base-audit.md) ·
  [architecture](docs/fusion/01-architecture.md) ·
  [authority](docs/fusion/02-authority-and-state.md) ·
  [RLP integration](docs/fusion/03-rlp-v2.2-integration.md) ·
  [autonomy](docs/fusion/04-autonomy-and-events.md) ·
  [runtime](docs/fusion/05-runtime-and-recovery.md) ·
  [UI](docs/fusion/06-ui-and-user-flow.md) ·
  [test evidence](docs/fusion/07-test-evidence.md) ·
  [migration](docs/fusion/08-migration-and-rollback.md) ·
  [final audit](docs/fusion/09-final-audit.md)

## Release tag

Tag format includes the DSH baseline:

```text
dsh-research-mesh-v<plugin-version>-dsh<adapted-dsh-version>
```

Example for this branch:

```text
dsh-research-mesh-v0.2.0-dsh0.2.2-rc.1
```

The last component is the DSH version the release is verified against, not the
plugin's dependency range. Tag only after `typecheck`, `test:all`,
`check-dsh` and (for UI changes) `ui-acceptance` pass on that commit.
