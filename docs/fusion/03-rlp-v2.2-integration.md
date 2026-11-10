# 03 — RLP v2.2.0 integration

## 1. Discovery (`src/rlp/discovery.ts`)

- Priority: explicit `rlp.skillPath` → `RLP_SKILL_PATH` → `~/.agents/skills/research-lifecycle-protocol`.
- The legacy `rsi-pipeline` install is **never** an implicit fallback; a path
  may be configured explicitly for compatibility.
- Reads `SKILL.md` frontmatter (`name`, `metadata.version`, `legacy-name`) and
  requires: `shared-contract.md`, `preset-registry.json`, `scripts/{rlp_paths,
  context_planner, context_packet, subagent_context, preset_router,
  experiment_execute, evidence_outcome, operational_reconcile}.py`,
  `schemas/execution-manifest.schema.json`, `references/subagent-context.md`.
- Records a 16-hex digest over `SKILL.md` + `shared-contract.md` +
  `preset-registry.json`.
- Fails closed: missing files → `RLP_VERSION_UNSUPPORTED`; nothing found →
  `RLP_UNAVAILABLE`.

## 2. Storage matrix (`src/rlp/paths.ts`)

`RlpStorageResolver` runs `rlp_paths.py resolve --project <root>` and normalizes:

| Status | formalRunAllowed | Mesh behavior |
|---|---|---|
| `NEW_PROJECT` | false | register/inspect only; RLP Bootstrap creates the root |
| `READY` | true | normal work |
| `MIGRATION_REQUIRED` | false | formal runs refused; audit/migration only |
| `AMBIGUOUS_STORAGE_ROOT` | false | fail closed, ask the operator |
| `INVALID_STORAGE_ROOT` | false | never rebuilt silently |

`canonicalStatePath()` prefers `.research-lifecycle-protocol/` and falls back to
the legacy root only when it is the sole root; the RLP resolver is the final
gate for every formal run.

Mesh never runs `migrate_project_root.py --apply`.

## 3. L0 / L1 / L2 context (`src/rlp/context.ts`)

```
load({ preset | entry, stage, authorization, domain })
  → context_planner.py load --json
  → { loaded:[{path, layer, chars, text}], referenced[], blocked_missing[],
      can_proceed, plan_digest, budget }
```

Rules enforced by the adapter:
- `loaded` without body text is rejected (`RLP_INVALID`);
- `referenced` paths are reported separately and never counted as loaded;
- `blocked_missing` or `can_proceed=false` → `RLP_CONTEXT_BLOCKED`;
- planner failure with no JSON → `RLP_CONTEXT_BLOCKED` with the planner's stderr;
- identical inputs produce the same `plan_digest`.

No RLP rule is re-implemented in TypeScript.

## 4. Research Context Packet

```
buildPacket({ statePath, route, task })
  → context_packet.py build --json --out <tmp>
  → context_packet.py verify --packet <tmp> --state <state>
```

- Packet must declare `is_canonical_state: false`; the adapter asserts this from
  the file itself, not just the CLI output.
- `verify` exit 4 / `stale:true` → `RLP_CONTEXT_STALE`; the packet is rebuilt
  from current state, never reused.
- `canonical_digest` is recorded; a changed state digest invalidates it.

## 5. Subagent context and permissions

```
subagent_context.py build --role <r> --task <t> --json
  → permits, parent_permits, manifest_required, approval_required,
    may_write[], text
```

- `RlpSubagentContext.assertSubset(parent, child)` rejects `modifyAnchor` (and
  any other bit) when the parent lacks it → `RLP_PERMISSION_ESCALATION`.
- The `experiment` role must report both `manifest_required` and
  `approval_required`, otherwise `RLP_GATE_HOLD`.
- Roles: `literature`, `theory`, `experiment`, `assurance`, `discovery`.
- Prompt reduction never weakens these mechanical checks.

## 6. Execution gating

- `submitExperimentTask` and `createGroup` call a synchronous layout gate:
  legacy-only → `RLP_MIGRATION_REQUIRED`; both roots → `RLP_AMBIGUOUS_STORAGE_ROOT`.
- Production execution still uses the consumed-ledger rendezvous
  (`src/rsi/consumed-run.ts`, `blocking-shim.ts`): the receipt is spent by RLP,
  Mesh verifies and launches once, and an interrupted launch becomes
  `RECONCILE_REQUIRED`, never a retry.
- `preview` remains test-only behind `rlp.allowTestStub`.

## 7. Compatibility

- `rlp` is the canonical config block; `rsi` is parsed as an alias.
- `src/rsi/adapter.ts` is deprecated but kept; `RlpAdapter` is exported as an
  alias. `DEFAULT_RSI_PATHS` now points at RLP.
- Frozen protocol ids (`research-idea-pipeline/...@1`) are preserved everywhere.

## 8. Minimal use

```ts
const status = service.rlpStatus();                 // { available, version, digest }
const storage = await service.rlpStorage();         // READY / MIGRATION_REQUIRED / ...
const plan = await service.rlpContextPlan({ preset: 'research-loop' });
const packet = await service.rlpContextPacket(projectId, 'A', 'inspect');
const role = await service.rlpSubagentContract('assurance', 'attack claim C1');
```
