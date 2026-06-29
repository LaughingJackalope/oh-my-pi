# Peer Agent Orchestration v2

## Overview

Decouple work dispatch from supervisor lifetime. Workers are ephemeral processes; supervisor is a durable brain whose state survives restarts. A NATS JetStream is the shared state boundary — both sides late-joinable, neither side holds exclusive ownership of truth.

## Architecture

```
  ┌────────────────────────────────────────────────────────────┐
  │  NATS JetStream                                            │
  │  ───────────────                                           │
  │  stream TASKS.pool-{id}.dispatch     supervisor → workers  │
  │  stream TASKS.pool-{id}.completion  workers → supervisor  │
  │  stream TASKS.pool-{id}.heartbeat   workers → supervisor  │
  │  kv    supervisor.{id}.log          event-sourced op log  │
  │  kv    supervisor.{id}.snapshot     compacted state blob  │
  └────────────────────────────────────────────────────────────┘
           │                                      ▲
           │ publish                              │ subscribe from
           ▼                                      │ lastSeq(seq)  │
  ┌─────────────────┐                    │
  │   Supervisor    │                    │
  │   ─────────     │                    │
  │   read snapshot │                    │
  │   + tail log    │                    │
  │   rebuild state │                    │
  │   work queue    │────────────────────┘
  │   inFlight map  │
  │   dispatcher    │
  └────────┬────────┘
           │ fan-out (dispatch)
           │
    ┌──────┼──────┬──────────┐
    ▼      ▼      ▼          ▼
 ┌──────┐┌──────┐┌──────┐ ┌──────┐
 │ W-A  ││ W-B  ││ W-C  │ │ W-D  │
 │      ││      ││      │ │ Rpc  │
 │task  ││task  ││task  │ │client│
 │tool  ││tool  ││tool  │ │remote│
 └──────┘└──────┘└──────┘ └──────┘
  ephemeral  ephemeral   cross-host
  in-process swap-in-opt  worker
```

## Core Constraints

| Constraint | Implication |
|---|---|
| IRC is process-local gossip | IRC is optional node-local transport. Not the coordination plane. |
| Supervisor holds durable state | On restart, supervisor recovers via NATS snapshot + event log tail. |
| Workers are ephemeral | Workers can GC after `agent_end`. Only durable artifact is the completion event published to NATS. |
| Workers outlive supervisor | Completion events persist in NATS stream with explicit seq. Supervisor catches up from `lastSeenSeq` on boot. |
| AgentKind filtering | `main` + `sub` are dispatch-able; `advisor` is passive, never fanned out. |

## Work Item

Every unit of dispatched work:

```typescript
interface WorkItem {
  id: string;               // UUID, supervisor-generated
  poolId: string;
  correlationId: string;    // caller-scoped key for idempotency
  task: string;             // the prompt / input
  metadata?: Record<string, unknown>;
  dispatchedAt?: number;
  attempt: number;
  maxAttempts: number;
  status: 'queued' | 'dispatched' | 'in-flight' | 'completed' | 'failed';
}
```

## Supervisor State (event-sourced)

### Events

```typescript
type SupervisorEvent =
  | { type: 'work_dispatched'; workItemId: string; workerId: string; ts: number }
  | { type: 'work_completed';   workItemId: string; workerId: string; result: WorkerResult; ts: number }
  | { type: 'work_failed';     workItemId: string; workerId: string; error: string; ts: number }
  | { type: 'worker_timeout';  workItemId: string; workerId: string; ts: number }
  | { type: 'log_compacted';   snapshotSeq: number; finalSeq: number; ts: number };
```

### Compaction

Once the supervisor has durably processed and acknowledged a completed work item, its corresponding events are candidates for compaction:

1. Supervisor periodically (or at threshold) writes a **snapshot** to `supervisor.{id}.snapshot` KV.
2. Snapshot contains: `{lastSeq, inFlight map (only unresolved items), queue head, worker roster}`.
3. Once snapshot is acknowledged in NATS KV, events up to `snapshotSeq` are **deletable** from the stream (or the stream is configured with an age/interest policy and the snapshot is the durable source of truth).

```
       events:  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
                              ▲
                         snapshot @ 7
       rest tail ──────►[8, 9, 10]
       (kept for late-join supervisor catching up to head)
```

### Late-join recovery

```
Supervisor.start():
  1. read snapshot KV → { inFlight, queue, lastSeq, workers }
  2. subscribe to log stream starting at lastSeq+1 → tail catch-up
  3. listen for new events → steady state
  4. for each inFlight: start timeout/retry policy
  5. publish 'supervisor_ready' → workers can now send heartbeats
```

### On crash

```
Supervisor restarts (new process):
  1. same as Supervisor.start() — state is fully externalized
  2. inFlight tasks either complete (supervisor reads completion on catch-up) or timeout
  3. no silent hangs
```

