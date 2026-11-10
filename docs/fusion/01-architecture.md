# 01 — Unified architecture

Status: implemented on branch `feat/rlp-v2.2-fusion`.

## 1. Layers

```
DSH host (0.2.2-rc.1)
└── dsh-research-mesh (bundle, one project per profile)
    ├── src/index.ts            Cordis plugin: config, late-bound host services, HTTP, tool guard
    ├── src/service.ts          MeshService: composition root and public facade
    │   ├── ProjectRegistry         projects + session bindings
    │   ├── TeamManager/            groups, 3×4 quotas, DSH sessions
    │   │   └── DshSessionHost      SessionController / AgentRegistry / SubagentRuntime
    │   ├── WorkspaceManager        mesh/<group> worktrees + PathBoundary
    │   ├── TaskScheduler           SQLite task DAG, CAS claims, leases
    │   ├── GpuLeaseManager         per-device leases, fail-closed probes
    │   ├── ExperimentJobService    immutable manifests bound to worktree HEAD
    │   ├── RemoteJobExecutor       Fake/SSH transport, artifacts, SHA-256
    │   ├── RlpRuntime (new)        skill discovery, storage matrix, context, subagent contracts
    │   └── AutonomyEngine (new)    Trigger → Gate → Ticket/Mandate → Assignment → Effects
    ├── src/host/web-api.ts     /dsh-research-mesh/api
    └── client/client.js        main / sidebar / settings / session slots
```

## 2. What is new vs reused

| Concern | Decision |
|---|---|
| Trigger/Ticket/Mandate/Assignment | new `src/autonomy/`, persisted in the existing SQLite connection |
| Effects queue | new `src/autonomy/effects.ts`, same DB, no second scheduler |
| RLP access | new `src/rlp/`, calls RLP scripts; `src/rsi/` remains a deprecated facade |
| Team tasks, GPU, jobs, worktrees | unchanged, owned by existing modules |
| Agent Teams | native DSH sessions; Mesh adds no team framework |
| Scientific state | RLP only; Mesh reads |

## 3. Work flow

```
Source event ──► Trigger (immutable, dedupe key)
                   │
                   ├─ explicit user request ─────────────┐
                   ├─ observe mode ──► candidate (no work)│
                   └─ auto mode + rule ──► autonomous ────┤
                                                          ▼
                                              Gate (deterministic, policy)
                                                          ▼
                                          Ticket + Mandate (persistent scope)
                                                          ▼
                                          Assignment (one execution attempt)
                                                          ▼
                                Team Task (native Agent Teams) / Compute Job (Mesh)
                                                          ▼
                                     result events ──► Ticket waiting_evidence
                                                          ▼
                                   RLP outcome / evidence gates (authority)
                                                          ▼
                                     scientific decision committed by RLP
                                                          ▼
                                              Ticket ended (completed)
```

## 4. Boundaries

- **DSH** owns sessions, model routing, tools and persistence primitives.
- **Mesh** owns project registry, groups, bindings, tickets, assignments, compute
  jobs, leases, artifacts and the control surface.
- **RLP** owns hypotheses, protocols, evidence, assurance and scientific
  decisions. Mesh never writes `research-state.json`.

## 5. Public API (minimal examples)

```ts
const received = service.recordTrigger({
  source: 'user', eventId: 'msg-42', projectId, kind: 'user_request',
  explicit: true, actor: 'alice', payload: { routeId: 'A', title: 'review R8' },
});
service.assignTicket(received.ticket!.ticketId, groupId);
service.finishTicketAssignment(assignmentId, { ok: true }); // → waiting_evidence

const plan = await service.rlpContextPlan({ preset: 'research-loop' });
const packet = await service.rlpContextPacket(projectId, 'A', 'inspect');
const contract = await service.rlpSubagentContract('experiment', 'run X1');
```

## 6. Deliberate non-goals

- two schedulers, two routers, or two scientific authorities;
- Mesh-invented R0–R14 states;
- automatic legacy-root migration;
- scientific verdicts produced by an executor or an agent's own review.
