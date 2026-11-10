# dsh-research-mesh development contract

**Collaboration contract:** `dsh-research-mesh/mesh-collaboration@1`.
**Scientific authority:** Research Lifecycle Protocol (RLP) v2.2.0, skill
`research-lifecycle-protocol`.

This file governs development of the plugin. The project-level operating rules
live in the target repository's `AGENTS.md`; RLP carries the matching worktree
dispatch note. Keep these three in sync.

## Hard boundaries

- Do not modify the `deepseek-harness` upstream checkout.
- Do not create a Mesh group, submit a real experiment or write canonical RLP
  state without explicit user approval.
- Never print API keys, relay tokens, cookies or credentials.
- The plugin reads `.research-lifecycle-protocol/routes/<R>/research-state.json`;
  it never writes that file. The legacy `.research-idea-pipeline/` root is
  read-only for audit and migration; Mesh never migrates a project.
- The canonical checkout is the only executable `sourceDir`. Mesh control and
  worktrees stay outside it; worktrees use `mesh/<group>` branches.
- Attaching a runnable project creates its default control/worktrees/artifacts
  directories; it never creates RLP state.
- Large artifacts go to the configured `artifactsDir`, never to the canonical
  checkout.
- A group worktree starts from `HEAD`; canonical uncommitted changes are not
  copied automatically.
- One DSH profile has one executable project. Other projects use another profile
  and port.
- A Ticket never widens its Mandate; an autonomous Mandate never runs an
  experiment or writes canonical state.
- A successful execution never ends a Ticket as scientifically complete; it
  parks at `waiting_evidence` until RLP runs its own gates.

## Module map

| Area | Path |
|---|---|
| Plugin entry / host wiring | `src/index.ts` |
| Service facade | `src/service.ts` |
| Autonomy (Trigger/Ticket/Mandate/Assignment/Effects) | `src/autonomy/` |
| RLP discovery, storage matrix, context, subagent contracts | `src/rlp/` |
| Legacy RLP adapter (deprecated, receipt/ledger verification) | `src/rsi/` |
| Projects, teams, workspaces, scheduler, executors, GPU | existing modules |
| HTTP API | `src/host/web-api.ts` |
| Browser bundle | `client/client.js` |
| Fusion design records | `docs/fusion/` |

## Verification required

```bash
npm run typecheck
npm run test:all          # 124 tests at the fusion baseline
node scripts/check-dsh.mjs
node scripts/ui-acceptance.mjs   # for UI changes; isolated profile only
```

`test:all` must remain green; the UI acceptance uses an isolated profile and
must not touch the running user profile. Report exact counts and remaining
limitations. Do not push or deploy.

## Documentation

- Fusion audit and design: `docs/fusion/00..09`
- Plugin behavior: `docs/MESH-OPERATING-RULES.md`
- Project onboarding: `docs/PROJECT-ONBOARDING.md`
- MoSA migration: `docs/MOSA-MESH-MIGRATION.md`
- Live evidence: `docs/LIVE-GPU-SCENARIO.md`, `docs/LIVE-SSH-NATIVE.md`

Modifying the contract requires updating the plugin docs, the target project
`AGENTS.md`, and the RLP skill's `project-layout.md`/`SKILL.md` notes together.
