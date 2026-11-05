# DSH Research Mesh

A durable, recoverable multi-group research runtime for **DeepSeek Harness
(DSH)**, built for the **Research Idea Pipeline (RSI)** skill.

DSH runs agents. RSI owns scientific method, evidence gates and Research State.
Research Mesh owns projects, groups, Git worktrees, task scheduling, remote jobs,
artifact ingestion and the Web control surface.

## Purpose

- Turn a canonical RSI Git checkout into a durable research project.
- Run up to **3 Research Groups**, **4 subagents per group**, **12 total**.
- Isolate each group in an external `mesh/<group>` Git worktree.
- Schedule and recover local/SSH experiments through SQLite-backed state.
- Keep execution results at `ASSURANCE_PENDING`; Mesh never declares a
  scientific PASS.

## Principles

1. **One canonical checkout.** Git worktrees are temporary checkouts, not route
   copies and not a second scientific authority.
2. **External control state.** Mesh `controlDir`, worktrees and large artifacts
   live outside the canonical checkout; artifacts default to
   `/data/zhanglt/<project>_store/`.
3. **Canonical RSI state is read-only.** Mesh reads
   `.research-idea-pipeline/routes/<R>/research-state.json`; only the RSI single
   writer may update it.
4. **Durable by default.** Tasks, jobs, leases and bindings are persisted in
   SQLite; crash recovery never silently reruns a consumed receipt.
5. **Isolation is not a sandbox.** Git worktrees isolate files, not the OS,
   network or GPU. Operators must check Mesh leases, RSI scheduler and the real
   GPU process together.
6. **One project per DSH profile.** Each profile owns one executable source,
   its own model settings, quotas and control DB; use another profile for a
   second project. Do not load one profile twice.

## Relationship to RSI and the AGENTS standard

| Artifact | Repository / location |
|---|---|
| RSI skill | <https://github.com/Zolento/my-research-skills.git> |
| RSI installed skill | `~/.agents/skills/rsi-pipeline` |
| AGENTS v2 standard | [`AGENTS_templatev2.md`](AGENTS_templatev2.md) |
| Meshed project rules | target repo `AGENTS.md` §Research Mesh |
| Shared contract id | `dsh-research-mesh/mesh-collaboration@1` |

The three layers must stay aligned:

- RSI `references/project-layout.md` defines the canonical research layout.
- The project `AGENTS.md` fixes the canonical checkout, external worktrees,
  artifact store and solo/team coexistence rules.
- This plugin enforces the Mesh side: external control/worktrees, one executable
  source, RSI state read-only, consumed-ledger recovery and group controls.

## Install and verify

Verified against **DSH 0.2.2-rc.1** (Node 24). The plugin remains compatible
with the declared `engines.dsh` range.

```bash
cd dsh-research-mesh
node scripts/link-toolchain.mjs
npm run typecheck
npm run test:all

# isolated Web UI acceptance (does not touch the user's profile)
node scripts/ui-acceptance.mjs
```

Install into a profile:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-research-mesh
```

Then configure `projectRoot`, `sourceDir`, `controlDir`, `worktreesDir` and
(optionally) `artifactsDir` in the profile's `cordis.patch.yml`.
See [`examples/config.example.yml`](examples/config.example.yml).

## Profiles: one project per DSH profile

A DSH profile is the unit of deployment:

```text
web          → MoSA (current)
web-3dzssl   → 3D_ZS_SSL
web-<slug>   → another canonical Git project
```

Each profile owns its own:

- `projectRoot` / `sourceDir`
- control SQLite DB and group quotas
- worktrees and GPU leases
- model assignments
- artifacts store
- Web port and token

Profiles do **not** share controlDir, worktreesDir or artifactsDir. The RSI
skill installation and `/data/zhanglt` storage medium are shared.

Create a profile once:

```bash
# Only for a profile that does not exist. This REPLACES an existing profile.
dsh --profile web-3dzssl --from-default-profile web --dump-config
dsh plugin --profile web-3dzssl add /home/lenovo/code/dsh-plugins/dsh-research-mesh
```

Then set `projectRoot`, `sourceDir`, `controlDir`, `worktreesDir` and
`artifactsDir` in `~/.dsh/profiles/web-3dzssl/cordis.patch.yml`, and start it on
a distinct port:

```bash
dsh --profile web-3dzssl web --port 3081
```

After that, open Research Mesh in that profile and link the project. The RSI
routes are detected and the default control/worktrees/artifacts/store
directories are initialized automatically. Profile creation itself is one-time
and cannot be done from the running plugin UI; a plain
`dsh --profile web-3dzssl web` does not auto-create the profile.

See [PROFILE-PER-PROJECT.md](docs/PROFILE-PER-PROJECT.md) and the
[example profile config](examples/profile-per-project.example.yml).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Requirements](docs/REQUIREMENTS.md)
- [Canonical checkout + Mesh worktrees](docs/MESH-OPERATING-RULES.md)
- [One profile per project](docs/PROFILE-PER-PROJECT.md)
- [Project onboarding](docs/PROJECT-ONBOARDING.md)
- [MoSA migration](docs/MOSA-MESH-MIGRATION.md)
- [DSH 0.2.2-rc.1 adaptation](docs/DSH-0.2.2-rc1.md)
- [Tests and evidence](docs/TESTING.md)
- [Current status and limits](docs/STATUS.md)

## Release tag

Tag format:

```text
dsh-research-mesh-v<plugin-version>-dsh<adapted-dsh-version>
```

Example:

```text
dsh-research-mesh-v0.1.0-dsh0.2.2-rc.1
```

The last component is the DSH version this release is verified against, not the
plugin's own dependency range.
