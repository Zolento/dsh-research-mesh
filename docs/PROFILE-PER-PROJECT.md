# One DSH profile per research project

This is the deployment model for Research Mesh.

> **Profile = one canonical Git project + one DSH Web process.**
> Groups, worktrees and artifacts belong to that project, never to a shared
> "current project" setting.

## Why

- The plugin has exactly one executable `sourceDir` per runtime.
- RLP state, receipts, control DB, worktrees, artifacts and model settings stay
  isolated per project.
- A profile can be paused, restarted or upgraded without touching another
  project.
- It preserves the AGENTS/skill contract: one canonical checkout, external
  worktrees, external store, canonical state read-only.

## Naming

```text
web              # existing profile; currently the MoSA profile
web-mosa         # recommended name when creating a fresh MoSA profile
web-3dzssl       # second project
web-<slug>       # stable kebab-case
```

Do not load the same DSH profile in two Web processes at the same time.

## Per-profile layout

```text
project root:     /home/lenovo/code/myproj/MoSA
profile:          ~/.dsh/profiles/web-mosa
control:          /home/lenovo/code/myproj/.mesh/MoSA
worktrees:        /home/lenovo/code/myproj/.mesh/MoSA/worktrees
artifacts store:  /data/zhanglt/MoSA_store/mesh/artifacts
rsi skill:        ~/.agents/skills/research-lifecycle-protocol   (shared)
RLP state:        <project>/.research-lifecycle-protocol/routes/<R>/research-state.json
```

Each profile has its own:

- `cordis.patch.yml`
- model assignments
- control SQLite DB
- group quotas (3 / 4 / 12)
- GPU leases and jobs
- Web port/token

## Create a profile

### Initialization semantics

- `dsh --profile <new> web` does **not** create a profile; it fails with
  `profile "<new>" does not exist`.
- `dsh --profile <new> --from-default-profile web --dump-config` explicitly
  creates the profile from the shipped **web** template. It **replaces** an
  existing profile of that name, including its user layer, model settings and
  plugins. Use it only when the profile does not exist.
- `dsh plugin --profile <new> add <package>` initializes a missing profile, but
  with the default bundle set, **not** the web template. Create the web profile
  first, then add the plugin.
- Once created, booting the same profile reuses it; it is not reinitialized.

Safe creation:

```bash
if [ -e "$HOME/.dsh/profiles/web-3dzssl" ]; then
  echo "profile already exists; do not pass --from-default-profile"
else
  dsh --profile web-3dzssl --from-default-profile web --dump-config
fi
```

Example for a second project:

```bash
# Materialize the profile from the current web template.
dsh --profile web-3dzssl --from-default-profile web --dump-config

# Install the plugin bundle.
dsh plugin --profile web-3dzssl add /home/lenovo/code/dsh-plugins/dsh-research-mesh

# Edit ~/.dsh/profiles/web-3dzssl/cordis.patch.yml:
```

```yaml
- id: dsh-research-mesh
  name: dsh-research-mesh
  config:
    projectRoot: /home/lenovo/code/myproj/3D_ZS_SSL
    sourceDir: .
    controlDir: /home/lenovo/code/myproj/.mesh/3D_ZS_SSL
    worktreesDir: /home/lenovo/code/myproj/.mesh/3D_ZS_SSL/worktrees
    artifactsDir: /data/zhanglt/3D_ZS_SSL_store/mesh/artifacts
    sessionBinding: dsh
    allowFakeTransport: false
    autoStartScheduler: false
    startupRecovery: true
    limits:
      maxTeams: 3
      maxSubagentsPerTeam: 4
      maxSubagentsTotal: 12
```

Then:

```bash
dsh --profile web-3dzssl web --port 3081 --trusted-host 210.45.71.123:23081
```

Use a distinct port and token for each profile. Do not reuse a controlDir,
worktreesDir or artifactsDir between profiles.

## What is shared

- Installed RLP skill (`~/.agents/skills/research-lifecycle-protocol`)
- DSH binary/runtime
- `/data/zhanglt/<project>_store` storage medium, but each project has its own
  store subdirectory
- The project's `AGENTS.md` and canonical RLP state (read-only to Mesh)

## What is not shared

- projects/groups/tasks/jobs DB
- model assignments
- worktrees and branches
- GPU leases
- quotas
- Web port/token

## Migration from the current single profile

The current `web` profile is already the MoSA profile. You do not need to create
`web-mosa` unless you want a clean separation. For each additional project:

1. Create `web-<slug>`.
2. Add the plugin.
3. Set `projectRoot/sourceDir/controlDir/worktreesDir/artifactsDir`.
4. Restart that profile on its own port.
5. Open its Web UI and link the project. The RLP state is auto-detected and the
   default control/worktrees/artifacts/store directories are created automatically.

No Mesh group is created by profile setup. Do not copy the canonical checkout;
use the existing repository and Mesh worktrees.
