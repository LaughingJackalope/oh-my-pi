# Plan: Peer Agent Orchestration (fork-first implementation)

**Source spec:** `reference/peeragentorchestration.v2.md`
**Status:** Approved — fork-first, direct invoke, guaranteed telemetry.
**Repo:** oh-my-pi fork in workspace (`reference/oh-my-pi/`).

## Architectural decisions

| Decision | Choice | Rationale |
|---|---|---|
| Deployment | Fork-first, integrate into core | Plugin surface is insufficient (no task invoke, no registry access); non-janky requires first-class support |
| Dispatch | Supervisor calls `TaskTool.execute` directly | Avoids LLM-mediated path; deterministic; zero parse failures |
| Telemetry | Always emit `usage` on lifecycle events | Core change to `agent_end`/`TASK_SUBAGENT_LIFECYCLE_CHANNEL` so no opt-in `AgentTelemetryConfig` needed |
| Durability | SQLite for Phase 2; NATS JetStream for Phase 3 | SQLite is zero-dependency and local; NATS comes when cross-host is needed |
| Snapshot cadence | Per-assignment anchor | One snapshot per completed/failed assignment; event log is source of truth between anchors |

## File touch-points (predicted)

Core change (required in Foundation):

- `packages/agent/src/types.ts` — add `usage: { totalTokens, cost }` to `agent_end` emit (always-on, not behind optional telemetry)
- `packages/agent/src/run-collector.ts` — always run the `AgentRunSummary` accumulator (currently only if config supplied)
- `packages/coding-agent/src/task/executor.ts` — after each `runSubprocess`, append a `SupervisorEvent` to a durable stream (SQLite table at v1)
- `packages/coding-agent/src/task/executor.ts` — add new public helper: `runSubprocessAsSupervisor(options): Promise<SingleResult>` that stamps caller's `agentId = correlationId`
- `registry/agent-registry.ts` — expose read-only snapshot for supervisor queries (currently only global singleton)
- `registry/agent-lifecycle.ts` — fine as-is; supervisor only reads

New files:

- `src/orchestration/supervisor.ts` — Supervisor class (work queue, in-flight map, dispatcher, snapshotting)
- `src/orchestration/supervisor-event.ts` — SupervisorEvent types + event log writer/reader
- `src/orchestration/snapshot-store.ts` — SQLite-backed snapshot read/write (Phase 2); interface for swapping to NATS KV (Phase 3)
- `src/orchestration/worker-transport.ts` — WorkerTransport interface + LocalTransport + RpcNatsTransport
- `src/orchestration/failure-policy.ts` — retry/timeout/dead-letter policies
- `src/orchestration/heartbeat-monitor.ts` — per-worker liveness tracking

## Acceptance targets

- **Smoke test:** supervisor (Main) dispatches N tasks → fan-out via `task` tool → all N workers yield → supervisor's event stream shows N `work_completed` events with `cost > 0` → snapshot written → supervisor boots (same process) → reads snapshot → recovered state matches.
- **Crash recovery:** supervisor dispatches 3 tasks → worker B dies mid-task → heartbeat-timeout fires → 'worker_timeout' event → retry policy attempts 1 retry → queue drains. After supervisor boot event log replay, worker B's assignment is still 'in-flight' or retried.
- **Cross-host smoke test (Phase 3 only):** 1 supervisor process + N `RpcClient` workers spawned on different ports (loopback) → tasks dispatched → NATS-before-worker path delivers completion → supervisor catches up after boot with only the log tail re-read.