## Worker Protocol

### Dispatch receive

Worker subscribes to `TASKS.pool-{id}.dispatch` (queue group for load balancing). On message:

```typescript
const dispatch = JSON.parse(msg.data) as WorkItem;
// ack immediately to avoid redelivery
msg.ack();

// do work
const result = await doWork(dispatch);

// publish completion regardless of supervisor liveness
nats.publish(`TASKS.pool-${id}.completion`, JSON.stringify({
  type: 'work_completed',
  workItemId: dispatch.id,
  workerId: selfId,
  result,
  seq: msg.seq,            // idempotency key for supervisor's dedup
}));
```

**Key**: workers publish completion even if supervisor is down. NATS retains. Supervisor reads on catch-up.

### Heartbeat

Worker publishes `TASKS.pool-{id}.heartbeat` every N seconds while in-flight. Supervisor monitors: if no heartbeat for `timeout` ms → `worker_timeout` event → retry policy applies.

### AgentEnd event

Within each worker process, the harness's standard `agent_end` event carries:

```typescript
{
  type: 'agent_end',
  messages: AgentMessage[],
  telemetry?: {          // present when AgentTelemetryConfig supplied
    usage: { inputTokens, outputTokens, totalTokens },
    cost: { estimatedUsd }
  }
}
```

**Requirement**: orchestrator should inject `AgentTelemetryConfig` into every spawned worker so telemetry is **guaranteed** — never optional at the orchestration layer.

## Registry of AgentKinds

| Kind | Liveness | Dispatch-able | Notes |
|---|---|---|---|
| `main` | persistent | yes (as supervisor) | The supervisor is a `main` with durable state |
| `sub` | persistent until parked | yes | In-process workers |
| `advisor` | persistent | no | Supervisor must filter from roster |

## Failure Matrix

| Failure | Detection | Recovery |
|---|---|---|
| Worker dies during task | child-process exit + no `agent_end` event; heartbeat loss | Supervisor marks `worker_timeout`, retries per policy |
| Supervisor dies | external process monitor | New supervisor boots, reads snapshot, tails log |
| NATS partition | connection error; workers buffer redeliveries | NATS handles; supervisors reconnect; idempotent completion via seq |
| Task permanently fails | attempt counter > maxAttempts | Emit `work_failed`; publish to dead-letter channel `TASKS.pool-{id}.letterbox` |
| Dispatch dup (NATS redelivery) | workItemId idempotency | Supervisor dedupes by id; worker re-ack but second completion is idempotent |

## Local vs RPC transport (Hybrid)

Default: **in-process** — supervisor leverages existing `task`/subagent mechanics inside one harness process. No NATS needed. RPC bridge is opt-in for cross-host.

Ideal shape: a **Transport interface** the supervisor uses:

```typescript
interface WorkerTransport {
  spawnWorker(poolId: string): Promise<WorkerHandle>;
  dispatch(handle: WorkerHandle, work: WorkItem): Promise<void>;
  onCompletion(handler: (event: CompletionEvent) => void): void;
  onWorkerExit(handler: (workerId: string) => void): void;
  teardown(): Promise<void>;
}
```

Two implementations:
- `LocalTransport` — uses `task` tool, IPC, registry events
- `RpcNatsTransport` — `RpcClient` child process + NATS channels

Same failure matrix, same supervisor-facing contract.

## Codebase Integration Points (oh-my-pi)

LocalTransport maps onto real, existing harness APIs — no new infra required for single-host orchestration.

### APIs the supervisor calls

| Capability | Source | Notes |
|---|---|---|
| fan-out dispatch | `TaskTool.execute(...)` | Batch mode (`tasks[]`) for N-at-once; semaphore-bounded via `task.maxConcurrency` setting |
| result tracking | `SingleResult` returned per subagent | Carries `{exitCode, tokens, usage.cost.total, durationMs, error, aborted, retryFailure}` |
| lifecycle notifications | `eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {...})` | `status: 'started' \| 'completed' \| 'failed' \| 'aborted'` per subagent |
| session-level subscribe | `AgentSession.subscribe(listener)` | Superset: `AgentEvent` + compaction + retry + todo + irc frames |
| worker roster | `AgentRegistry.global()` | All agents in the process; `AgentRef.kind` for advisor filtering (`advisor` is non-dispatch-able) |
| worker lifetime | `AgentLifecycleManager.global()` | Idle park / TTL / revive; keep-alive subagents survive task completion |
| inter-process RPC | `RpcClient` class (from `@oh-my-pi/pi-coding-agent/modes/rpc`) | Spawns child process, exposes `onEvent()`/`onSessionEvent()` listeners, `prompt()`/`waitForIdle()` |

### Mapping LocalTransport to real flows

