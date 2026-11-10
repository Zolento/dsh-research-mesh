# 11 — Multi-project runtime

## Problem

v0.2.0 bound one Mesh to one checkout: `projectRoot`, `sourceDir`, `controlDir`,
`worktreesDir`, `artifactsDir` and `databasePath` were single process-wide
values, and a project counted as runnable only when its repository equalled the
configured `sourceDir`. A second repository could only be registered read-only,
so "one profile per project" was the only way to host two studies.

## Design

One Mesh supervises **one SuperAgent runtime per project**.

```
MeshService (supervisor + aggregate control plane)
├── registry store           projects, session bindings (profile level)
└── ProjectRuntime[P]        one per project
      ├── <controlDir>/runtime.sqlite     own database
      ├── worktrees/  artifacts/  manifests/  outcomes/  logs/
      ├── TaskScheduler + MeshWorker + EffectsRunner + AutonomyEngine
      ├── WorkspaceManager + TeamManager (Captain + members)
      ├── GpuLeaseManager + ExperimentJobService + RemoteJobExecutor
      ├── RlpRuntime (projectRoot = that project's sourceDir)
      └── resident control session ("项目主控"), role `control`
```

Isolation rules:

- a runtime reads and writes only its own database and directories;
- no API accepts a cross-project id: `runtime(projectId)` resolves the record and
  every operation stays inside it;
- the resident control session is recorded on the project row
  (`control_sessions_id`) and reused across restarts; it is never created twice.

## Storage

`mesh_projects` carries the project's own layout:

| Column | Meaning |
|---|---|
| `source_dir` | executable checkout (defaults to the repository itself) |
| `control_dir` | per-project control root (default `<base>/projects/<projectId>`) |
| `worktrees_dir`, `artifacts_dir` | per-project worktrees and artifact store |
| `control_session_id` | resident control session |

Existing control databases migrate additively; legacy rows keep working with
`NULL` layout columns and fall back to the derived defaults.

## Control plane

| Route | Purpose |
|---|---|
| `GET /runtimes` | per-project runtime status (database path, worker, RLP readiness, control session, ticket/job counts) |
| `POST /runtimes/control-session` | ensure the resident control session (`{ projectId }`) |
| existing `/projects`, `/groups`, `/tickets`, `/autonomy`, `/workbench` | unchanged paths, project-scoped |

## Migration from the single-project profile

1. deploy the new build (additive schema migration runs on open);
2. point the profile at a neutral base (`controlDir` only, no `projectRoot`
   requirement for each study);
3. re-register each study; a whole-repository project becomes runnable because
   its `sourceDir` is its own checkout;
4. call `POST /runtimes/control-session` once per project to materialize the
   resident control session.

## Status

Implemented and tested: per-project records and directories, `ProjectRuntime`
assembly (own store, scheduler, worker, effects, autonomy, teams, workspaces,
GPU, jobs, RLP), resident control session with reuse, `runtime()` /
`runtimes()` / `runtimeStatus()` and the two new routes.

Still on the shared path (follow-up): the legacy service methods for groups,
tickets and jobs still resolve through the profile-level managers before the
runtime; moving every one of them onto `runtime(projectId)` is the remaining
step, tracked in `docs/fusion/10-audit-fixes.md` §11.
