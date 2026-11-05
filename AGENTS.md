# dsh-research-mesh development contract

**Collaboration contract:** `dsh-research-mesh/mesh-collaboration@1`.

This file governs development of the plugin. The project-level operating rules
live in the target repository's `AGENTS.md`; the RSI skill carries the matching
worktree dispatch note. Keep these three in sync.

## Hard boundaries

- Do not modify the `deepseek-harness` upstream checkout.
- Do not create a Mesh group, submit a real experiment or write canonical RSI
  state without explicit user approval.
- Never print API keys, relay tokens, cookies or credentials.
- The plugin reads `.research-idea-pipeline/routes/<R>/research-state.json`;
  it never writes that file. The only state changes belong to the RSI skill or
  the human.
- The canonical checkout is the only executable `sourceDir`. Mesh control and
  worktrees stay outside it; worktrees use `mesh/<group>` branches.
- Large artifacts go to the configured `artifactsDir` (MoSA:
  `/data/zhanglt/MoSA_store/mesh/artifacts`), never to the canonical checkout.
- A group worktree starts from `HEAD`; canonical uncommitted changes are not
  copied automatically.
- One DSH profile has one executable source root. Other projects are read-only.

## Verification required

```bash
npm run typecheck
npm run test:all
node scripts/check-dsh.mjs
node scripts/ui-acceptance.mjs
```

`test:all` must remain green; the UI acceptance uses an isolated profile and
must not touch the running user profile. Report the exact counts and any
remaining limitations. Do not push or deploy.

## Documentation

- Plugin behavior: `docs/MESH-OPERATING-RULES.md`
- Project onboarding: `docs/PROJECT-ONBOARDING.md`
- MoSA migration: `docs/MOSA-MESH-MIGRATION.md`
- Live evidence: `docs/LIVE-GPU-SCENARIO.md`, `docs/LIVE-SSH-NATIVE.md`

Modifying the contract requires updating the plugin docs, the target project
`AGENTS.md`, and the skill's `project-layout.md`/`SKILL.md` notes together.