```
Supervisor calls:
  SessionManager → createAgentSession(options) → AgentSession
  → session.prompt(task, { attribution: "agent" })
  → AgentSession.waitForIdle()

Subagent lifecycle:
  AgentSession → runSubprocess(options) → driveSessionToYield()
  → on yield: finalizeRunResult() → emit TASK_SUBAGENT_LIFECYCLE_CHANNEL 'completed'
  → AgentSession.subscribe(listener) delivers `agent_end` + all events
```

### Correlation tracking gap (LocalTransport)

The lifecycle emit carries the subagent `id` (generated UUID), **not** the caller's `correlationId`. LocalTransport **must** maintain its own `correlationId → agentId` map. Map is in-memory only — LocalTransport is irrecoverable on supervisor crash (acceptable for single-host v1; NATS path fixes this).

### Built-in SingleResult fields → SupervisorEvent mapping

```
SingleResult                           SupervisorEvent
────────────                           ───────────────
exitCode === 0                 →  'work_completed' or 'work_failed'
usage.cost.total               →  result.cost
tokens + durationMs            →  result.tokens / result.durationMs
aborted === true               →  'work_failed' with result.abortReason
retryFailure !== undefined     →  'work_failed' with retryFailure.errorMessage
error !== undefined            →  'work_failed' with error
```

### Snapshot cadence: per-assignment anchor

Snapshot is written **once per processed assignment** (after the supervisor has durably recorded a `work_completed` or `work_failed` and the worker's result is fully integrated). Cadence targets:

- **Per-assignment**: one snapshot per completed/failed assignment. Keeps snapshot cheap; event log is source of truth between snapshots.
- **On growth trigger**: if `completedSinceSnapshot > threshold` AND idle time exists, snapshot proactively to bound replay length.
- **On shutdown**: supervisor always writes a final snapshot on graceful shutdown.

Example:

```
Assignments:     [A1]  [A2]  [A3]  [A4]  [A5]  [A6]
                   ▼     ▼     ▼     ▼     ▼     ▼
Snapshots:      @A2         @A4                 @A6
                   ▲           ▲                 ▲
             2 completed   2 more completed    idle trigger
```

This keeps the event log compact (snapshots chunk naturally with assignment rhythm), and on restart the supervisor replays only the tail of unanchor'd assignments — bounded and predictable.

### What LocalTransport does NOT get (by design)

- **Durable queue**: supervisor crash loses in-flight state. Phase 2+ adds that.
- **Cross-host**: Phase 3+ with `RpcNatsTransport`.
- **Heartbeat from workers**: not needed in-process — `AgentSession.subscribe` gives direct lifecycle events with zero wire cost.
- **Separate cost infrastructure**: `SingleResult.usage.cost.total` already carries per-task cost; supervisor sums.

### RpcClient as remote worker (RpcNatsTransport)

`RpcClient` from `modes/rpc/rpc-client.ts`:
- Constructed with `{ cwd, sessionDir }` — sessionDir is isolated per worker
- `start()` spawns a child process (`bun dist/cli.js --mode rpc`)
- `prompt(message)` dispatches non-blocking
- `onEvent(listener)` fires `AgentEvent` frames including `agent_end`
- `onSessionEvent(listener)` fires the superset `AgentSessionEvent`
- `waitForIdle()` resolves on `agent_end`

Each `RpcClient` is a separate OS process; one NATS subscription per worker maps 1:1. Worker death = child process exits + `agent_end` never fires → heartbeat-timeout path kicks in.

## Sequencing / Implementation Phases

1. **Phase 0 — foundation** — `WorkItem` schema, `SupervisorEvent` types, `WorkerTransport` interface. Pure types, no runtime.
2. **Phase 1 — LocalTransport** — supervisor + in-process subagent fan-out via `TaskTool`. Irrecoverable (supervisor down = all down), but fully functional. Verifies the dispatch/completion contract against real harness APIs (`AgentSession.subscribe`, `eventBus`, `SingleResult`).
3. **Phase 2 — event sourcing** — supervisor checkpoint + log compaction. In-process, but durable if supervisor restarts (snapshots to SQLite as stand-in for NATS KV initially).
4. **Phase 3 — NATS transport** — JetStream + KV. Workers publish completions durable. `RpcNatsTransport`. Cross-host. Worker death / supervisor crash now recoverable.
5. **Phase 4 — production hardening** — heartbeat, timeout, retry back-off, dead-letter channel, observability, pool scaling.

## Out of Scope (v2)

- Worker-to-worker direct communication (hub-and-spoke only)
- Recursive sub-orchestration (workers that dispatch sub-tasks)
- Dynamic supervisor pool (multiple supervisors for one pool — v3)
- Streaming partial results mid-task (future: progressive completion events)
- Security / authN on work items (v2 assumes trusted network)
- API surface for external callers to submit work items (future: job gateway)
